# Q-Lifeboat for End Users Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A stranger with only a browser opens one public URL and, without a terminal or QOR of their own, creates an
account, turns on protection, watches the Guardian rescue a transfer, and withdraws with their post-quantum key.

**Architecture:** The dashboard gains an in-app wallet (random secp256k1 seed encrypted in IndexedDB + a `QRC1-…`
recovery code that is never stored) and signs hybrid and EVM txs itself through shared builders moved into
`@qday/core`. A new `apps/hosted` service serves the built dashboard, proxies diana REST/RPC, hands out a capped starter
pack, provisions one guardian account + agent key per owner, and supervises one unchanged agent process per owner behind
a gateway that only forwards writes carrying an ML-DSA signature by the owner's registered key. The agent gains an
on-demand window mode: it opens its window only when armed or when the owner's window is open.

**Tech Stack:** TypeScript, Node 22 `node:http`, React 18 + Vite 5, viem 2, `@qorechain/sdk@0.14.0`
(`unifiedAccountFromSeed`, `generatePqcRecoveryCode`, `pqcSign`, `pqcVerify`, `fetchPqcStatus`), WebCrypto, IndexedDB,
vitest, Foundry (unchanged contract).

**Spec:** `docs/specs/2026-11-25-end-user-product-design.md` (approved 2026-11-25). Read it before any task.

## Global Constraints

- Feature freeze **2026-11-30**; submission 2026-12-02 23:59 UTC. Cut per the order at the end, never the deadline.
- Testnet `qorechain-diana` only (EVM chain id 9800). Repo files, code comments and commits in English.
- `contracts/src/GuardianVault.sol` does not change. The shared TS ↔ Solidity withdrawal vector stays green.
- The agent's on-chain rule stays exactly `allowedEvmCalls=["<vault>/<rescue selector>"]`, `allowedDenoms=["uqor"]`.
- The LLM never decides to move funds; `apps/agent/src/rules.ts` is not touched.
- No mnemonic or private key in the repo. Hosted secrets live under `HOSTED_DATA_DIR` (outside the repo), files mode 0600.
- The recovery code is never persisted (no IndexedDB, no localStorage, no server). Only its derived keypair is held in
  memory, for the session.
- Every write that weakens protection or reaches an owner's Guardian (`onboard`, `activate`, `policy`, `arm`, `stop`,
  `topup`) carries an ML-DSA-87 signature by the owner's **registered, possession-proven** key.
- Gas limits: deploy `950_000n`, approve `100_000n`, mint `100_000n`, withdraw `1_000_000n` (`WITHDRAW_GAS`),
  hybrid tx fixed 1.5M gas = 0.225 QOR.
- Starter pack: owner **2.5 QOR**, one top-up of 1 QOR (signed, only when the owner holds < 0.5 QOR); guardian
  **1 QOR** at provisioning. Limits: 1 starter per owner address, 3 per IP per 24 h, 30 per day overall, paused when the
  funder holds < 20 QOR.
- Hosted agents: `POLL_MS=1000`, at most 40 running, no Telegram/webhook env, `/drill*` never proxied.
- Guardian retired after 7 days with no owner window and no incident.
- Push, deploy and anything that spends the funder outside a test run need the builder's go-ahead.
- High risk tier (full review): Tasks 2, 3, 4, 6, 7, 9, 10. Low tier: Tasks 1, 5, 8 (UI parts), 11, 12.

## Review Focus

1. **The tab closes mid-onboarding** (after the starter pack, after the vault deploy, after the link): reopening resumes
   from chain state; it never funds twice, deploys a second vault, or provisions a second guardian. → tests in Task 6
   (`onboard` is idempotent per owner) and Task 9 (`nextOnboardStep` from chain reads).
2. **A mistyped or wrong recovery code**: refused before anything is signed, with a plain message; never derives and
   registers a key that differs from the one on chain. → tests in Task 8 (`providePqc` vs registered key).
