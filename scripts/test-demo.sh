#!/usr/bin/env bash
# Offline test of demo.sh's orchestration: a stub `pnpm` on PATH stands in for every CLI and agent step, so
# nothing touches the chain, the network or ~/.config. Covers the pass path (--runs 2), a step failure that
# stops --runs, the agent dying before "watching", no incident, a fresh-owner failure (temp file cleanup), the
# FUNDER_MNEMONIC export, the agent process-group kill, --resume (skips fresh-owner; refuses an incomplete
# run.env, a run.env without the per-run AGENT_ED25519_SK, a missing file and --runs > 1), the final
# `demo-check --out <run dir>/verdict.json`, and --drill (the drill guardian, its own agent port and incidents
# file, no alerts, FUNDER_MNEMONIC only, `drill-guardian check` before fresh-owner, the drill lock; refuses a missing
# or bad drill guardian file, a port clash with the main agent, a busy drill port, a missing FUNDER_MNEMONIC, a held
# lock, and ignores a QDAY_DRILL_GUARDIAN_FILE set in .env). HOME is the temp dir, so ~/.config/qday is too.
#
#   bash scripts/test-demo.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
LISTENER=""
trap '[[ -n "$LISTENER" ]] && kill "$LISTENER" 2>/dev/null; rm -rf "$WORK"' EXIT

mkdir -p "$WORK/bin" "$WORK/runs" "$WORK/tmp"
cp "$ROOT/demo.sh" "$WORK/demo.sh"
# Fake values only (never real keys).
printf 'OWNER_MNEMONIC="root owner words"\nGUARDIAN_ADDRESS="0x1"\n' >"$WORK/.env"

cat >"$WORK/bin/pnpm" <<'STUB'
#!/usr/bin/env bash
# Stub pnpm. FAKE_FAIL=<step> makes that step exit 1 (steps: cli:drill-guardian, cli:fresh-owner, cli:setup, agent,
# cli:attack, cli:demo-check:wait, cli:sign-withdraw, cli:withdraw, cli:demo-check).
W="$(cd "$(dirname "$0")/.." && pwd)"
[[ "$1" == "-s" ]] && shift
what="$1"
shift
[[ "$what" == cli ]] && { what="cli:$1"; shift; }
[[ "$what" == cli:demo-check && "${1:-}" == --wait ]] && what="cli:demo-check:wait"
line="[stub] $what FUNDER=[${FUNDER_MNEMONIC-unset}] OWNER=[${OWNER_MNEMONIC-unset}] RELAYER=[${RELAYER_MNEMONIC-unset}] AGENT_SK=[${AGENT_ED25519_SK:+set}]"
line+=" GAS=[${GAS_MNEMONIC-unset}] GUARDIAN=[${GUARDIAN_ADDRESS-unset}] PORT=[${AGENT_PORT-unset}] INCIDENTS=[${INCIDENTS_FILE-unset}]"
line+=" DRILL=[${DRILL-unset}] DRILL_GAS=[${DRILL_GAS_MNEMONIC-unset}] TG=[${TELEGRAM_BOT_TOKEN-unset}|${TELEGRAM_CHAT_ID-unset}|${ALERT_WEBHOOK_URL-unset}]"
line+=" LOCK=[$(cat "$HOME/.config/qday/drill.lock/pid" 2>/dev/null || echo none)] ARGS=[$*]"
echo "$line" >&2
# The agent's output goes to its log in the run dir: keep a copy of what it was started with.
[[ "$what" == agent ]] && echo "$line" >"$W/agent-env.txt"
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
  rm -f "$WORK/agent-child.pid" "$WORK/agent-env.txt"
  set +e
  (cd "$WORK" && env PATH="$WORK/bin:$PATH" TMPDIR="$WORK/tmp" HOME="$WORK" ${envs[@]+"${envs[@]}"} bash ./demo.sh "$@") >"$WORK/$name.out" 2>&1
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
expect "the final demo-check writes <run dir>/verdict.json" has pass '\[stub\] cli:demo-check .*ARGS=\[--out .*/runs/r[0-9]*/verdict\.json\]$'
expect "demo-check --wait gets no --out" bash -c "! grep -q 'cli:demo-check:wait .*--out' '$WORK/pass.out'"
expect "the verdict line shows the agent log home-relative (~/...)" has pass '^--- verdict (run r[0-9]*, agent log ~/runs/r[0-9]*/agent\.log)$'
expect "a plain demo takes no drill lock and runs no drill-guardian check" bash -c "grep -q 'cli:fresh-owner .*LOCK=\[none\]' '$WORK/pass.out' && ! grep -q 'stub\] cli:drill-guardian' '$WORK/pass.out'"

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
FAKE_VAULT="0x$(printf 'a%.0s' $(seq 40))" # a fake vault address
printf 'RUN_ID="rres"\nOWNER_MNEMONIC="resumed owner words"\nAGENT_ED25519_SK="%s"\nVAULT_ADDRESS="%s"\nSAFE_ADDR="0x5afe"\nRUN_COMPLETE="1"\n' "$FAKE_SK" "$FAKE_VAULT" >"$WORK/re sumed/run.env"
mkdir -p "$WORK/nokey"
printf 'RUN_ID="rold"\nOWNER_MNEMONIC="nokey owner words"\nVAULT_ADDRESS="%s"\nSAFE_ADDR="0x5afe"\nRUN_COMPLETE="1"\n' "$FAKE_VAULT" >"$WORK/nokey/run.env"
mkdir -p "$WORK/novault"
printf 'RUN_ID="rnov"\nOWNER_MNEMONIC="novault owner words"\nAGENT_ED25519_SK="%s"\nSAFE_ADDR="0x5afe"\nRUN_COMPLETE="1"\n' "$FAKE_SK" >"$WORK/novault/run.env"
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
run_demo novault -- --resume "$WORK/novault/run.env"
expect "complete run.env without VAULT_ADDRESS (--no-vault): exit 2" test "$RC" -eq 2
expect "says it has no VAULT_ADDRESS and points to the Protect screen" has novault "refusing --resume: .*run.env has no VAULT_ADDRESS (a --no-vault run is onboarded from the dashboard's Protect screen)"
expect "nothing ran" no_stub_calls novault
expect "prints no secret" bash -c "! grep -q 'novault owner words' '$WORK/novault.out'"
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

