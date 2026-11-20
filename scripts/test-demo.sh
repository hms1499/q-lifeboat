#!/usr/bin/env bash
# Offline test of demo.sh's orchestration: a stub `pnpm` on PATH stands in for every CLI and agent step, so
# nothing touches the chain, the network or ~/.config. Covers the pass path (--runs 2), a step failure that
# stops --runs, the agent dying before "watching", no incident, a fresh-owner failure (temp file cleanup), the
# FUNDER_MNEMONIC export, the agent process-group kill, and --resume (skips fresh-owner; refuses an incomplete
# run.env, a run.env without the per-run AGENT_ED25519_SK, a missing file and --runs > 1).
#
#   bash scripts/test-demo.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/bin" "$WORK/runs" "$WORK/tmp"
cp "$ROOT/demo.sh" "$WORK/demo.sh"
# Fake values only (never real keys).
printf 'OWNER_MNEMONIC="root owner words"\nGUARDIAN_ADDRESS="0x1"\n' >"$WORK/.env"

cat >"$WORK/bin/pnpm" <<'STUB'
#!/usr/bin/env bash
# Stub pnpm. FAKE_FAIL=<step> makes that step exit 1 (steps: cli:fresh-owner, cli:setup, agent, cli:attack,
# cli:demo-check:wait, cli:sign-withdraw, cli:withdraw, cli:demo-check).
W="$(cd "$(dirname "$0")/.." && pwd)"
[[ "$1" == "-s" ]] && shift
what="$1"
shift
[[ "$what" == cli ]] && { what="cli:$1"; shift; }
[[ "$what" == cli:demo-check && "${1:-}" == --wait ]] && what="cli:demo-check:wait"
echo "[stub] $what FUNDER=[${FUNDER_MNEMONIC-unset}] OWNER=[${OWNER_MNEMONIC-unset}] RELAYER=[${RELAYER_MNEMONIC-unset}] AGENT_SK=[${AGENT_ED25519_SK:+set}]" >&2
# demo.sh's fresh-owner temp file must exist under TMPDIR while fresh-owner runs.
[[ "$what" == cli:fresh-owner ]] && ls "${TMPDIR:-/nonexistent}" >>"$W/tmp.log" 2>/dev/null
if [[ "${FAKE_FAIL:-}" == "$what" ]]; then
  echo "[stub] $what fails" >&2
  exit 1
fi
case "$what" in
  cli:fresh-owner)
    id="r$$"
    mkdir -p "$W/runs/$id"
    printf 'RUN_ID="%s"\nOWNER_MNEMONIC="fresh owner words"\nAGENT_ED25519_SK="%s"\nSAFE_ADDR="0x5afe"\nRUN_COMPLETE="1"\n' "$id" "$(printf 'a%.0s' $(seq 64))" >"$W/runs/$id/run.env"
    echo "RUN_ENV=$W/runs/$id/run.env"
    ;;
  agent)
    sleep 300 &
    echo $! >"$W/agent-child.pid"
    echo "guardian 0xg watching 0xfresh"
    trap 'exit 0' TERM
    while true; do sleep 1; done
    ;;
  *) echo "ok" ;;
esac
STUB
chmod +x "$WORK/bin/pnpm"

PASSED=0
FAILED=0
ok() { PASSED=$((PASSED + 1)); echo "  ok   $*"; }
bad() { FAILED=$((FAILED + 1)); echo "  FAIL $*"; }
expect() { # expect <description> <command...>
  local what="$1"
  shift
  if "$@"; then ok "$what"; else bad "$what"; fi
}

# run_demo <name> <env assignments...> -- <demo args...>: runs demo.sh, stores output in $WORK/<name>.out, exit in RC.
run_demo() {
  local name="$1"
  shift
  local envs=()
  while [[ "$1" != "--" ]]; do envs+=("$1"); shift; done
  shift
  rm -f "$WORK/agent-child.pid"
  set +e
  (cd "$WORK" && env PATH="$WORK/bin:$PATH" TMPDIR="$WORK/tmp" ${envs[@]+"${envs[@]}"} bash ./demo.sh "$@") >"$WORK/$name.out" 2>&1
  RC=$?
  set -e
}
has() { grep -q -- "$2" "$WORK/$1.out"; }
count() { grep -c -- "$2" "$WORK/$1.out" || true; }
agent_killed() {
  [[ -f "$WORK/agent-child.pid" ]] || return 0
  sleep 0.3
  ! kill -0 "$(cat "$WORK/agent-child.pid")" 2>/dev/null
}
tmp_clean() { [[ -z "$(ls -A "$WORK/tmp")" ]]; }
tmp_used() { grep -q "qday-fresh" "$WORK/tmp.log"; }

echo "pass path (--runs 2)"
run_demo pass -- --runs 2
expect "exit 0" test "$RC" -eq 0
expect "two runs, each PASS" test "$(count pass '^PASS: run ')" -eq 2
expect "final PASS: 2/2 runs" has pass '^PASS: 2/2 runs'
expect "every step ran, recovery before the verdict" has pass '\[stub\] cli:withdraw'
expect "attack sees FUNDER_MNEMONIC = root owner, OWNER_MNEMONIC = fresh owner" has pass '\[stub\] cli:attack FUNDER=\[root owner words\] OWNER=\[fresh owner words\]'
expect "recovery withdraw has RELAYER_MNEMONIC set but empty" has pass '\[stub\] cli:withdraw .*RELAYER=\[\]'
expect "agent process group killed" agent_killed
expect "fresh-owner temp file was created under TMPDIR" tmp_used
expect "fresh-owner temp file removed" tmp_clean