3. **A replayed or stale signed request** (same nonce twice, expired, signed by another account's key, classical only):
   refused by the gateway. → tests in Task 3 and Task 6.
4. **The hosted service restarts, or one agent crashes**: every active owner's agent comes back on its own port without
   user action; a crashing agent is restarted with backoff, not in a tight loop. → tests in Task 7.
5. **Starter-pack abuse and a low funder**: the 4th request from one IP in 24 h and any request below the funder floor
   are refused, and `/api/status` reports `onboarding: "paused"` so the landing page blocks before step 1. → tests in
   Task 6 and Task 9.

---

## File Structure

```
packages/core/src/
  chain.ts          MODIFY  configurable REST/RPC endpoints (browser goes through the hosted proxy)
  msgs.ts           CREATE  message/param builders shared by CLI, browser and hosted (moved from apps/cli)
  withdrawal.ts     CREATE  buildWithdrawal + assertRegisteredKey (moved from apps/cli/src/signer.ts)
  ownerAuth.ts      CREATE  signed owner requests: canonical bytes, sign, verify
apps/cli/src/       MODIFY  setup/link/window/fresh/signer import from @qday/core and re-export (tests unchanged)
apps/agent/src/
  window.ts         MODIFY  window blocks parameter, on-demand watcher
  server.ts         MODIFY  POST /arm (loopback gate, like PUT /policy)
  index.ts          MODIFY  GUARDIAN_WINDOW_MODE=always|on-demand
apps/hosted/        CREATE  new workspace @qday/hosted
  src/server.ts     static dashboard, /qore-rest + /qore-rpc proxies, /api routes
  src/store.ts      per-owner dir, state.json, secrets.env
  src/limits.ts     starter-pack caps
  src/provision.ts  starter pack, guardian provisioning, activation checks
  src/supervisor.ts spawn/restart/retire agents, port pool
  src/gateway.ts    /api/o/<owner>/* proxy, signature gate
  Dockerfile
apps/dashboard/src/
  lib/keystore.ts   encrypted seed in IndexedDB
  lib/session.ts    unlocked account in memory, recovery code → keypair
  lib/hosted.ts     client for /api (status, starter, onboard, activate, arm, policy)
  lib/ownerTx.ts    hybrid + EVM sends for the in-app account, owner windows sized per action
  lib/onboard.ts    step machine for the journey (pure, from chain reads)
  screens/Start.tsx steps 1–4
  screens/Attack.tsx step 5
  screens/Recover.tsx MODIFY  step 6 signs in the browser
  lib/agent.ts      MODIFY  agent base = /api/o/<owner>
  App.tsx           MODIFY  hosted navigation; Protect (MetaMask) and Fire drill leave the nav
```

---

### Task 0: Spike: hybrid txs from a browser page (throwaway, gate)

**Files:** `spike/browser-hybrid/` only (gitignored). Never imported by product code.

- [x] **Step 1:** Check CORS on diana's Tendermint RPC:
  `curl -si -X OPTIONS https://rpc-testnet.qore.host -H 'Origin: https://example.org' -H 'Access-Control-Request-Method: POST' | head -20`.
  Record whether `Access-Control-Allow-Origin` is present (decides whether Task 1 needs `/qore-rpc`).
- [x] **Step 2:** A Vite page with the dashboard's `/qore-rest` proxy (+ `/qore-rpc` if Step 1 says so). It generates
  `seed = crypto.getRandomValues(32)` and `code = generatePqcRecoveryCode()`, builds
  `acc = unifiedAccountFromSeed(seed, { recoveryCode: code })`, and prints `acc.evm`, `acc.cosmos`.
- [x] **Step 3:** Fund `acc.cosmos` with 1.5 QOR: `cd spike/probe && node fund.mjs send <qor1…> 1.5`.
- [x] **Step 4:** From the page: classical `MsgRegisterPQCKeyV2` (`buildRegisterMsg`), then a hybrid
  `openEvmWindowMsg` (scoped, 2 txs), then a hybrid link of a throwaway ed25519 key (`linkAuthenticatorMsgs`), each
  through `broadcastTx` with REST/RPC through the proxy. Then one EVM tx from `acc` inside the window with viem's local
  account (a 0-value `approve`).
- [x] **Step 5:** Expected: four tx hashes, `fetchPqcStatus` shows `registered: true, possessionProven: true` with the
  recovery-code pubkey. Record the hashes and the CORS result in `docs/EVIDENCE.md` ("Task 9 spike").
- [x] **Step 6: Gate.** If any step fails, stop and report to the builder with what was tried. Nothing else starts.

---

### Task 1: Configurable chain endpoints in core

**Files:** Modify `packages/core/src/chain.ts`; Test `packages/core/test/chain.test.ts`.

**Interfaces:**
- Produces: `configureEndpoints(e: { rest?: string; rpc?: string }): void`, `endpoints(): { rest: string; rpc: string }`.
  `getJson`, `uqorBalance`, `broadcastTx` (account read, `StargateClient.connect`, `EthNativeSigner`'s `rest`) use
  `endpoints()`. Defaults stay `NETWORK.rest` / `NETWORK.rpc`, so the CLI and agent are unchanged.

- [x] **Step 1: Failing test** `getJson uses the configured REST base`: stub `fetch`, call
  `configureEndpoints({ rest: "/qore-rest" })`, `await getJson("/x")`, assert the URL was `"/qore-rest/x"`; a second test
  asserts the default is `NETWORK.rest` after `configureEndpoints({})`.
- [x] **Step 2:** `pnpm -F core test` → FAIL (`configureEndpoints` not exported).
- [x] **Step 3:** Implement with a module-level `let current = { rest: NETWORK.rest, rpc: NETWORK.rpc }`.
- [x] **Step 4:** `pnpm -F core test && pnpm -F cli test && pnpm -F agent test` → all PASS.
- [x] **Step 5:** Commit `feat(core): configurable REST/RPC endpoints for browser use`.

---

### Task 2: Shared builders in core (move, don't change)

**Files:** Create `packages/core/src/msgs.ts`, `packages/core/src/withdrawal.ts`; modify `packages/core/src/index.ts`,
`apps/cli/src/{setup,window,fresh,signer,unlink}.ts` (import from core, keep re-exports so CLI tests stay as they are);
Test `packages/core/test/msgs.test.ts`, `packages/core/test/withdrawal.test.ts`.

**Interfaces:**
- Produces (moved verbatim, same names and signatures): `buildSetupRule`, `selectLinkMsgs`, `AGENT_TTL_SECONDS`,
  `buildRegisterMsg`, `buildFundMsg`, `buildOwnerWindowParams`, `buildOnboardWindowParams`, `buildUnlinkMsg`,
  `buildWithdrawal`, `assertRegisteredKey`, `WithdrawalFile`, `DEPLOY_GAS`, `APPROVE_GAS`, `MINT_GAS`, `MINT_AMOUNT`,
  `newAgentKeyHex` (from `apps/cli/src/fresh.ts`), `ruleIsExact` (from `apps/dashboard/src/lib/protect.ts`; the
  dashboard re-imports it).
- Produces (new, split out of `buildGuardianLinkMsgs` so the browser never needs the agent's secret key):
  `buildGuardianLinkMsgsFromProof(owner: { cosmos: string }, vault: string, proof: AgentLinkProof, existing: Pick<AuthenticatorView,"pubkeyHex"|"revoked"|"expiryUnix">[], nowUnix?: number)`
  where `type AgentLinkProof = ReturnType<typeof signAuthenticatorLinkEd25519> & { agentPubKeyHex: string }`.
  `buildGuardianLinkMsgs(owner, vault, agent, existing, now)` becomes a wrapper that signs the proof and calls it.
- All of `msgs.ts` and `withdrawal.ts` must import nothing from `node:*` (browser bundle).

- [x] **Step 1: Failing tests:**
  - `buildGuardianLinkMsgsFromProof equals buildGuardianLinkMsgs for the same key`: deep-equal messages for a fixed key
    and `nowUnix`.
  - The withdrawal vector test from `apps/cli` (same inputs, same `sig` verifies with `pqcVerify` over
    `withdrawalMessage`) now imports from `@qday/core`.
- [x] **Step 2:** `pnpm -F core test` → FAIL (modules missing).
- [x] **Step 3:** Move the code; CLI files re-export from core.
- [x] **Step 4:** `pnpm -F core test && pnpm -F cli test && pnpm -F agent test && (cd contracts && forge test)` → PASS,
  CLI test count unchanged. `pnpm -F dashboard build` still passes after `forge build`.
- [x] **Step 5:** Commit `refactor: move tx builders and the withdrawal signer into @qday/core`.

---

### Task 3: Signed owner requests

**Files:** Create `packages/core/src/ownerAuth.ts`; Test `packages/core/test/ownerAuth.test.ts`.

**Interfaces:**
- Produces:
  - `type OwnerPurpose = "onboard" | "activate" | "policy" | "arm" | "stop" | "topup"`
  - `type OwnerRequest = { owner: Hex; purpose: OwnerPurpose; body: unknown; nonce: string; expiresAt: number }`
  - `ownerRequestBytes(r: OwnerRequest): Uint8Array`: UTF-8 of
    `"qlifeboat-owner-request-v1\n" + JSON.stringify({ owner: lowercase, purpose, bodySha256: hex(sha256(canonicalJson(body))), nonce, expiresAt })`,
    keys in that order; `canonicalJson` sorts object keys recursively, bigint as decimal string.
  - `signOwnerRequest(r: OwnerRequest, pqcSecretKey: Uint8Array): { request: OwnerRequest; sig: Hex }`
  - `verifyOwnerRequest(signed: { request: OwnerRequest; sig: Hex }, registered: PqcStatus, nowUnix: number): { ok: true } | { ok: false; reason: "expired" | "too-far" | "not-registered" | "not-proven" | "bad-signature" }`
    with `"too-far"` when `expiresAt > now + 300`.
  - Shared hosted API types (used by `apps/hosted` and the dashboard, which must not import each other):
    `type OwnerStage = "starter" | "provisioned" | "active" | "retired"`,
    `type OwnerPublicState = { stage: OwnerStage | "none"; guardian?: Hex; vault?: Hex }`,
    `type HostedStatus = { onboarding: "open" | "paused"; reason?: string; activeGuardians: number }`.

- [x] **Step 1: Failing tests** (fixed keypair from `generatePqcKeypair(seed)`):
  - valid request → `{ ok: true }`;
  - body changed after signing → `bad-signature`;
  - signed by another keypair → `bad-signature`;
  - `expiresAt = now - 1` → `expired`; `expiresAt = now + 301` → `too-far`;
  - `registered: false` → `not-registered`; `possessionProven: false` → `not-proven`;
  - `canonicalJson({b:1,a:{d:2,c:3}}) === '{"a":{"c":3,"d":2},"b":1}'`.
- [x] **Step 2:** `pnpm -F core test` → FAIL.
- [x] **Step 3:** Implement with `pqcSign` / `pqcVerify` and `@noble/hashes/sha256`; the registered pubkey may be hex or
  bytes (`PqcStatus.pubkey`).
- [x] **Step 4:** `pnpm -F core test` → PASS.
- [x] **Step 5:** Commit `feat(core): ML-DSA-signed owner requests`.

---

### Task 4: Agent windows on demand

**Files:** Modify `apps/agent/src/window.ts`, `apps/agent/src/server.ts`, `apps/agent/src/index.ts`,
`apps/agent/src/config.ts`; Test `apps/agent/test/window.test.ts`, `apps/agent/test/server.test.ts`.

**Interfaces:**
- Consumes: `createWindowKeeper`, `needsWindow`, `checkPolicyWrite` (existing).
- Produces:
  - `buildGuardianWindowParams(guardianCosmos: string, vault: Hex, blocks: number = WINDOW_BLOCKS)`.
  - `guardianBlocksFor(ownerRemainingBlocks: bigint): number` = `min(Number(ownerRemainingBlocks) + 200, 14_400)`.
  - Keeper `ensure(opts?: { blocks?: number }): Promise<boolean>` (blocks forwarded to the open).
  - `createOnDemandWatcher(deps: { readOwnerWindow(): Promise<Pick<EvmWindow,"live"|"remainingBlocks">>; keeper: WindowKeeper; alert(msg: string): void; log(line: string): void }): { tick(): Promise<void>; arm(blocks: number): Promise<string | null> }`.
    `tick`: when the owner's window is live and the keeper's window is unusable, `ensure({ blocks: guardianBlocksFor(remaining) })`
    and `alert("owner window opened outside the app; guardian window opened")` unless an `arm` covered it in the last
    60 s. Idle owner → no read of the keeper beyond its cached status, no tx.
  - `AgentConfig.windowMode: "always" | "on-demand"` from `GUARDIAN_WINDOW_MODE` (default `"always"`, so `demo.sh` and
    the root agent behave as today).
  - `POST /arm` body `{ blocks: number }` (1 ≤ blocks ≤ 14400), same gate as `PUT /policy` (`checkPolicyWrite`); answers
    `{ tx: string | null }` once the guardian's window is live. Only in `on-demand` mode (404 otherwise).
  - In `on-demand` mode, `index.ts` skips the startup `ensure` and the periodic renewal; it runs `watcher.tick` every
    5 s. `rescue` still calls `ensure()` first, as today (last-resort path).

- [x] **Step 1: Failing tests:**
  - `idle owner: no window is opened` (owner `live:false`; fake keeper's `open` never called over 3 ticks);
  - `owner window live, guardian none: opens once with blocks = remaining + 200` (two ticks → one open);
  - `arm opens before the owner window and suppresses the alert`;
  - `guardianBlocksFor caps at 14400`;
  - `POST /arm from a non-loopback peer → 403`; `blocks: 0` and `blocks: 14401` → 400; `windowMode always` → 404.
- [x] **Step 2:** `pnpm -F agent test` → FAIL.
- [x] **Step 3:** Implement as specified.
- [x] **Step 4:** `pnpm -F agent test` → PASS; `bash scripts/test-demo.sh` → PASS (always mode untouched).
- [x] **Step 5: On-chain.** Run the agent for a fresh demo owner with `GUARDIAN_WINDOW_MODE=on-demand` (`./demo.sh` run
  env), confirm no guardian window tx while idle for 10 min, then `curl -X POST 127.0.0.1:8787/arm -d '{"blocks":600}' -H 'content-type: application/json'`,
  then open the owner window and drain with `pnpm cli attack`. Expected: rescue ≤ 3 blocks after the drain. Record the
  hashes in `docs/EVIDENCE.md`.
- [x] **Step 6:** Commit `feat(agent): on-demand guardian windows (arm + owner-window fallback)`.

---

### Task 5: Hosted service skeleton

**Files:** Create `apps/hosted/{package.json,tsconfig.json,src/server.ts,src/store.ts,test/server.test.ts,test/store.test.ts,Dockerfile}`.

**Interfaces:**
- Produces:
  - `createHostedServer(deps: HostedDeps): http.Server` serving `GET /` + static files from `DASHBOARD_DIST`
    (SPA fallback to `index.html`), `/qore-rest/*` → diana REST, `/qore-rpc` → diana RPC (only if Task 0 found no CORS),
    `GET /api/status` → `HostedStatus` (Task 3), `GET /api/owner/<owner>` → `OwnerPublicState` (`stage: "none"` when
    unknown).
  - `type OwnerState = { owner: Hex; stage: OwnerStage; guardian?: Hex; vault?: Hex; port?: number; createdAt: number; lastActiveAt: number; topups: number }`
    (server-side only; `OwnerStage` from `@qday/core`).
  - `createStore(dir: string)`: `get(owner): OwnerState | null`, `put(state)`, `list(): OwnerState[]`,
    `writeSecrets(owner, { GAS_MNEMONIC: string; AGENT_ED25519_SK: string })` (mode 0600), `readSecrets(owner)`.
    Writes are atomic (temp file + rename).
- Env: `HOSTED_DATA_DIR`, `DASHBOARD_DIST`, `PORT`, `FUNDER_MNEMONIC`, `PUBLIC_ORIGIN`.

- [x] **Step 1: Failing tests:** `/qore-rest/cosmos/x` forwards to `<REST>/cosmos/x` (stub upstream); unknown path under
  `/` returns `index.html`; `/api/status` shape; store round-trip; `writeSecrets` file mode is `0o600`; a crash between
  temp write and rename leaves the previous `state.json` readable.
- [x] **Step 2:** `pnpm -F hosted test` → FAIL.
- [x] **Step 3:** Implement with `node:http` and `fetch` (no framework).
- [x] **Step 4:** `pnpm -F hosted test` → PASS.
- [x] **Step 5:** Commit `feat(hosted): service skeleton, proxies and owner store`.

---

### Task 6: Starter pack and Guardian provisioning

**Files:** Create `apps/hosted/src/limits.ts`, `apps/hosted/src/provision.ts`; modify `apps/hosted/src/server.ts`;
Test `apps/hosted/test/limits.test.ts`, `apps/hosted/test/provision.test.ts`.

**Interfaces:**
- Consumes: `buildFundMsg`, `buildRegisterMsg`, `verifyOwnerRequest`, store (Task 5), `broadcastTx`.
- Produces:
  - `createLimits(clock)`: `check(ip: string, owner: Hex, funderUqor: bigint): { ok: true } | { ok: false; reason: "owner-used" | "ip-limit" | "daily-cap" | "funder-low" }`,
    `record(ip, owner)`. Constants `STARTER_OWNER_UQOR = 2_500_000n`, `TOPUP_UQOR = 1_000_000n`,
    `GUARDIAN_FUND_UQOR = 1_000_000n`, `FUNDER_FLOOR_UQOR = 20_000_000n`, `PER_IP_24H = 3`, `DAILY_CAP = 30`.
  - `POST /api/starter` `{ owner }` (unsigned: the account has no key yet) → `{ tx }`; stage `starter`.
  - `POST /api/topup` signed `topup` → `{ tx }` when the owner holds < 0.5 QOR and `topups === 0`.
  - `POST /api/onboard` signed `onboard` → `{ guardian: Hex; linkProof: AgentLinkProof }`. Idempotent: a second call
    for the same owner returns the stored guardian and a fresh proof, never a new account. First call: new guardian
    mnemonic + agent key (`newAgentKeyHex`), secrets written **before** any QOR is sent, fund guardian, classical
    register of the guardian's PQ key, wait until `fetchPqcStatus` shows it; stage `provisioned`.
  - `POST /api/activate` signed `activate` body `{ vault }` → `{ ok: true }` after checking on chain: `owner()` = owner,
    `guardian()` = stored guardian, a live linked agent key, `ruleIsExact`. Stage `active`, then hands off to the
    supervisor (Task 7).
  - Nonces: each signed route refuses a `(owner, nonce)` seen in the last 10 min (in-memory set + expiry).

- [x] **Step 1: Failing tests:**
  - limits: 4th request from one IP within 24 h → `ip-limit`; 31st of the day → `daily-cap`; funder at 19.9 QOR →
    `funder-low`; same owner twice → `owner-used`; `/api/status` says `paused` with `funder-low`;
  - `onboard twice returns the same guardian` (fake chain deps; `fund` called once);
  - `onboard with an expired request → 401`; `same nonce twice → 409`; `activate with a vault whose guardian() differs → 409`;
  - `secrets are written before the fund tx` (call order on fakes).
- [x] **Step 2:** `pnpm -F hosted test` → FAIL.
- [x] **Step 3:** Implement; chain I/O through an injectable `ChainDeps` like `FreshDeps` in `apps/cli/src/fresh.ts`.
- [x] **Step 4:** `pnpm -F hosted test` → PASS.
- [x] **Step 5: On-chain.** (merged into Task 9's browser run) Run the service locally against diana with the real funder; `curl` `/api/starter` for a
  fresh address, then `/api/onboard` with a request signed by a Node script using Task 3. Expected: fund tx, guardian
  fund + register txs. Record the hashes in `docs/EVIDENCE.md`.
- [x] **Step 6:** Commit `feat(hosted): starter pack, guardian provisioning and activation`.

---

### Task 7: Supervisor and gateway

**Files:** Create `apps/hosted/src/supervisor.ts`, `apps/hosted/src/gateway.ts`; modify `apps/hosted/src/server.ts`;
Test `apps/hosted/test/supervisor.test.ts`, `apps/hosted/test/gateway.test.ts`.

**Interfaces:**
- Consumes: store, `verifyOwnerRequest`, agent `POST /arm` and `PUT /policy` (Task 4, existing).
- Produces:
  - `createSupervisor(deps: { spawn(env: Record<string,string>): ChildLike; store; clock; log })`:
    `start(owner)`, `stop(owner)`, `resumeAll()` (every `active` owner), `running(): number`. Ports from 9100 upward,
    stored in `OwnerState.port`, reused on restart. Env per agent: `OWNER_EVM_ADDRESS`, `VAULT_ADDRESS`, token
    addresses, secrets, `AGENT_PORT`, `INCIDENTS_FILE=<owner dir>/incidents.jsonl`, `POLL_MS=1000`,
    `GUARDIAN_WINDOW_MODE=on-demand`. Restart on exit with backoff 1 s, 2 s, 4 s … capped at 60 s. Refuses a 41st agent.
  - `retireIdle(nowUnix)`: owners with `lastActiveAt` older than 7 days → stop, sweep the guardian's QOR minus 0.3 QOR
    fee reserve to the funder, stage `retired`. An `arm` on a retired owner re-funds the guardian and restarts it.
  - Gateway, `/api/o/<owner>/…`: `GET config|health|incidents|events` (SSE streamed) proxied as is; `PUT policy`
    (signed `policy`, body = the policy) and `POST arm` (signed `arm`, body `{ blocks }`) and `POST stop` (signed `stop`)
    forwarded to `127.0.0.1:<port>` with `Host: 127.0.0.1:<port>` and no `Origin`. Anything else → 404.
    Every forwarded write updates `lastActiveAt`.

- [x] **Step 1: Failing tests:**
  - `resumeAll starts every active owner on its stored port`;
  - `a crashing agent is restarted with growing delay` (fake clock: restarts at +1 s, +2 s, +4 s);
  - `41st start is refused`;
  - `retireIdle stops and sweeps an owner idle 7 days, keeps one idle 6 days`;
  - gateway: `GET /api/o/<owner>/drill → 404`; `PUT policy with a classical-only body → 401`;
    `PUT policy signed by another account → 401`; a valid signed `arm` reaches the fake agent with Host `127.0.0.1:<port>`.
- [x] **Step 2:** `pnpm -F hosted test` → FAIL.
- [x] **Step 3:** Implement; `spawn` defaults to `child_process.spawn("node", ["--import", "tsx", "apps/agent/src/index.ts"], { env })`.
- [x] **Step 4:** `pnpm -F hosted test` → PASS.
- [x] **Step 5:** Commit `feat(hosted): per-owner agent supervisor and signed gateway`.

---

### Task 8: In-app wallet

**Files:** Create `apps/dashboard/src/lib/keystore.ts`, `apps/dashboard/src/lib/session.ts`; Test
`apps/dashboard/src/lib/keystore.test.ts`, `apps/dashboard/src/lib/session.test.ts`.

**Interfaces:**
- Produces:
  - `type EncryptedSeed = { v: 1; kdf: "pbkdf2-sha256"; iter: number; salt: string; iv: string; ct: string; evm: Hex }`.
  - `encryptSeed(seed: Uint8Array, password: string, iter = 600_000): Promise<EncryptedSeed>`,
    `decryptSeed(e: EncryptedSeed, password: string): Promise<Uint8Array>` (throws `"wrong password"`).
  - `saveSeed(e)`, `loadSeed(): Promise<EncryptedSeed | null>` (IndexedDB, one record).
  - `createSession()`: `create(password) → { evm: Hex; code: string }` (new seed + `generatePqcRecoveryCode()`; the
    code is returned once and not kept), `unlock(password)`, `providePqc(code: string, registered: PqcStatus | null)`
    (builds `unifiedAccountFromSeed(seed, { recoveryCode })`; when `registered` is set, its pubkey must equal the derived
    one or it throws `"this recovery code does not belong to this account"`), `account(): UnifiedAccount | null`
    (null until both halves are present), `classical(): { evm: Hex; privateKey: Hex } | null`, `lock()`.
  - `exportSeedFile(e: EncryptedSeed): Blob` (JSON, still encrypted) and `importSeedFile(text: string): EncryptedSeed`
    (validates shape and `v: 1`), so a user can move to another browser. The recovery code is never in the file.
  - `confirmPicks(code: string): number[]` (three distinct group indexes 1–14) and
    `checkConfirm(code, picks, typed: string[]): boolean` (case-insensitive, Crockford O→0, I/L→1 via `normalizeRecoveryCode`).

- [x] **Step 1: Failing tests:** encrypt/decrypt round-trip; wrong password throws `wrong password`; `providePqc` with a
  mistyped code throws (checksum) and nothing is derived; with another account's code against a registered pubkey throws
  `this recovery code does not belong to this account`; `lock()` clears `account()` and `classical()`; `checkConfirm`
  accepts lowercase and `O` for `0`. (Tests use `iter: 1000` and an in-memory IndexedDB stub.)
- [x] **Step 2:** `pnpm -F dashboard test` → FAIL.
- [x] **Step 3:** Implement with WebCrypto (`crypto.subtle`), no new dependency.
- [x] **Step 4:** `pnpm -F dashboard test` → PASS.
- [x] **Step 5:** Commit `feat(dashboard): in-app wallet with an unstored recovery code`.

---

### Task 9: Onboarding, steps 1–4

**Files:** Create `apps/dashboard/src/lib/hosted.ts`, `apps/dashboard/src/lib/ownerTx.ts`,
`apps/dashboard/src/lib/onboard.ts`, `apps/dashboard/src/screens/Start.tsx`; modify `apps/dashboard/src/App.tsx`,
`apps/dashboard/src/main.tsx` (call `configureEndpoints({ rest: "/qore-rest", rpc: … })`), `apps/dashboard/vite.config.ts`
(`/qore-rpc` proxy if needed, `/api` proxy to the local hosted service in dev); Test `onboard.test.ts`, `ownerTx.test.ts`.

**Interfaces:**
- Consumes: Tasks 1–3, 6, 8.
- Produces:
  - `hosted.ts`: `status()`, `starter(owner)`, `onboard(signed)`, `activate(signed)`, `arm(owner, signed)`,
    `policy(owner, signed)`, `topup(signed)`; `signed(purpose, body)` builds an `OwnerRequest` with
    `nonce = crypto.randomUUID()`, `expiresAt = now + 120`, signed with the session's PQ key.
  - `ownerTx.ts`: `sendHybrid(acc, msgs, memo): Promise<string>` (via `broadcastTx`);
    `withOwnerWindow(acc, w: { txs: number; scope: "unscoped" | Hex[]; topupUqor?: bigint; extraMsgs?: EncodeObject[] }, run: (wallet: WalletClient) => Promise<Hex[]>): Promise<{ windowTx: string; txs: Hex[] }>`:
    arms the Guardian first when the owner is `active` (`arm` with `blocks = 600`), opens a window of exactly `w.txs`
    txs and 600 blocks (`buildOwnerWindowParams` / `buildOnboardWindowParams`) in one hybrid tx together with
    `extraMsgs`, waits until it is live, runs `run` with a viem local-account wallet, and returns the hashes.
  - `onboard.ts`: `type JourneyStep = "account" | "code" | "starter" | "register" | "guardian" | "vault" | "protect" | "attack" | "withdraw" | "done"`;
    `nextOnboardStep(i: { hasSeed: boolean; codeConfirmed: boolean; uqor: bigint | undefined; pqc: PqcStatus | undefined; state: OwnerPublicState | undefined; vault: { owner: Hex; guardian: Hex } | null; allowances: Record<TokenSymbol, bigint> | undefined; linked: boolean | undefined; ruleExact: boolean | undefined }): { step: JourneyStep; detail: string }`.
    `undefined` = still reading, never counts as done (same convention as `lib/protect.ts`).
  - Journey wiring in `Start.tsx` (one card per step, one button each):
    1. `account`: password ×2 (≥ 10 chars) → `session.create`.
    2. `code`: show the code once, then `checkConfirm` on three picks.
    3. `starter`: `hosted.starter(owner)`; wait for balance ≥ 2 QOR.
    4. `register`: classical `buildRegisterMsg` (`signMode: "classical"`).
    5. `guardian`: `hosted.onboard` → guardian + link proof.
    6. `vault`: `withOwnerWindow(unscoped, txs: 4)`: deploy `GuardianVault(owner, guardian)` (`DEPLOY_GAS`) + `mint`
       `MINT_AMOUNT` of fUSD, fETH, fBTC (`MINT_GAS`). The vault address is read from the deploy receipt and kept in
       browser storage.
    7. `protect`: `withOwnerWindow([fUSD, fETH, fBTC], txs: 3, extraMsgs: buildGuardianLinkMsgsFromProof(...))`: the
       three `approve(vault, maxUint256)` (`APPROVE_GAS`) in the same session as the link; then `hosted.activate`.
  - The guardian's gas tank is funded by the service at provisioning (1 QOR), not by the user; the existing Overview
    "Top up" stays for later top-ups. (Plan call: one fewer tx in the journey.)
  - Landing (`#/`) when there is no seed: hero + "Get started", disabled with the reason when `status().onboarding === "paused"`.
- [x] **Step 1: Failing tests:**
  - `nextOnboardStep`: each step from its inputs; a deployed vault with no link → `protect`, never `vault` again;
    stage `provisioned` → never `guardian` again; `uqor` undefined → stays on `starter` with "reading";
  - `withOwnerWindow arms before opening when active, not before onboarding` (fake hosted/chain; call order);
  - `withOwnerWindow sizes maxTxs to w.txs`;
  - landing: `status paused` → start disabled with the reason.
- [x] **Step 2:** `pnpm -F dashboard test` → FAIL.
- [x] **Step 3:** Implement.
- [x] **Step 4:** `pnpm -F dashboard test && pnpm -F dashboard build` → PASS.
- [x] **Step 5: On-chain.** Hosted service + `pnpm -F dashboard dev`, a fresh browser profile (Playwright), steps 1–7.
  Expected: register, window, deploy, mints, window+link, approvals, activate; the agent for this owner is running
  (`/api/o/<owner>/health`). Close the tab after `vault`, reopen, unlock: the journey resumes at `protect`. Record hashes.
- [x] **Step 6:** Commit `feat(dashboard): self-serve onboarding with the in-app wallet`.

---

### Task 10: Try an attack (step 5) and withdraw in the browser (step 6)

**Files:** Create `apps/dashboard/src/screens/Attack.tsx`; modify `apps/dashboard/src/screens/Recover.tsx`,
`apps/dashboard/src/lib/agent.ts` (`setAgentBase(url)`; default stays `VITE_AGENT_URL || http://127.0.0.1:8787`);
Test `apps/dashboard/src/lib/attack.test.ts`, extend `withdrawal.test.ts`.

**Interfaces:**
- Consumes: `withOwnerWindow`, `buildWithdrawal`, `checkWithdrawal`, `subscribeIncidents`.
- Produces:
  - `attackTarget(): Hex`: a fresh random address (never in the trusted list); `ATTACK_AMOUNT = 10n * 10n ** 18n` fUSD.
  - Attack flow: `withOwnerWindow([fUSD], txs: 1)` → `transfer(attackTarget(), ATTACK_AMOUNT)`; the screen shows the
    transfer block, then the incident from the SSE stream with its rescue block and "rescued N blocks later".
  - `signWithdrawalInBrowser(acc: UnifiedAccount, p: { vault: Hex; to: Hex; token: Hex; amount: bigint; nonce: bigint }): WithdrawalFile`
    (= `buildWithdrawal(p, acc.pqc.secretKey)` after `assertRegisteredKey`). Recover asks for the recovery code if the
    session has no PQ key, runs the existing `checkWithdrawal` list, then submits `vault.withdraw` with
    `withOwnerWindow([vault], txs: 1)`, `WITHDRAW_GAS`.
- [x] **Step 1: Failing tests:** `attackTarget` differs per call and is not in a given trusted list;
  `signWithdrawalInBrowser` output passes `checkWithdrawal` with fake chain reads (key/signature/message/nonce ✓);
  a session whose PQ key differs from the registered one throws before signing.
- [x] **Step 2:** `pnpm -F dashboard test` → FAIL.
- [x] **Step 3:** Implement.
- [x] **Step 4:** `pnpm -F dashboard test && pnpm -F dashboard build` → PASS.
- [x] **Step 5: On-chain.** Continue the Task 9 account: attack → rescue ≤ 3 blocks after the transfer, ≥ 80 % kept;
  withdraw 50 fUSD to a fresh address → balance arrives. Record hashes.
- [x] **Step 6:** Commit `feat(dashboard): try-an-attack and in-browser withdrawals`.

---

### Task 11: Hosted navigation and policy edits

**Files:** Modify `apps/dashboard/src/App.tsx`, `apps/dashboard/src/screens/{Overview,Rules}.tsx`,
`apps/dashboard/src/components/TrustedEditor.tsx`, `apps/dashboard/src/lib/agent.ts` (`putPolicy` sends a signed
`policy` request); Test `agent.test.ts`, `rules.test.ts`.

- Navigation: Overview, Incidents, Recover, Rules, Try an attack; Protect (MetaMask) and Fire drill removed from the nav
  (code kept, routes still reachable for local mode). A lock button clears the session.
- Policy writes go through `hosted.policy(owner, signed("policy", policy))`; the editor asks for the recovery code when
  the session has no PQ key.
- [x] **Step 1: Failing tests:** `putPolicy sends { request, sig } with purpose policy and the policy as body`;
  nav has no `protect` or `drill` entry.
- [x] **Step 2–4:** FAIL → implement → `pnpm -F dashboard test && pnpm -F dashboard build` PASS.
- [x] **Step 5:** Commit `feat(dashboard): hosted navigation and ML-DSA-signed policy edits`.

---

### Task 12: Deploy, docs and the three-browser run

**Files:** `apps/hosted/Dockerfile`, `README.md`, `docs/THREAT_MODEL.md` (spec §7), `docs/EVIDENCE.md`, `AI_USAGE.md`,
`CLAUDE.md` (new commands and chain facts), the plan checkboxes.

- [x] **Step 1:** Dockerfile: `pnpm install --frozen-lockfile`, `forge build` artifact copied in (no Foundry in the
  image: build `contracts/out` before), `pnpm -F dashboard build`, run `apps/hosted`. `docker build` passes locally.
  2026-11-26: built and run locally (no funder): `/api/status` paused "no-funder", `/` 200, `/qore-rest` + `/qore-rpc` reach
  diana. The idle service takes ~265 MB in the container, so the agent cap is now `HOSTED_MAX_AGENTS` (default 40).
- [x] **Step 2: Ask the builder** for the host and the go-ahead, then deploy with a persistent volume for
  `HOSTED_DATA_DIR` and the secrets as host env. Check `GET /api/status` on the public URL.
  2026-11-26: builder chose Fly.io (one app, UI and service on one origin; Vercel dropped: diana has no CORS, and a
  rewrite would put Vercel's IP in the per-IP starter cap). `fly.toml`: app `q-lifeboat`, `sin`, shared-cpu-1x 1 GB,
  volume `qlifeboat_data` on `/data`, auto-stop off, `HOSTED_MAX_AGENTS=4`; `FUNDER_MNEMONIC` set by the builder as a Fly
  secret. https://q-lifeboat.fly.dev/api/status → `{"onboarding":"open","activeGuardians":0}`, boot log
  `funder 0xa88D…36a1, max 4 agents`.
- [ ] **Step 3:** Three fresh browser profiles (Playwright, no extension, no QOR) complete steps 1–6 on the public URL,
  each ≤ 15 min. Then restart the service: all three agents come back (`/api/o/<owner>/health` live). An idle owner sends
  no guardian tx for 24 h (check the guardian's tx count the next day).
  2026-11-26: steps 1–6 done for three fresh origins on https://q-lifeboat.fly.dev (owner 3: 2 min 32 s; rescues 2 blocks,
  90 % kept); restart → "resumed 3 agent(s)", all three `/health` live. Two bugs found and fixed (`7e84752`: incident
  stream never reopened after the pre-agent 404/503; step 7 enabled while the vault step minted). Open: the 24 h idle
  check (guardian tx counts read 2026-11-27 after 02:30Z). See `docs/EVIDENCE.md` "Plan Task 12".
- [x] **Step 4:** Update README (Getting started = the URL; local mode moves to "Run it yourself"), THREAT_MODEL (§7 of the
  spec), EVIDENCE (every hash above), AI_USAGE. Commit `docs: end-user product, hosted threat model, evidence`.
  2026-11-26: README (live URL, the public instance's limits, Fly deploy), THREAT_MODEL (Fly proxy and the per-IP cap, the
  one-Machine outage, T26 slot exhaustion), EVIDENCE "Plan Task 12", AI_USAGE.

---

## Order and cuts

Tasks run in order, as fast as each one's verify allows; Task 0 gates everything after it. Cut in this order if the
freeze (2026-11-30) gets close: Task 11's policy editing (ship a read-only default list) → session unlock for returning
users (re-enter the code each visit) → `retireIdle` (run it by hand). Never cut: Task 0's gate, the recovery-code split,
Task 4, steps 1–6, the signature gate on writes.