agent_env_has() { grep -q -- "$1" "$WORK/agent-env.txt"; }
stage_lines() { # stage_lines <name> <runs>: the stage lines Task 3's drill runner parses, in order and unchanged
  local got want="" i
  got="$(grep '^--- ' "$WORK/$1.out" | sed 's/^--- verdict (run r[0-9]*, agent log .*)$/--- verdict (run <id>, agent log <log>)/')"
  for ((i = 0; i < $2; i++)); do
    want+=$'--- fresh owner\n--- setup\n--- agent\n--- attack\n--- incident\n--- recovery\n--- verdict (run <id>, agent log <log>)\n'
  done
  [[ "$got" == "${want%$'\n'}" ]]
}
printf 'OWNER_MNEMONIC="root owner words"\nFUNDER_MNEMONIC="funder words"\nGAS_MNEMONIC="root guardian words"\nGUARDIAN_ADDRESS="0x1"\nAGENT_PORT=\nTELEGRAM_BOT_TOKEN="1:fake"\nTELEGRAM_CHAT_ID="42"\nALERT_WEBHOOK_URL="http://127.0.0.1:9/hook"\n' >"$WORK/.env"
DRILL_ADDR="0x$(printf 'd%.0s' $(seq 40))" # a fake drill guardian address
printf 'DRILL_GAS_MNEMONIC="drill guardian words"\nDRILL_GUARDIAN_ADDRESS="%s"\n' "$DRILL_ADDR" >"$WORK/drill-guardian.env"
DG="QDAY_DRILL_GUARDIAN_FILE=$WORK/drill-guardian.env"

echo "without --drill (root guardian, port and alerts unchanged)"
run_demo nodrill "$DG" --
expect "exit 0" test "$RC" -eq 0
expect "agent sees the root GAS_MNEMONIC and GUARDIAN_ADDRESS" agent_env_has 'GAS=\[root guardian words\] GUARDIAN=\[0x1\]'
expect "agent sees the root (empty) AGENT_PORT, no INCIDENTS_FILE, no DRILL" agent_env_has 'PORT=\[\] INCIDENTS=\[unset\] DRILL=\[unset\]'
expect "alerts left as the root .env has them" agent_env_has 'TG=\[1:fake|42|http://127.0.0.1:9/hook\]'

