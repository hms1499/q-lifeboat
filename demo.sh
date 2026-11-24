#!/usr/bin/env bash
# Q-Lifeboat end-to-end demo on qorechain-diana (Task 5).
#
#   ./demo.sh            one run
#   ./demo.sh --runs 3   three runs in a row, each from a FRESH owner; stops at the first FAIL
#   ./demo.sh --resume ~/.config/qday/runs/<run id>/run.env
#                        one run that reuses that COMPLETE run (RUN_COMPLETE=1, with its per-run
#                        AGENT_ED25519_SK) instead of a fresh owner, e.g. after a later step failed
#   ./demo.sh --drill    fire drill (Task 6G, combinable with --runs): the drill's own guardian
#                        (~/.config/qday/drill-guardian.env from `pnpm cli drill-guardian init`) deploys and
#                        rescues instead of GAS_MNEMONIC; its agent listens on DRILL_AGENT_PORT (default 8788,
#                        never the main AGENT_PORT), writes its incidents to <run dir>/incidents.jsonl and sends
#                        no Telegram or webhook alert. The main agent and the real owner's protection are
#                        untouched. Not with --resume. Needs FUNDER_MNEMONIC in the root .env (a drill never falls
#                        back to OWNER_MNEMONIC); `pnpm cli drill-guardian check` runs before each fresh owner.
#                        Refuses while the drill port is in use or another drill holds ~/.config/qday/drill.lock
#                        (a lock whose pid is dead is taken over).
#                        QDAY_DRILL_GUARDIAN_FILE (test-only override, read from the caller's environment only,
#                        never from .env) points at another drill guardian file; the agent and the CLI always
#                        use the default path.
#   ./demo.sh --phish    approval phishing (Task 7, combinable with --runs or --resume): after setup and the agent, the
#                        fresh owner signs approve(drainer, max) on fUSD and the drainer (FUNDER_MNEMONIC's account, in
#                        its own window scoped to fUSD) calls transferFrom at once; `pnpm cli phish` writes
#                        <run dir>/phish.json and PASSes when the Guardian rescued first (drainer got 0, >= 80% kept,
#                        rescue <= 3 blocks after the approval). No attack, recovery or demo-check. Not with --drill.
#                        --drainer-delay N (with --phish only, 0-20): the drainer waits N blocks after the approval
#                        (default 0: it pulls at once, the worst case; a same-speed drainer can win that race).
#                        Needs FUNDER_MNEMONIC in .env (never the OWNER_MNEMONIC fallback: the drainer's window would
#                        replace the watched owner's). Costs the funder ~1.5 QOR + fees per run plus the drainer's window.
#
# One run: fresh owner (funded by FUNDER_MNEMONIC, default OWNER_MNEMONIC except in a drill; own ML-DSA key, own vault,
# 100 fUSD) -> setup (scoped window + agent link + approvals) -> start the agent -> attack with the
# leaked ECDSA key -> wait for the agent's incident -> recovery (Guardian Signer + withdraw 1 fUSD to a
# fresh safe address) -> verdict (rescue <= 3 blocks after the first drain, >= 80% kept, (a), (b)), also
# written to <run dir>/verdict.json (demo-check --out; addresses and numbers only).
#
# Needs the root .env (see .env.example). Test the orchestration offline with scripts/test-demo.sh.
# The funder spends ~1.5 QOR + fees per run, the guardian (GAS_MNEMONIC) one window open (~0.225 QOR) + rescue gas. Secrets stay in .env and in
# ~/.config/qday/runs/<run id>/run.env (0600); nothing is written inside the repo.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Captured before any `. ./.env`, so a value in .env can never point demo.sh at another file than the agent's check.
CALLER_DRILL_GUARDIAN_FILE="${QDAY_DRILL_GUARDIAN_FILE:-}"
DRILL_LOCK="${HOME:-}/.config/qday/drill.lock"
AGENT_READY_TIMEOUT=120
INCIDENT_TIMEOUT=60

