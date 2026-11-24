#!/usr/bin/env bash
# Q-Lifeboat end-to-end demo on qorechain-diana (Task 5).
#
#   ./demo.sh            one run
#   ./demo.sh --runs 3   three runs in a row, each from a FRESH owner; stops at the first FAIL
#   ./demo.sh --resume ~/.config/qday/runs/<run id>/run.env
#                        one run that reuses that COMPLETE run (RUN_COMPLETE=1, with its per-run
#                        AGENT_ED25519_SK) instead of a fresh owner, e.g. after a later step failed
#   ./demo.sh --drill    fire drill (Task 6G, combinable with --runs): the drill's own guardian
#                        (~/.config/qday/drill-guardian.env from `pnpm cli drill-guardian init`, or
#                        QDAY_DRILL_GUARDIAN_FILE) deploys and rescues instead of GAS_MNEMONIC; its agent
#                        listens on DRILL_AGENT_PORT (default 8788, never the main AGENT_PORT), writes its
#                        incidents to <run dir>/incidents.jsonl and sends no Telegram or webhook alert. The
#                        main agent and the real owner's protection are untouched.
#
# One run: fresh owner (funded by FUNDER_MNEMONIC, default OWNER_MNEMONIC; own ML-DSA key, own vault,
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
AGENT_READY_TIMEOUT=120
INCIDENT_TIMEOUT=60

usage() {
  echo "usage: $0 [--drill] [--runs N | --resume <run.env>]" >&2
  exit 2
}

# Fire drill: check the drill guardian file and the drill port, then export the drill's guardian, agent port and
# DRILL=1, with every alert channel set but empty (so `tsx --env-file` does not refill them from .env). Call it
# with the root .env loaded. Returns 2 on a refusal; prints addresses and ports only, never the mnemonic.
drill_env() {
  local file="${QDAY_DRILL_GUARDIAN_FILE:-$HOME/.config/qday/drill-guardian.env}"
  local main_port="${AGENT_PORT:-8787}" port="${DRILL_AGENT_PORT:-8788}"
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

RUNS=1
ONCE=0
DRILL_MODE=0
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
    --once) # internal: exactly one run in this process
      ONCE=1
      shift
      ;;
    *) usage ;;
  esac
done

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

if [[ "$ONCE" -eq 0 ]]; then
  if ((DRILL_MODE)); then
    # Refuse before the first run starts (each run checks again once it has loaded .env).
    (
      cd "$ROOT"
      set -a
      # shellcheck disable=SC1091
      [[ -f .env ]] && . ./.env
      set +a
      drill_env
    ) || exit 2
  fi
  CHILD=(--once)
  ((DRILL_MODE)) && CHILD+=(--drill)
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
# The funder (default: the root .env owner) also relays attack step (b), keeping the guardian's nonce free for
# rescues. Fixed here, before run.env replaces OWNER_MNEMONIC with the fresh owner's.
export FUNDER_MNEMONIC="${FUNDER_MNEMONIC:-${OWNER_MNEMONIC:-}}"
if ((DRILL_MODE)); then
  drill_env || exit 2
  echo "fire drill: guardian $GUARDIAN_ADDRESS, agent on :$AGENT_PORT, incidents and verdict in the run dir, no alerts"
fi

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

step "attack"
pnpm -s cli attack

step "incident"
pnpm -s cli demo-check --wait "$INCIDENT_TIMEOUT"

step "recovery"
pnpm -s cli sign-withdraw "$SAFE_ADDR" fUSD 1 --out "$RUN_DIR/withdrawal.json"
pnpm -s cli withdraw "$RUN_DIR/withdrawal.json"

step "verdict (run $RUN_ID, agent log $AGENT_LOG)"
grep "timing:" "$AGENT_LOG" || true
if pnpm -s cli demo-check --out "$RUN_DIR/verdict.json"; then
  VERDICT=pass
  echo "PASS: run $RUN_ID"
else
  VERDICT=fail
  echo "FAIL: run $RUN_ID"
  exit 1
fi