echo "--drill --runs 2 (DRILL_AGENT_PORT set but empty)"
run_demo drill "$DG" DRILL_AGENT_PORT= -- --drill --runs 2
expect "exit 0" test "$RC" -eq 0
expect "two runs, each PASS" test "$(count drill '^PASS: run ')" -eq 2
expect "final PASS: 2/2 runs" has drill '^PASS: 2/2 runs'
expect "every run is a drill: setup sees the drill guardian" test "$(count drill '\[stub\] cli:setup .*GAS=\[drill guardian words\] GUARDIAN=\['"$DRILL_ADDR"'\]')" -eq 2
expect "fresh-owner deploys the vault for the drill guardian" has drill '\[stub\] cli:fresh-owner .*GUARDIAN=\['"$DRILL_ADDR"'\]'
expect "agent sees the drill guardian as GAS_MNEMONIC / GUARDIAN_ADDRESS" agent_env_has 'GAS=\[drill guardian words\] GUARDIAN=\['"$DRILL_ADDR"'\]'
expect "agent on port 8788 with DRILL=1" agent_env_has 'PORT=\[8788\] .*DRILL=\[1\]'
expect "agent writes incidents to <run dir>/incidents.jsonl" agent_env_has "INCIDENTS=\[$WORK/runs/r[0-9]*/incidents\.jsonl\]"
expect "Telegram and webhook reach the agent set but empty" agent_env_has 'TG=\[||\]'
expect "demo-check reads the drill agent's port" has drill '\[stub\] cli:demo-check:wait .*PORT=\[8788\]'
expect "the final demo-check writes <run dir>/verdict.json, with DRILL=1" has drill '\[stub\] cli:demo-check .*DRILL=\[1\] .*ARGS=\[--out .*/runs/r[0-9]*/verdict\.json\]$'
expect "the drill guardian file's DRILL_GAS_MNEMONIC is not exported as such" agent_env_has 'DRILL_GAS=\[unset\]'
expect "stage lines unchanged, once per run" stage_lines drill 2
expect "agent process group killed" agent_killed
expect "fresh-owner is funded by FUNDER_MNEMONIC, never the root owner" test "$(count drill '\[stub\] cli:fresh-owner FUNDER=\[funder words\]')" -eq 2
expect "drill-guardian check runs right before fresh-owner, once per run" test "$(grep -o '\[stub\] cli:[a-z-]*' "$WORK/drill.out" | grep -A1 -c 'cli:drill-guardian$' || true)" -eq 2
expect "...with ARGS=[check], as the drill guardian" has drill '\[stub\] cli:drill-guardian .*GUARDIAN=\['"$DRILL_ADDR"'\] .*ARGS=\[check\]$'
check_then_fresh() { [[ "$(grep -o '\[stub\] cli:[a-z-]*' "$WORK/drill.out" | sed -n '1p;2p' | tr '\n' ' ')" == "[stub] cli:drill-guardian [stub] cli:fresh-owner " ]]; }
expect "...and the first call of the drill is the check" check_then_fresh
expect "the drill holds the lock while it runs (pid inside)" has drill '\[stub\] cli:fresh-owner .*LOCK=\[[0-9][0-9]*\]'
expect "the lock is released after the drill" test ! -e "$WORK/.config/qday/drill.lock"

echo "--drill with DRILL_AGENT_PORT=9001"
run_demo drillport "$DG" DRILL_AGENT_PORT=9001 -- --drill
expect "exit 0, agent on :9001" bash -c "[ $RC -eq 0 ] && grep -q 'PORT=\[9001\]' '$WORK/agent-env.txt'"