usage() {
  echo "usage: $0 [--drill | --phish [--drainer-delay N]] [--runs N | --resume <run.env>]" >&2
  exit 2
}

# Fire drill: check FUNDER_MNEMONIC (no OWNER_MNEMONIC fallback), the drill guardian file and the drill port, then
# export the drill's guardian, agent port and DRILL=1, with every alert channel set but empty (so `tsx --env-file`
# does not refill them from .env). Call it with the root .env loaded. Returns 2 on a refusal; prints addresses and ports only, never the mnemonic.
drill_env() {
  local file="${CALLER_DRILL_GUARDIAN_FILE:-$HOME/.config/qday/drill-guardian.env}"
  local main_port="${AGENT_PORT:-8787}" port="${DRILL_AGENT_PORT:-8788}"
  # A drill spends ~2 QOR of the funder: never the OWNER_MNEMONIC fallback a plain demo has (the watched owner).
  local funder="${FUNDER_MNEMONIC:-}"
  if [[ -z "${funder//[[:space:]]/}" ]]; then
    echo "refusing --drill: no FUNDER_MNEMONIC in the root .env (a drill is funded by FUNDER_MNEMONIC only, never by OWNER_MNEMONIC)" >&2
    return 2
  fi
  if [[ ! -f "$file" ]]; then
    echo "refusing --drill: no drill guardian file $file (create and fund it: pnpm cli drill-guardian init)" >&2
    return 2
  fi
  [[ "$port" =~ ^[0-9]+$ ]] || { echo "refusing --drill: DRILL_AGENT_PORT must be a port number" >&2; return 2; }
  if [[ "$port" == "$main_port" ]]; then
    echo "refusing --drill: DRILL_AGENT_PORT $port is the main agent's port (AGENT_PORT, default 8787)" >&2
    return 2
  fi
  local DRILL_GAS_MNEMONIC="" DRILL_GUARDIAN_ADDRESS="" # local: the file's values never reach the environment as such
  # shellcheck disable=SC1090
  . "$file"
  if [[ -z "$DRILL_GAS_MNEMONIC" || ! "$DRILL_GUARDIAN_ADDRESS" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
    echo "refusing --drill: $file has no DRILL_GAS_MNEMONIC or DRILL_GUARDIAN_ADDRESS (run: pnpm cli drill-guardian init)" >&2
    return 2
  fi
  local root_guardian="${GUARDIAN_ADDRESS:-}"
  if [[ "$(tr 'A-F' 'a-f' <<<"$DRILL_GUARDIAN_ADDRESS")" == "$(tr 'A-F' 'a-f' <<<"$root_guardian")" ]]; then
    echo "refusing --drill: the drill guardian $DRILL_GUARDIAN_ADDRESS is the main guardian (GUARDIAN_ADDRESS)" >&2
    return 2
  fi
  export GAS_MNEMONIC="$DRILL_GAS_MNEMONIC" GUARDIAN_ADDRESS="$DRILL_GUARDIAN_ADDRESS" AGENT_PORT="$port" DRILL=1
  export TELEGRAM_BOT_TOKEN="" TELEGRAM_CHAT_ID="" ALERT_WEBHOOK_URL=""
}

# Refuse (2) when something already listens on the drill port, e.g. a leftover drill agent. Call after drill_env.
drill_port_free() {
  if (exec 3<>"/dev/tcp/127.0.0.1/$AGENT_PORT") 2>/dev/null; then
    echo "refusing --drill: something already listens on 127.0.0.1:$AGENT_PORT (a leftover drill agent? DRILL_AGENT_PORT)" >&2
    return 2
  fi
}

# One drill at a time: mkdir is atomic. A lock whose pid is dead (a SIGKILLed drill) is taken over. Returns 2 when a
# live drill holds it. The caller removes it on exit (drill_unlock).
drill_lock() {
  mkdir -p "$(dirname "$DRILL_LOCK")"
  chmod 700 "$(dirname "$DRILL_LOCK")" 2>/dev/null || true
  if ! mkdir "$DRILL_LOCK" 2>/dev/null; then
    local holder
    holder="$(cat "$DRILL_LOCK/pid" 2>/dev/null || true)"
    if [[ "$holder" =~ ^[0-9]+$ ]] && kill -0 "$holder" 2>/dev/null; then
      echo "refusing --drill: another fire drill is running (pid $holder holds $DRILL_LOCK)" >&2
      return 2
    fi
    echo "taking over a stale drill lock (pid ${holder:-none} is gone)"
    rm -rf "$DRILL_LOCK"
    mkdir "$DRILL_LOCK" 2>/dev/null || { echo "refusing --drill: could not take $DRILL_LOCK" >&2; return 2; }
  fi
  echo "$$" >"$DRILL_LOCK/pid"
}
drill_unlock() {
  [[ "$(cat "$DRILL_LOCK/pid" 2>/dev/null || true)" == "$$" ]] && rm -rf "$DRILL_LOCK"
  return 0
}

RUNS=1
ONCE=0
DRILL_MODE=0
PHISH_MODE=0
DRAINER_DELAY=""
RESUME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --runs)
      [[ $# -ge 2 && "$2" =~ ^[1-9][0-9]*$ ]] || usage
      RUNS="$2"
      shift 2
      ;;
    --resume)
      [[ $# -ge 2 && -n "$2" ]] || usage
      RESUME="$2"
      shift 2
      ;;
    --drill)
      DRILL_MODE=1
      shift
      ;;
    --phish)
      PHISH_MODE=1
      shift
      ;;
    --drainer-delay)
      [[ $# -ge 2 && "$2" =~ ^[0-9]{1,2}$ ]] || usage
      ((10#$2 <= 20)) || usage
      DRAINER_DELAY="$2"
      shift 2
      ;;
    --once) # internal: exactly one run in this process
      ONCE=1
      shift
      ;;
    *) usage ;;
  esac
done

if [[ -n "$DRAINER_DELAY" ]] && ((!PHISH_MODE)); then
  echo "refusing --drainer-delay without --phish" >&2
  exit 2
fi
if ((DRILL_MODE && PHISH_MODE)); then
  echo "refusing --phish with --drill: the fire drill runs the drain attack" >&2
  exit 2
fi
if ((DRILL_MODE)) && [[ -n "$RESUME" ]]; then
  echo "refusing --drill with --resume: a drill always starts from a fresh owner deployed for the drill guardian" >&2
  exit 2
fi
if [[ -n "$RESUME" ]]; then
  ((RUNS == 1)) || { echo "refusing --resume with --runs $RUNS: a resumed run is a single run" >&2; exit 2; }
  [[ -f "$RESUME" ]] || { echo "refusing --resume: $RESUME is not a file" >&2; exit 2; }
  if ! grep -Eq '^RUN_COMPLETE="?1"?$' "$RESUME"; then
    echo "refusing --resume: $RESUME is not a complete run (no RUN_COMPLETE=1; fresh-owner stopped early)" >&2
    exit 2
  fi
  if ! grep -Eq '^VAULT_ADDRESS="?0x[0-9a-fA-F]{40}"?$' "$RESUME"; then
    echo "refusing --resume: $RESUME has no VAULT_ADDRESS (a --no-vault run is onboarded from the dashboard's Protect screen)" >&2
    exit 2
  fi
  if ! grep -Eq '^AGENT_ED25519_SK="?(0x)?[0-9a-fA-F]{64}"?$' "$RESUME"; then
    echo "refusing --resume: $RESUME has no AGENT_ED25519_SK. An agent key can be bound to ONE account only, so each" >&2
    echo "run needs the per-run key fresh-owner writes (older runs lack it): start a fresh run instead" >&2
    exit 2
  fi
  RESUME="$(cd "$(dirname "$RESUME")" && pwd)/$(basename "$RESUME")" # absolute: the run cd's to the repo
fi

# The drainer is FUNDER_MNEMONIC's account and opens its own window, which would REPLACE the watched owner's window if the
# funder fell back to OWNER_MNEMONIC (chain fact 10): a phishing run needs a separate funder, like a drill.
phish_funder_set() {
  (
    cd "$ROOT"
    set -a
    # shellcheck disable=SC1091
    [[ -f .env ]] && . ./.env
    set +a
    [[ -n "${FUNDER_MNEMONIC:-}" ]]
  )
}
if ((PHISH_MODE)) && ! phish_funder_set; then
  echo "refusing --phish: FUNDER_MNEMONIC is not set in .env (the drainer must not be the watched OWNER_MNEMONIC account)" >&2
  exit 2
fi

if [[ "$ONCE" -eq 0 ]]; then
  if ((DRILL_MODE)); then
    # Refuse before the first run starts (each run checks again once it has loaded .env). The port is checked here
    # only: between runs the previous run's agent may still be shutting down.
    (
      cd "$ROOT"
      set -a
      # shellcheck disable=SC1091
      [[ -f .env ]] && . ./.env
      set +a
      drill_env && drill_port_free
    ) || exit 2
    drill_lock || exit 2
    trap drill_unlock EXIT
    trap 'exit 130' INT TERM
  fi
  CHILD=(--once)
  ((DRILL_MODE)) && CHILD+=(--drill)
  ((PHISH_MODE)) && CHILD+=(--phish)
  [[ -n "$DRAINER_DELAY" ]] && CHILD+=(--drainer-delay "$DRAINER_DELAY")
  [[ -n "$RESUME" ]] && CHILD+=(--resume "$RESUME")
  for ((i = 1; i <= RUNS; i++)); do
    echo "=== demo run $i/$RUNS ==="
    # Each run is its own process, so `set -e` and the agent cleanup trap apply to it as a whole.
    if ! bash "$ROOT/demo.sh" "${CHILD[@]}"; then
      echo "FAIL: run $i/$RUNS failed; stopping"
      exit 1
    fi
  done
  echo "PASS: $RUNS/$RUNS runs"
  exit 0
fi

cd "$ROOT"
[[ -f .env ]] || { echo "FAIL: no .env in $ROOT (see .env.example)" >&2; exit 1; }
set -a
# shellcheck disable=SC1091
. ./.env
set +a
if ((DRILL_MODE)); then
  drill_env || exit 2 # before the funder default below: a drill refuses without FUNDER_MNEMONIC
  echo "fire drill: guardian $GUARDIAN_ADDRESS, agent on :$AGENT_PORT, incidents and verdict in the run dir, no alerts"
fi
# The funder (default: the root .env owner, never in a drill) also relays attack step (b), keeping the guardian's
# nonce free for rescues. Fixed here, before run.env replaces OWNER_MNEMONIC with the fresh owner's.
export FUNDER_MNEMONIC="${FUNDER_MNEMONIC:-${OWNER_MNEMONIC:-}}"

AGENT_PID=""
AGENT_LOG=""
FRESH_OUT=""
VERDICT=""
cleanup() {
  local rc=$?
  [[ -n "$FRESH_OUT" ]] && rm -f "$FRESH_OUT"
  if [[ -n "$AGENT_PID" ]] && kill -0 "$AGENT_PID" 2>/dev/null; then
    # The agent runs in its own process group (set -m below): stop pnpm, tsx and node together.
    kill -TERM -- "-$AGENT_PID" 2>/dev/null || kill -TERM "$AGENT_PID" 2>/dev/null || true
    wait "$AGENT_PID" 2>/dev/null || true
  fi
  if [[ -z "$VERDICT" ]]; then
    [[ -n "$AGENT_LOG" && -f "$AGENT_LOG" ]] && { echo "--- agent log (last 20 lines)"; tail -n 20 "$AGENT_LOG"; }
    echo "FAIL: run ${RUN_ID:-?} stopped (exit $rc)"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

step() {
  echo
  echo "--- $*"
}

if ((DRILL_MODE)); then
  # Read-only: the funder is not the watched owner and the drill guardian holds >= 0.5 QOR, before the funder pays.
  pnpm -s cli drill-guardian check
fi

if [[ -n "$RESUME" ]]; then
  step "fresh owner: resumed from $RESUME (fresh-owner skipped)"
  RUN_ENV="$RESUME"
else
  step "fresh owner"
  FRESH_OUT="$(mktemp "${TMPDIR:-/tmp}/qday-fresh.XXXXXX")" # explicit template: BSD mktemp ignores TMPDIR otherwise
  pnpm -s cli fresh-owner | tee "$FRESH_OUT"
  RUN_ENV="$(sed -n 's/^RUN_ENV=//p' "$FRESH_OUT" | tail -n 1)"
  rm -f "$FRESH_OUT"
  FRESH_OUT=""
fi
[[ -n "$RUN_ENV" && -f "$RUN_ENV" ]] || { echo "fresh-owner did not report a run.env" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
. "$RUN_ENV" # the fresh owner, its vault, its own AGENT_ED25519_SK, ATTACKER_ADDR, SAFE_ADDR, RUN_ID override the root .env
set +a
RUN_DIR="$(dirname "$RUN_ENV")"
# The recovery withdraw is sent by the owner from its scoped window (8 of its 10 txs), never by a
# RELAYER_MNEMONIC from .env. Set but empty, so `tsx --env-file` does not fill it back in.
export RELAYER_MNEMONIC=""
# The drill agent's incidents stay in the run dir, off the real owner's Incidents screen.
((DRILL_MODE)) && export INCIDENTS_FILE="$RUN_DIR/incidents.jsonl"

step "setup"
pnpm -s cli setup

step "agent"
AGENT_LOG="$RUN_DIR/agent.log"
set -m # job control: the agent gets its own process group
pnpm -s agent >"$AGENT_LOG" 2>&1 &
AGENT_PID=$!
set +m
for ((t = 0; ; t++)); do
  grep -q "watching" "$AGENT_LOG" && break
  kill -0 "$AGENT_PID" 2>/dev/null || { echo "the agent exited before watching" >&2; exit 1; }
  ((t < AGENT_READY_TIMEOUT)) || { echo "the agent was not watching after ${AGENT_READY_TIMEOUT} s" >&2; exit 1; }
  sleep 1
done
grep "watching" "$AGENT_LOG"

if ((PHISH_MODE)); then
  step "approval phishing (run $RUN_ID)"
  PHISH_ARGS=()
  [[ -n "$DRAINER_DELAY" ]] && PHISH_ARGS=(--drainer-delay "$DRAINER_DELAY")
  if pnpm -s cli phish ${PHISH_ARGS[@]+"${PHISH_ARGS[@]}"}; then
    VERDICT=pass
    echo "PASS: run $RUN_ID"
    exit 0
  fi
  VERDICT=fail
  echo "FAIL: run $RUN_ID"
  exit 1
fi

step "attack"
pnpm -s cli attack

step "incident"
pnpm -s cli demo-check --wait "$INCIDENT_TIMEOUT"

step "recovery"
pnpm -s cli sign-withdraw "$SAFE_ADDR" fUSD 1 --out "$RUN_DIR/withdrawal.json"
pnpm -s cli withdraw "$RUN_DIR/withdrawal.json"

SHOWN_LOG="$AGENT_LOG"
[[ -n "${HOME:-}" && "$SHOWN_LOG" == "$HOME/"* ]] && SHOWN_LOG="~/${SHOWN_LOG#"$HOME/"}" # the home path stays off the forwarded line
step "verdict (run $RUN_ID, agent log $SHOWN_LOG)"
grep "timing:" "$AGENT_LOG" || true
if pnpm -s cli demo-check --out "$RUN_DIR/verdict.json"; then
  VERDICT=pass
  echo "PASS: run $RUN_ID"
else
  VERDICT=fail
  echo "FAIL: run $RUN_ID"
  exit 1
fi
