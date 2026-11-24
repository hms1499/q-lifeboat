# Task 6G: Fire drill (sub-plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan
> task-by-task. Sub-plan of `docs/plans/2026-11-19-qday-guardian.md` Task 6G. Steps use checkbox (`- [ ]`) syntax.

**Goal:** a "Run drill" button on the dashboard that runs the end-to-end attack on a throwaway owner (`fresh-owner`,
`setup`, agent, `attack`, `demo-check`, recovery) and shows its stages live and the verdict, plus a table of past runs,
without ever touching the watched owner's protection.

**Architecture:** the running agent (`:8787`, watching the real owner) spawns `./demo.sh --drill` as a child process.
In drill mode `demo.sh` runs its own agent on `:8788` with a SEPARATE drill guardian account, writes that agent's
incidents into the run dir and its verdict to `verdict.json`. The main agent parses `demo.sh`'s `--- <step>` lines into
stages and streams them over SSE; past runs come from the `verdict.json` files in `~/.config/qday/runs/*/`.

**Tech Stack:** TypeScript (Node 22, vitest), bash, Vite + React (dashboard), `@qorechain/sdk@0.14.0`.

**Spec:** `docs/specs/2026-11-19-qday-guardian-mvp.md` §2.3 "Fire drill".

**Approved departures (builder, 2026-11-24):**
- A separate drill guardian (`DRILL_GAS_MNEMONIC`), never the real guardian (`GAS_MNEMONIC`). The guardian's EVM window
  is scoped to ONE vault (`needsWindow` in `apps/agent/src/window.ts`) and a new open replaces the old one (chain fact
  10), so a drill agent sharing the real guardian would unscope the real owner's window and the two agents would fight
  over it (0.225 QOR per open) and over the guardian's EVM nonce.
- The drill reuses `demo.sh` (proven 3/3 on diana) instead of re-implementing the run in the agent. It includes `setup`
  and the recovery withdraw, which the plan line ("`fresh-owner`, `attack`, `demo-check`") left out but the verdict
  (kept = vault + recovered) needs.
- The drill agent writes its incidents to `<run dir>/incidents.jsonl` (`INCIDENTS_FILE`), so drill incidents never
  appear on the real owner's Incidents screen (an incident has no owner field).