echo "--drill refusals"
run_demo drillcheckfail "$DG" FAKE_FAIL=cli:drill-guardian -- --drill
expect "drill-guardian check fails (dry drill guardian): run fails" test "$RC" -eq 1
expect "fresh-owner never ran (the funder paid nothing)" bash -c "! grep -q 'stub\] cli:fresh-owner' '$WORK/drillcheckfail.out'"
expect "FAIL: run 1/1 failed; stopping" has drillcheckfail '^FAIL: run 1/1 failed; stopping'
expect "the lock is released after a failed drill" test ! -e "$WORK/.config/qday/drill.lock"
run_demo drillnofile QDAY_DRILL_GUARDIAN_FILE="$WORK/nope/drill-guardian.env" -- --drill
expect "no drill guardian file: exit 2" test "$RC" -eq 2
expect "says to run drill-guardian init" has drillnofile 'refusing --drill: .*pnpm cli drill-guardian init'
expect "nothing ran (no fresh-owner)" no_stub_calls drillnofile
run_demo drillclash "$DG" DRILL_AGENT_PORT=8787 -- --drill
expect "DRILL_AGENT_PORT=8787 (the main agent's default port): exit 2" test "$RC" -eq 2
expect "says the port is the main agent's" has drillclash "refusing --drill: DRILL_AGENT_PORT 8787 is the main agent's port"
expect "nothing ran" no_stub_calls drillclash
run_demo drillbadport "$DG" DRILL_AGENT_PORT=88x -- --drill
expect "a non-numeric DRILL_AGENT_PORT: exit 2, nothing ran" bash -c "[ $RC -eq 2 ] && ! grep -q 'stub\]' '$WORK/drillbadport.out'"
expect "says DRILL_AGENT_PORT must be a port" has drillbadport 'refusing --drill: DRILL_AGENT_PORT must be a port number'
run_demo drillresume "$DG" -- --drill --resume "$WORK/re sumed/run.env"
expect "--drill with --resume: exit 2" test "$RC" -eq 2
expect "says a drill always starts from a fresh owner" has drillresume 'refusing --drill with --resume'
expect "nothing ran" no_stub_calls drillresume
run_demo resumedrill "$DG" -- --resume "$WORK/re sumed/run.env" --drill
expect "--resume before --drill: exit 2, same refusal" bash -c "[ $RC -eq 2 ] && grep -q 'refusing --drill with --resume' '$WORK/resumedrill.out'"
printf 'DRILL_GAS_MNEMONIC="drill guardian words"\n' >"$WORK/drill-noaddr.env"
run_demo drillnoaddr QDAY_DRILL_GUARDIAN_FILE="$WORK/drill-noaddr.env" -- --drill
expect "drill guardian file without DRILL_GUARDIAN_ADDRESS: exit 2, nothing ran" bash -c "[ $RC -eq 2 ] && ! grep -q 'stub\]' '$WORK/drillnoaddr.out'"
expect "says the file lacks the drill guardian" has drillnoaddr 'refusing --drill: .*drill-noaddr.env has no DRILL_GAS_MNEMONIC or DRILL_GUARDIAN_ADDRESS'
expect "prints no secret" bash -c "! grep -q 'drill guardian words' '$WORK/drillnoaddr.out'"
printf 'OWNER_MNEMONIC="root owner words"\nFUNDER_MNEMONIC="funder words"\nGUARDIAN_ADDRESS="0x%s"\n' "$(printf 'D%.0s' $(seq 40))" >"$WORK/.env"
run_demo drillsame "$DG" -- --drill
expect "drill guardian = the root GUARDIAN_ADDRESS (any case): exit 2, nothing ran" bash -c "[ $RC -eq 2 ] && ! grep -q 'stub\]' '$WORK/drillsame.out'"
expect "says it is the main guardian" has drillsame "refusing --drill: the drill guardian $DRILL_ADDR is the main guardian"
expect "prints no secret" bash -c "! grep -q 'drill guardian words' '$WORK/drillsame.out'"
printf 'OWNER_MNEMONIC="root owner words"\nFUNDER_MNEMONIC="funder words"\nGUARDIAN_ADDRESS="0x1"\nAGENT_PORT="9000"\nDRILL_AGENT_PORT="9000"\n' >"$WORK/.env"
run_demo drillclash2 "$DG" -- --drill
expect "DRILL_AGENT_PORT = the root .env's AGENT_PORT: exit 2, nothing ran" bash -c "[ $RC -eq 2 ] && ! grep -q 'stub\]' '$WORK/drillclash2.out'"
expect "says 9000 is the main agent's port" has drillclash2 "refusing --drill: DRILL_AGENT_PORT 9000 is the main agent's port"

printf 'OWNER_MNEMONIC="root owner words"\nGUARDIAN_ADDRESS="0x1"\n' >"$WORK/.env"
run_demo drillnofunder "$DG" -- --drill
expect "--drill without FUNDER_MNEMONIC in .env: exit 2, nothing ran" bash -c "[ $RC -eq 2 ] && ! grep -q 'stub\]' '$WORK/drillnofunder.out'"
expect "says a drill needs FUNDER_MNEMONIC, never the owner" has drillnofunder 'refusing --drill: no FUNDER_MNEMONIC in the root .env'
expect "prints no secret" bash -c "! grep -q 'root owner words' '$WORK/drillnofunder.out'"
run_demo drillnofunderonce "$DG" -- --once --drill
expect "...also in a single --once run: exit 2, nothing ran" bash -c "[ $RC -eq 2 ] && ! grep -q 'stub\]' '$WORK/drillnofunderonce.out'"