echo "step failure stops --runs (attack fails in run 1 of 3)"
run_demo stepfail FAKE_FAIL=cli:attack -- --runs 3
expect "exit 1" test "$RC" -eq 1
expect "only run 1 started" test "$(count stepfail '^=== demo run')" -eq 1
expect "FAIL: run 1/3 failed; stopping" has stepfail '^FAIL: run 1/3 failed; stopping'
expect "per-run FAIL line with the exit code" has stepfail '^FAIL: run r[0-9]* stopped (exit 1)'
expect "agent process group killed" agent_killed

echo "agent dies before watching"
run_demo agentdies FAKE_FAIL=agent --
expect "exit 1" test "$RC" -eq 1
expect "says the agent exited" has agentdies 'the agent exited before watching'
expect "attack never ran" bash -c "! grep -q 'stub\] cli:attack' '$WORK/agentdies.out'"

echo "no incident"
run_demo noincident FAKE_FAIL=cli:demo-check:wait --
expect "exit 1" test "$RC" -eq 1
expect "recovery never ran" bash -c "! grep -q 'stub\] cli:sign-withdraw' '$WORK/noincident.out'"
expect "prints the agent log tail" has noincident '^--- agent log (last 20 lines)'
expect "agent process group killed" agent_killed

echo "verdict fails"
run_demo verdict FAKE_FAIL=cli:demo-check --
expect "exit 1" test "$RC" -eq 1
expect "FAIL: run <id>" has verdict '^FAIL: run r[0-9]*$'

echo "fresh-owner fails"
: >"$WORK/tmp.log"
run_demo freshfail FAKE_FAIL=cli:fresh-owner --
expect "exit 1" test "$RC" -eq 1
expect "fresh-owner temp file was created under TMPDIR" tmp_used
expect "fresh-owner temp file removed" tmp_clean

no_stub_calls() { ! grep -q '\[stub\]' "$WORK/$1.out"; }
mkdir -p "$WORK/re sumed" "$WORK/partial"
FAKE_SK="$(printf '7%.0s' $(seq 64))" # a fake 64-hex agent key
printf 'RUN_ID="rres"\nOWNER_MNEMONIC="resumed owner words"\nAGENT_ED25519_SK="%s"\nSAFE_ADDR="0x5afe"\nRUN_COMPLETE="1"\n' "$FAKE_SK" >"$WORK/re sumed/run.env"
mkdir -p "$WORK/nokey"
printf 'RUN_ID="rold"\nOWNER_MNEMONIC="nokey owner words"\nSAFE_ADDR="0x5afe"\nRUN_COMPLETE="1"\n' >"$WORK/nokey/run.env"
printf 'RUN_ID="rpart"\nOWNER_MNEMONIC="partial owner words"\nRUN_COMPLETE="0"\n' >"$WORK/partial/run.env"

echo "--resume a complete run (path with a space)"
run_demo resume -- --resume "$WORK/re sumed/run.env"
expect "exit 0" test "$RC" -eq 0
expect "fresh-owner skipped" bash -c "! grep -q 'stub\] cli:fresh-owner' '$WORK/resume.out'"
expect "setup runs as the resumed owner, FUNDER = root owner" has resume '\[stub\] cli:setup FUNDER=\[root owner words\] OWNER=\[resumed owner words\]'
expect "attack, recovery and verdict still run" has resume '\[stub\] cli:withdraw'
expect "PASS: run rres, PASS: 1/1 runs" bash -c "grep -q '^PASS: run rres$' '$WORK/resume.out' && grep -q '^PASS: 1/1 runs' '$WORK/resume.out'"
expect "agent log in the resumed run dir" test -f "$WORK/re sumed/agent.log"
expect "agent process group killed" agent_killed

echo "--resume refusals"
run_demo incomplete -- --resume "$WORK/partial/run.env"
expect "incomplete run.env (RUN_COMPLETE=0): exit 2" test "$RC" -eq 2
expect "says it is not a complete run" has incomplete 'not a complete run'
expect "nothing ran" no_stub_calls incomplete
run_demo nokey -- --resume "$WORK/nokey/run.env"
expect "complete run.env without AGENT_ED25519_SK: exit 2" test "$RC" -eq 2
expect "says why (an agent key binds to one account)" has nokey 'no AGENT_ED25519_SK.*bound to ONE account'
expect "nothing ran" no_stub_calls nokey
expect "prints no secret" bash -c "! grep -q 'nokey owner words' '$WORK/nokey.out'"
expect "resumed run passes the per-run agent key to setup" has resume '\[stub\] cli:setup .*AGENT_SK=\[set\]'
run_demo resumeruns -- --resume "$WORK/re sumed/run.env" --runs 2
expect "--resume with --runs 2: exit 2" test "$RC" -eq 2
expect "says a resumed run is a single run" has resumeruns 'refusing --resume with --runs 2'
expect "nothing ran" no_stub_calls resumeruns
run_demo runsresume -- --runs 3 --resume "$WORK/re sumed/run.env"
expect "--runs 3 before --resume: exit 2" test "$RC" -eq 2
run_demo missing -- --resume "$WORK/nope/run.env"
expect "missing run.env: exit 2, nothing ran" bash -c "[ $RC -eq 2 ] && ! grep -q 'stub\]' '$WORK/missing.out'"

echo "FUNDER_MNEMONIC from .env wins over OWNER_MNEMONIC"
printf 'OWNER_MNEMONIC="root owner words"\nFUNDER_MNEMONIC="funder words"\nGUARDIAN_ADDRESS="0x1"\n' >"$WORK/.env"
run_demo funder --
expect "attack sees FUNDER_MNEMONIC = funder" has funder '\[stub\] cli:attack FUNDER=\[funder words\]'

echo
echo "demo.sh harness: $PASSED passed, $FAILED failed"
[[ "$FAILED" -eq 0 ]]