- Drill runs send no Telegram or webhook alert (they are not the owner's incidents).

## Global Constraints

- Testnet `qorechain-diana` only. Never commit a mnemonic, private key or `.env`. Secrets live in `~/.config/qday/`
  (files 0600, dirs 0700), written with `writeRunFile` / the `runDir` guard (`apps/cli/src/run.ts`): never under the repo.
- The drill guardian file is `~/.config/qday/drill-guardian.env` with exactly `DRILL_GAS_MNEMONIC` and
  `DRILL_GUARDIAN_ADDRESS` (`formatRunEnv` format). Its address must differ from `GAS_MNEMONIC`'s, `OWNER_MNEMONIC`'s
  and `FUNDER_MNEMONIC`'s accounts.
- Drill guardian funding target: `2_000_000` uqor (2 QOR), `DRILL_GUARDIAN_TARGET_UQOR`. One drill costs it one window
  open (~0.225 QOR) plus rescue gas; the funder spends `FRESH_FUND_UQOR` (1.5 QOR) + fees per drill.
- Drill agent port: `DRILL_AGENT_PORT`, default `8788`; it must differ from the main agent's `AGENT_PORT` (default 8787).
- Drill timeout: `DRILL_TIMEOUT_MS = 15 * 60_000`; on timeout the runner kills the whole `demo.sh` process group.
- Verdict thresholds stay those of `demo-check`: rescue ≤ 3 blocks after the first drain, ≥ 80% kept, (a) and (b) PASS.
- The agent never reads a `run.env` (it holds the fresh owner's mnemonic). It reads only `verdict.json` and its own
  `drill.log` in a run dir.
- Agent API stays loopback-only. Every `/drill*` route checks the Host header (`isLocalHost`) and names only a dashboard
  origin in CORS (never `*`). `POST /drill` passes the same check as `PUT /policy` (`checkPolicyWrite`: loopback peer,
  local Host, allowed Origin, `Content-Type: application/json`).
- The CLI and the agent log addresses and tx hashes only, never a secret. Errors print the message only.
- EVM tx hashes are shown as copyable text, never explorer links (chain fact 19).
- Repo files, code comments and commits are in English. TDD: the failing test first.
- Commands: `pnpm -F cli test`, `pnpm -F cli typecheck`, `pnpm -F agent test`, `pnpm -F agent typecheck`,
  `bash scripts/test-demo.sh`, `cd contracts && forge build`, `pnpm -F dashboard test`, `pnpm -F dashboard build`.

## Review Focus

1. A web page the owner opens must not start a drill (it spends ~2 QOR of the funder): cross-origin `POST /drill`,
   a simple form POST (`text/plain`), a DNS-rebinding Host, a non-loopback peer → refused, nothing spawned.
2. The real owner's protection is untouched while a drill runs: the drill agent uses the drill guardian, port 8788 and
   `<run dir>/incidents.jsonl`; the main agent's env (e.g. its `AGENT_PORT`, `INCIDENTS_FILE`) never leaks into the child.
3. No secret reaches the browser: the runner forwards `demo.sh` output lines, so any line that looks like a mnemonic
   (12+ lowercase words) is redacted, and `/drill/runs` is built from `verdict.json` only.
4. A second click while a drill runs, or an agent shutdown mid-drill, leaves no orphan: 409 for the second start; on
   agent exit or timeout the `demo.sh` process group (and its child agent) is killed.
5. A dashboard reload mid-drill shows the running drill (state from `GET /drill`), not an idle screen with a button
   that answers 409.

---

### Task 1: CLI `drill-guardian init` (high tier)

**Files:**
- Create: `apps/cli/src/drillguardian.ts`, `apps/cli/test/drillguardian.test.ts`
- Modify: `apps/cli/src/fresh.ts` (export `deriveSecret`, `waitFor` if needed), `apps/cli/src/index.ts` (usage +
  `case "drill-guardian"`), `.env.example` (comment block for the drill guardian file and `DRILL_AGENT_PORT`)

**Interfaces:**
- Consumes: `buildFundMsg`, `buildRegisterMsg`, `checkFunderBalance`, `FEE_RESERVE_UQOR` (`fresh.ts`);
  `formatRunEnv`, `writeRunFile` (`run.ts`); `assertRegisteredKey` (`signer.ts`).
- Produces: `DRILL_GUARDIAN_FILE = "drill-guardian.env"`, `drillGuardianPath(home?: string): string`
  (`~/.config/qday/drill-guardian.env`), `DRILL_GUARDIAN_TARGET_UQOR = 2_000_000n`,
  `drillGuardianInit(env, deps: DrillGuardianDeps): Promise<{ address: Hex; cosmos: string; created: boolean; fundTx?: string; registerTx?: string }>`,
  `runDrillGuardian(args: string[], env?): Promise<void>`. The file lines are `DRILL_GAS_MNEMONIC="…"` and
  `DRILL_GUARDIAN_ADDRESS="0x…"`.

`init` is idempotent: create the account only when the file is missing (written 0600 BEFORE any QOR is sent), top it up
to the target only when its balance is below it, register its ML-DSA-87 key (classical, bootstrap-exempt, as
`fresh-owner` does) only when not registered. Running it again later is how the builder tops the drill guardian up.

- [ ] **Step 1: Write the failing tests** in `drillguardian.test.ts` (deps mocked, as in `fresh.test.ts`):
  - `test_createsFileBeforeFunding`: no file → `newMnemonic` called once, the file write happens before `broadcast`,
    mode 0600, the content has exactly the two keys.
  - `test_reusesExistingFile`: file present → `newMnemonic` not called, `created: false`.
  - `test_topsUpOnlyBelowTarget`: balance 2.1 QOR → no fund tx; balance 0.3 QOR → one `bank.send` of 1.7 QOR (target − balance).
  - `test_registersOnlyWhenUnregistered`: registered with the same key → no register tx; unregistered → one, then
    `assertRegisteredKey` passes.
  - `test_refusesWhenGuardianIsAnotherRoleAccount`: the derived address equals the `GAS_MNEMONIC`, `OWNER_MNEMONIC` or
    `FUNDER_MNEMONIC` account → throws before any broadcast.
  - `test_refusesWhenFunderShort`: funder balance < top-up + `FEE_RESERVE_UQOR` → throws before any broadcast.
  - `test_neverLogsMnemonic`: no logged line contains the mnemonic.
  - `runDrillGuardian(["bogus"])` throws `usage: drill-guardian init`.
- [ ] **Step 2:** Run `pnpm -F cli test drillguardian`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement `drillguardian.ts`; wire `index.ts` and the usage text; document the file in `.env.example`.
- [ ] **Step 4:** Run `pnpm -F cli test && pnpm -F cli typecheck`. Expected: all PASS, no type errors.
- [ ] **Step 5:** Commit `feat(cli): drill-guardian init for the fire drill's own guardian (Task 6G)`.

### Task 2: `demo.sh --drill`, `INCIDENTS_FILE`, `demo-check --out` (high tier)

**Files:**
- Modify: `demo.sh`, `scripts/test-demo.sh`, `apps/agent/src/index.ts` (incidents path), `apps/agent/src/config.ts`
  (`incidentsFile`), `apps/agent/test/config.test.ts`, `apps/cli/src/democheck.ts`, `apps/cli/test/democheck.test.ts`

**Interfaces:**
- Produces: agent env `INCIDENTS_FILE` (absolute path; default `<repo>/data/incidents.jsonl`);
  `AgentConfig.incidentsFile: string`. `demo-check --out <file>` writes `VerdictFile` (0600):
  `{ runId: string; mode: "drill" | "demo"; pass: boolean; failures: string[]; firstDrainBlock: string | null;
  blocks: string | null; keptPct: string; incident: string | null; owner: string; vault: string; checkedAt: string }`
  (`mode` is `"drill"` when env `DRILL=1`). Exported `buildVerdictFile(r, ctx): VerdictFile` is pure.
- `demo.sh` stage lines stay exactly `--- fresh owner`, `--- setup`, `--- agent`, `--- attack`, `--- incident`,
  `--- recovery`, `--- verdict (run <id>, …)`, and the end line `PASS: run <id>` / `FAIL: run <id> …`. Task 3 parses them.

`demo.sh --drill` (combinable with `--runs`, forwarded to each child run like `--resume`): after `. ./.env`, refuse
unless `${QDAY_DRILL_GUARDIAN_FILE:-$HOME/.config/qday/drill-guardian.env}` exists; source it; export
`GAS_MNEMONIC="$DRILL_GAS_MNEMONIC"`, `GUARDIAN_ADDRESS="$DRILL_GUARDIAN_ADDRESS"`, `AGENT_PORT="${DRILL_AGENT_PORT:-8788}"`,
`DRILL=1`, and set-but-empty `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ALERT_WEBHOOK_URL` (so `tsx --env-file` does not
refill them). After `run.env` is loaded: `export INCIDENTS_FILE="$RUN_DIR/incidents.jsonl"`. Refuse when the drill port
equals the root `.env`'s `AGENT_PORT` (or 8787). Every run (drill or not) ends with `demo-check --out "$RUN_DIR/verdict.json"`.

- [ ] **Step 1: Write the failing tests:**
  - `config.test.ts`: `test_incidentsFileDefaultsToRepoData`, `test_incidentsFileFromEnv`, `test_incidentsFileMustBeAbsolute`.
  - `democheck.test.ts`: `test_buildVerdictFileFromPassingRun` (`blocks: "2"`, `keptPct: "90.00"`, `mode: "demo"`),
    `test_verdictModeDrillWhenDrillEnv`, `test_verdictFileHasNoSecretKeys` (keys are exactly the `VerdictFile` keys).
  - `scripts/test-demo.sh` new cases: `--drill` exports the drill guardian as `GAS_MNEMONIC`/`GUARDIAN_ADDRESS`,
    `AGENT_PORT=8788` and `INCIDENTS_FILE=<run dir>/incidents.jsonl` to the agent step (stub echoes them); `--drill`
    without the drill guardian file exits 2 before fresh-owner; `--drill` with `DRILL_AGENT_PORT=8787` exits 2; the
    Telegram vars reach the agent step empty; the final demo-check gets `--out <run dir>/verdict.json`; without
    `--drill` the agent step sees the root `GAS_MNEMONIC` (unchanged behaviour).
- [ ] **Step 2:** Run `pnpm -F agent test config`, `pnpm -F cli test democheck`, `bash scripts/test-demo.sh`. Expected: the new cases FAIL.
- [ ] **Step 3:** Implement `INCIDENTS_FILE` in the agent, `--out` in `demo-check`, `--drill` in `demo.sh` (usage comment too).
- [ ] **Step 4:** Run `pnpm -F agent test && pnpm -F agent typecheck && pnpm -F cli test && pnpm -F cli typecheck && bash scripts/test-demo.sh`. Expected: all PASS.
- [ ] **Step 5:** Commit `feat: demo.sh --drill with its own guardian, port and incidents file; demo-check --out (Task 6G)`.

### Task 3: Agent drill runner and `/drill` API (high tier)

**Files:**
- Create: `apps/agent/src/drill.ts`, `apps/agent/test/drill.test.ts`
- Modify: `apps/agent/src/server.ts`, `apps/agent/test/server.test.ts`, `apps/agent/src/index.ts`

**Interfaces:**
- Consumes: Task 2's stage lines, `VerdictFile`, `drill-guardian.env` path (same default as Task 2).
- Produces (wire format, used by Task 4):
  - `DrillStage = "fresh owner" | "setup" | "agent" | "attack" | "incident" | "recovery" | "verdict"`, `DRILL_STAGES` in that order.
  - `DrillState = { status: "idle" | "running" | "pass" | "fail"; runId: string | null; stage: DrillStage | null;
    startedAt: string | null; endedAt: string | null; error: string | null; lines: string[] }` (`lines`: last 200, redacted).
  - `DrillRunSummary = VerdictFile` (newest first, at most 20).
  - `parseDrillLine(line: string): { stage?: DrillStage; runId?: string; result?: "pass" | "fail" } | null` —
    `--- <stage>` → stage; `run <id>: fresh owner …` → runId; `PASS: run <id>` / `FAIL: run <id>` → result.
  - `redactLine(line: string): string` — any run of 12 or more lowercase words separated by single spaces → `[redacted]`.
  - `drillEnv(env): Record<string, string>` — keeps only `PATH`, `HOME`, `TMPDIR`, `LANG`, `USER`, `SHELL`.
  - `createDrillRunner(deps: { spawn; repoRoot: string; runsDir: string; guardianFile: string; exists(p): boolean;
    readFile(p): string; listDirs(p): string[]; now(): Date; timeoutMs?: number; log }): DrillRunner` with
    `start(): DrillState` (throws `DrillError` `{ status: 409 | 503, message }`), `state(): DrillState`,
    `subscribe(fn: (s: DrillState) => void): () => void`, `runs(): DrillRunSummary[]`, `stop(): void`.
  - Server routes (via a new `ServerOptions.drill?: DrillRunner`): `POST /drill` → 202 `DrillState` | 409 | 503 |
    the `checkPolicyWrite` refusal; `GET /drill` → `DrillState`; `GET /drill/events` → SSE, one `event: drill`
    frame with the full `DrillState` on connect and on every change; `GET /drill/runs` → `DrillRunSummary[]`;
    `OPTIONS /drill` → 204 with `Access-Control-Allow-Methods: GET, POST, OPTIONS`.

`start()` spawns `bash <repoRoot>/demo.sh --drill` detached (own process group), cwd `repoRoot`, env `drillEnv(process.env)`,
stdout+stderr line-split, each line appended to `<run dir>/drill.log` once the run id is known (buffer before that).
503 when `guardianFile` is missing (message names `pnpm cli drill-guardian init`). Exit code 0 with a `PASS` line →
`pass`; anything else → `fail` with `error` = the last `FAIL:` line or `exit <code>`. `stop()` (called on agent SIGINT/
SIGTERM in `index.ts`) and the timeout kill the process group with SIGTERM. `runs()` reads `<runsDir>/<id>/verdict.json`
only (a dir without it is skipped; a malformed one is skipped and logged).

- [ ] **Step 1: Write the failing tests** in `drill.test.ts` (spawn mocked with an EventEmitter child):
  - `test_parseStageLines` (each of the 7 stages, the verdict line with its suffix), `test_parseRunIdAndResult`.
  - `test_redactsMnemonicLikeLine` (a 12-word line → `[redacted]`; an address/tx-hash line unchanged).
  - `test_drillEnvDropsAgentVars` (`AGENT_PORT`, `INCIDENTS_FILE`, `GAS_MNEMONIC` not passed; `PATH`, `HOME` kept).
  - `test_secondStartWhileRunningIs409`, `test_startWithoutGuardianFileIs503AndSpawnsNothing`.
  - `test_passOnExit0WithPassLine`, `test_failOnNonZeroExit` (`error` is the `FAIL:` line).
  - `test_timeoutKillsProcessGroup`, `test_stopKillsProcessGroup` (`process.kill(-pid, "SIGTERM")` via an injected `kill`).
  - `test_subscribersGetEveryChange`, `test_linesCappedAt200`.
  - `test_runsReadsVerdictOnly` (`readFile` is asked for `verdict.json` paths only, never `run.env`; newest first; max 20;
    a malformed verdict is skipped).
- [ ] **Step 2: Write the failing tests** in `server.test.ts`:
  - `test_drillPostRejectedFromNonLoopback`, `test_drillPostRejectsForeignOrigin`, `test_drillPostRejectsTextPlain`,
    `test_drillRoutesRejectForeignHost` (GET `/drill`, `/drill/events`, `/drill/runs` too) — nothing started in each.
  - `test_drillPostFromDashboardOriginStarts` (202, CORS names that origin), `test_drillPost409Passthrough`.
  - `test_drillEventsSendsStateOnConnect`, `test_drillRoutes404WithoutRunner`.
- [ ] **Step 3:** Run `pnpm -F agent test drill server`. Expected: the new tests FAIL.
- [ ] **Step 4:** Implement `drill.ts`, the routes in `server.ts`, and in `index.ts` create the runner
  (`runsDir = ~/.config/qday/runs`, `guardianFile = ~/.config/qday/drill-guardian.env`), pass it to `startServer`, and
  call `drill.stop()` on SIGINT/SIGTERM before exiting.
- [ ] **Step 5:** Run `pnpm -F agent test && pnpm -F agent typecheck`. Expected: all PASS.
- [ ] **Step 6:** Commit `feat(agent): fire drill runner and /drill API (Task 6G)`.

### Task 4: Dashboard Fire drill screen (low tier)

**Files:**
- Create: `apps/dashboard/src/lib/drill.ts`, `apps/dashboard/src/lib/drill.test.ts`, `apps/dashboard/src/screens/Drill.tsx`
- Modify: `apps/dashboard/src/App.tsx` (nav entry `{ id: "drill", label: "Fire drill", href: "#/drill" }`, remove `SOON`),
  `apps/dashboard/src/styles.css` if needed

**Interfaces:**
- Consumes: Task 3 wire types (copy the types into `lib/drill.ts`; the dashboard does not import the agent package).
- Produces: `parseDrillState(x: unknown): DrillState` (throws on a bad shape), `parseDrillRuns(x: unknown): VerdictFile[]`
  (drops malformed rows), `stageStatus(s: DrillState, stage: DrillStage): "done" | "active" | "pending" | "failed"`,
  `startDrill(): Promise<DrillState>` (POST with `Content-Type: application/json`, body `{}`; a refusal's `error` thrown
  verbatim), `subscribeDrill(onState: (s: DrillState) => void): () => void` (EventSource on `${AGENT_URL}/drill/events`).

Screen: one-paragraph explainer (a throwaway owner is attacked; the watched owner is not touched; costs ~2 QOR testnet
from the funder), "Run drill" button (disabled while `running` or the agent is offline), the 7 stages with
`stageStatus` marks, a collapsible log (`lines`), the verdict (PASS/FAIL, blocks, kept %), and a past-runs table
(run id, date, mode, PASS/FAIL, blocks, kept %). On load: `GET /drill` + `GET /drill/runs`, then the SSE stream; when a
drill ends, re-read `/drill/runs`. A 503 shows the `pnpm cli drill-guardian init` command (absolute repo path).

- [ ] **Step 1: Write the failing tests** in `drill.test.ts`: `test_stageStatusRunning` (stages before `stage` done,
  `stage` active, after pending), `test_stageStatusFailMarksCurrentStageFailed`, `test_stageStatusPassAllDone`,
  `test_parseDrillStateRejectsBadShape`, `test_parseDrillRunsDropsMalformedRows`.
- [ ] **Step 2:** Run `pnpm -F dashboard test drill`. Expected: FAIL (module missing).
- [ ] **Step 3:** Implement `lib/drill.ts`, `Drill.tsx`, the nav entry.
- [ ] **Step 4:** Run `cd contracts && forge build && cd .. && pnpm -F dashboard test && pnpm -F dashboard build`. Expected: PASS and the build succeeds.
- [ ] **Step 5:** Commit `feat(dashboard): Fire drill screen (Task 6G)`.

### Task 5: Diana verification and records

- [ ] **Step 1:** `pnpm cli drill-guardian init` on diana. Expected: a fund tx and a register tx (hashes logged), file
  `~/.config/qday/drill-guardian.env` mode 0600. Running it again sends nothing.
- [ ] **Step 2:** Start the main agent (`pnpm agent`, root `.env`) and the dashboard (`pnpm -F dashboard dev`), open
  `#/drill`, click "Run drill". Expected: the 7 stages tick live, verdict PASS with ≤ 3 blocks and ≥ 80% kept; the
  past-runs table shows it; the main agent's `/health` shows its own window still live and scoped to the real vault
  throughout; the Incidents screen shows no drill incident.
- [ ] **Step 3:** Review (fresh context) of Tasks 1-3 against Review Focus 1-5 and the Hard rules; fixes loop back.
- [ ] **Step 4:** Record: drill guardian txs and the drill's run id + rescue hash in `docs/EVIDENCE.md`; a T-entry in
  `docs/THREAT_MODEL.md` (drill endpoint spends funder QOR → loopback + origin gate; separate drill guardian); Task 6G
  in `AI_USAGE.md`; the drill commands in `CLAUDE.md`; tick Task 6G in the main plan and this sub-plan.
- [ ] **Step 5:** Commit `docs: Task 6G evidence on diana, threat model, plan ticks`.