printf 'OWNER_MNEMONIC="root owner words"\nFUNDER_MNEMONIC="funder words"\nGUARDIAN_ADDRESS="0x1"\n' >"$WORK/.env"
echo "--drill lock"
mkdir -p "$WORK/.config/qday/drill.lock"
sleep 60 &
HOLDER=$!
echo "$HOLDER" >"$WORK/.config/qday/drill.lock/pid"
run_demo drilllocked "$DG" -- --drill
expect "a lock held by a live process: exit 2, nothing ran" bash -c "[ $RC -eq 2 ] && ! grep -q 'stub\]' '$WORK/drilllocked.out'"
expect "says another drill is running, with its pid" has drilllocked "refusing --drill: another fire drill is running (pid $HOLDER"
expect "the other drill's lock is left alone" test "$(cat "$WORK/.config/qday/drill.lock/pid")" = "$HOLDER"
kill "$HOLDER" 2>/dev/null || true
wait "$HOLDER" 2>/dev/null || true
run_demo drillstale "$DG" -- --drill
expect "a stale lock (dead pid) is taken over: exit 0" test "$RC" -eq 0
expect "the drill ran under its own lock" has drillstale '\[stub\] cli:fresh-owner .*LOCK=\[[0-9][0-9]*\]'
expect "...not the dead holder's" bash -c "! grep -q 'LOCK=\[$HOLDER\]' '$WORK/drillstale.out'"
expect "the lock is released afterwards" test ! -e "$WORK/.config/qday/drill.lock"

echo "--drill with the drill port already in use"
PORT_FILE="$WORK/port.txt" node -e 'const s = require("net").createServer().listen(0, "127.0.0.1", () => require("fs").writeFileSync(process.env.PORT_FILE, String(s.address().port)))' &
LISTENER=$!
for ((t = 0; t < 100; t++)); do [[ -s "$WORK/port.txt" ]] && break; sleep 0.1; done
BUSY="$(cat "$WORK/port.txt")"
run_demo drillbusy "$DG" DRILL_AGENT_PORT="$BUSY" -- --drill
expect "something listens on DRILL_AGENT_PORT: exit 2, nothing ran" bash -c "[ $RC -eq 2 ] && ! grep -q 'stub\]' '$WORK/drillbusy.out'"
expect "says the port is in use" has drillbusy "refusing --drill: something already listens on 127.0.0.1:$BUSY"
expect "no lock left behind" test ! -e "$WORK/.config/qday/drill.lock"
kill "$LISTENER" 2>/dev/null || true
wait "$LISTENER" 2>/dev/null || true
LISTENER=""

echo "QDAY_DRILL_GUARDIAN_FILE is a caller-only (test) override"
printf 'OWNER_MNEMONIC="root owner words"\nFUNDER_MNEMONIC="funder words"\nGUARDIAN_ADDRESS="0x1"\nQDAY_DRILL_GUARDIAN_FILE="%s"\n' "$WORK/drill-guardian.env" >"$WORK/.env"
run_demo drillenvfile -- --drill
expect "a QDAY_DRILL_GUARDIAN_FILE in .env is ignored: exit 2, nothing ran" bash -c "[ $RC -eq 2 ] && ! grep -q 'stub\]' '$WORK/drillenvfile.out'"
expect "...it looks at the default ~/.config/qday/drill-guardian.env, as the agent does" has drillenvfile "refusing --drill: no drill guardian file $WORK/.config/qday/drill-guardian.env"
cp "$WORK/drill-guardian.env" "$WORK/.config/qday/drill-guardian.env"
run_demo drilldefault -- --drill
expect "the default drill guardian file under HOME: exit 0" test "$RC" -eq 0
rm -f "$WORK/.config/qday/drill-guardian.env"

echo "FUNDER_MNEMONIC from .env wins over OWNER_MNEMONIC"
printf 'OWNER_MNEMONIC="root owner words"\nFUNDER_MNEMONIC="funder words"\nGUARDIAN_ADDRESS="0x1"\n' >"$WORK/.env"
run_demo funder --
expect "attack sees FUNDER_MNEMONIC = funder" has funder '\[stub\] cli:attack FUNDER=\[funder words\]'

echo
echo "demo.sh harness: $PASSED passed, $FAILED failed"
[[ "$FAILED" -eq 0 ]]
