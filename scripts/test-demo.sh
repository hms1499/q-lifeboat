#!/usr/bin/env bash
# Offline test of demo.sh's orchestration: a stub `pnpm` on PATH stands in for every CLI and agent step, so
# nothing touches the chain, the network or ~/.config. Covers the pass path (--runs 2), a step failure that
# stops --runs, the agent dying before "watching", no incident, a fresh-owner failure (temp file cleanup), the
# FUNDER_MNEMONIC export and the agent process-group kill.
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
echo "[stub] $what FUNDER=[${FUNDER_MNEMONIC-unset}] OWNER=[${OWNER_MNEMONIC-unset}] RELAYER=[${RELAYER_MNEMONIC-unset}]" >&2
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
    printf 'RUN_ID="%s"\nOWNER_MNEMONIC="fresh owner words"\nSAFE_ADDR="0x5afe"\nRUN_COMPLETE="1"\n' "$id" >"$W/runs/$id/run.env"
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

echo "FUNDER_MNEMONIC from .env wins over OWNER_MNEMONIC"
printf 'OWNER_MNEMONIC="root owner words"\nFUNDER_MNEMONIC="funder words"\nGUARDIAN_ADDRESS="0x1"\n' >"$WORK/.env"
run_demo funder --
expect "attack sees FUNDER_MNEMONIC = funder" has funder '\[stub\] cli:attack FUNDER=\[funder words\]'

echo
echo "demo.sh harness: $PASSED passed, $FAILED failed"
[[ "$FAILED" -eq 0 ]]
