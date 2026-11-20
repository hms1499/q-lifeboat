# Q-Day Guardian Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An AI agent on testnet `qorechain-diana` that sweeps an owner's EVM assets into a vault that only opens with ML-DSA-87 when the ECDSA key leaks.

**Architecture:** One Foundry contract (`GuardianVault`), one Node/TS agent and a set of CLIs (setup, signer, attacker, withdraw) sharing `packages/core`, plus a mostly read-only Vite/React dashboard. The agent acts for the owner through the authenticator lane (`MsgExecuteEVM` signed with ed25519) under the spending rule `allowedEvmCalls = ["<vault>/<rescue selector>"]`. No backend or DB: the agent writes incidents to `data/incidents.jsonl` and serves them over HTTP/SSE.

**Tech Stack:**
- Solidity 0.8.28, Foundry
- Node 22, TypeScript, pnpm workspaces, tsx, vitest
- `@qorechain/sdk@0.14.0` (`deriveUnifiedAccount`, `pqcSign`, `linkAuthenticatorMsgs`, `signAuthenticatorLinkEd25519`, `buildPhantomExecuteEvm`, `fetchAuthNonce`, `fetchSpendingRules`, `fetchAuthenticators`, `openEvmWindowMsg`, `revokeAuthenticatorMsg`)
- `@qorechain/evm` (`evmWindowStatus`, `erc20`)
- viem, `@noble/curves/ed25519`
- `@anthropic-ai/sdk` (model `claude-haiku-5-5`)
- Vite + React + `@qorechain/react`

**Spec:** `docs/specs/2026-11-19-qday-guardian-mvp.md`

## Global Constraints

- Testnet `qorechain-diana` only, EVM chain ID `9800`. EVM RPC `https://evm-testnet.qore.host`, REST `https://api-testnet.qore.host`, RPC `https://rpc-testnet.qore.host`.
- Precompiles: `pqcVerify` = `0x0000000000000000000000000000000000000a01`, `pqcKeyStatus` = `0x0000000000000000000000000000000000000a02` (lowercase).
- MIT license. The README credits `qorechain/build-before-qday` workshop-2 and every kit used.
- The LLM **never** decides to move funds. Only `rules.ts` decides.
- Testnet keys live in `.env` (gitignored). Never commit a mnemonic.
- Milestones: feature freeze 2026-11-30, submit before 2026-12-02 23:59 UTC.

## Review Focus

1. The agent fires again after the vault already holds everything (owner balance = 0): it must skip, not send empty txs that burn nonces. Test in Task 4.
2. The message signed in TS must match the message Solidity builds byte for byte. Otherwise every withdraw reverts. Shared test vector in Task 2.
3. After `vault.withdraw` the nonce increments, so resubmitting an old signature must be rejected. Test in Task 1.
4. The owner's own outbound tx to an allowlisted address must not trigger a rescue (false positive). Test in Task 4.
5. An incident report with a valid signature from a key that is **not** the currently linked authenticator must show ✗ on the dashboard. Test in Task 6.

---

### Task 0: Assumption spike (THROWAWAY), DONE 2026-11-19

**Files:**
- Create: `spike/` (never merged into the main code)

Results are in spec §7 and `docs/EVIDENCE.md`. All gates passed, so we keep the main design.

- [x] **Step 1:** Ran workshop-2 `01-qday-vault` (deploy, attack, withdraw) on diana. `withdraw` reported gasUsed 500000 (limit 1M).
- [x] **Step 2:** Linked an ed25519 key with `allowedEvmCalls=["<A>/<pull selector>"]`. `A.pull` succeeded. `A.ping` and `B.ping` were refused ("authenticator not permitted").
- [x] **Step 3:** The agent lane works with the owner's window closed.
- [x] **Step 4:** `transferFrom` of 1000 tokens inside `pull` is not counted against perTx 1 QOR.
- [x] **Step 5 (gate):** No fallback needed. Extra finding: spending rules don't bind the owner's ECDSA key, so the window budget is the only cap on the attacker. Recorded in `docs/THREAT_MODEL.md`.

### Task 1: `GuardianVault.sol` + Foundry tests (Nov 21–22), DONE 2026-11-20

**Files:**
- Create: `contracts/src/GuardianVault.sol`, `contracts/test/GuardianVault.t.sol`, `contracts/test/mocks/MockPqc.sol`, `contracts/test/mocks/MockERC20.sol`, `contracts/foundry.toml`
- Create (root): `package.json`, `pnpm-workspace.yaml`; run `git init` (`.gitignore` and `LICENSE` already exist)

**Interfaces:**
- Produces:
  - `constructor(address owner_)`. `owner` is `immutable` (the owner account, which is also the ML-DSA guardian).
  - `function rescue(address token) external`: `transferFrom(owner, this, min(balanceOf(owner), allowance(owner,this)))`. Does not revert on a zero balance. Emits `Rescued(token, amount)`.
  - `function deposit() external payable`: emits `Deposited(amount)`.
  - `function withdraw(address to, address token, uint256 amount, bytes calldata mldsaSig) external` (`token == address(0)` means QOR).
  - `function withdrawalMessage(address to, address token, uint256 amount, uint256 n) public view returns (bytes memory)` = `abi.encodePacked("QDAY-GUARDIAN-V1", block.chainid, address(this), to, token, amount, n)`.
  - `uint256 public nonce`.
  - Errors: `KeyNotRegistered()`, `KeyNotProven()`, `BadSignature()`, `TransferFailed()`.

`MockPqc` is `vm.etch`ed at `0x…a01` and `0x…a02`. It returns configurable `registered`, `proven` and verify results through setters, and verify returns true when `keccak(sig) == keccak(expectedSig)`.

- [x] **Step 1:** Write the failing `rescue` tests:
  - `test_rescuePullsAllowedBalance`: owner has 100e18 and approves max. After rescue the vault holds 100e18 and the owner 0.
  - `test_rescueZeroBalanceDoesNotRevert`.
  - `test_rescueCallableByAnyone`: only the owner's funds move, and only into the vault.
- [x] **Step 2:** Write the failing `withdraw` tests:
  - `test_withdrawWithValidSig`.
  - `test_revertsBadSignature`.
  - `test_signatureWorksOnce`: resubmitting an old signature reverts with `BadSignature`.
  - `test_revertsWhenKeyNotRegistered`, `test_revertsWhenKeyNotProven`.
  - `test_signatureBoundToToAmountToken`.
  - `test_nonceIncrementsBeforeTransfer`.
- [x] **Step 3:** Run `cd contracts && forge test`. Expected: FAIL (contract missing).
- [x] **Step 4:** Implement `GuardianVault.sol` following the `QDayVault` pattern: read the key via `pqcKeyStatus(owner)` and bump the nonce before the external call. Credit the source in a comment.
- [x] **Step 5:** Run `forge test -vv`. Expected: all PASS.
- [x] **Step 6:** Commit `feat(contracts): GuardianVault with ML-DSA withdraw and rescue`.

As built: `git init` skipped (repo existed). `MockPqc.pqcVerify` accepts `keccak256("ok", pubkey, message)` so the binding tests are meaningful. Review hardening added `ZeroOwner()`, a code-less token check, chainId/vault binding tests and failure-path tests (21 tests).

### Task 2: `packages/core` + test vector + diana deploy + Audit Stage 1 (Nov 23)

**Files:**
- Create: `packages/core/src/config.ts`, `accounts.ts`, `vaultMessage.ts`, `abi.ts`, `packages/core/test/vaultMessage.test.ts`
- Create: `contracts/test/MessageVector.t.sol`, `contracts/script/Deploy.s.sol`
- Create: `docs/audit/stage1-YYYY-MM-DD.md`, and fill in `docs/AUDIT.md`

**Interfaces:**
- Produces:
  - `NETWORK` (chainId, evmChainId, rest, rpc, evmRpc).
  - `loadOwner(): Promise<UnifiedAccount>`, from `OWNER_MNEMONIC` via `deriveUnifiedAccount`.
  - `loadAgentKey(): { sk: Uint8Array; pk: Uint8Array }`, from `AGENT_ED25519_SK`.
  - `withdrawalMessage(p: { chainId: bigint; vault: Hex; to: Hex; token: Hex; amount: bigint; nonce: bigint }): Uint8Array`.
  - `RESCUE_SELECTOR: Hex`, `vaultAbi`.

- [x] **Step 1:** Write the test vector, with the same fixed inputs on both sides (chainId 9800, vault `0x…01`, to `0x…02`, token `0x…03`, amount `1e18`, nonce 0):
  - `MessageVector.t.sol` asserts `keccak256(withdrawalMessage(...)) == 0x<HASH>`.
  - `vaultMessage.test.ts` asserts `keccak256(withdrawalMessage(...))` gives the same `0x<HASH>`.
  - `<HASH>` is the value Solidity prints on the first run, then copied into both tests.
- [x] **Step 2:** Run `forge test --match-contract MessageVector` and `pnpm -F core test`. Expected: both PASS with the same hash.
- [x] **Step 3:** Deploy to diana with `forge script script/Deploy.s.sol --rpc-url $EVM_RPC --broadcast` (the owner opens a window first). Write `VAULT_ADDRESS` to `.env`, the README and `docs/EVIDENCE.md`.
- [x] **Step 4:** Run QCAI Stage 1 on dashboard.qorechain.io (Ethereum/Solidity setting). Save the report, build the findings table in `docs/AUDIT.md`, fix each finding with a test and rerun `forge test`.
- [x] **Step 5:** Commit.

As built (Steps 1-2): vector addresses are `0x1111…`, `0x2222…`, `0x3333…` because `0x…01-03` are precompiles. Hash `0x783fcbffbc8f1ec81272b39002a0c603c86984c6f9138f874c950e790e3c31eb` (172 bytes) on both sides. `Deploy.s.sol` derives the key with `vm.deriveKey(OWNER_MNEMONIC, 0)` and only runs on chain 9800. The diana vault's owner is the Task 0 spike owner (PQC key already registered).

As built (Steps 3-4): QCAI Stage 1 scored 85/100 (MEDIUM). Fixes: `rescue` is now **owner-only** (`NotOwner`; this replaces Task 1's `test_rescueCallableByAnyone`) and token return values follow SafeERC20 semantics. v1 `0x8A11…b0A5` is retired; v2 is `0x17d867860a0A0Ff528dF655439ff59176b061B3C`. The agent lane calling as the owner was proven on diana (`docs/EVIDENCE.md`). Task 3 setup needs only `MsgUpdateSpendingRules` if the agent key is already registered.

### Task 3: CLI setup + Guardian Signer + withdraw (Nov 24–25)

**Files:**
- Create: `apps/cli/src/setup.ts`, `signer.ts`, `withdraw.ts`, `apps/cli/test/setup.test.ts`

**Interfaces:**
- Consumes: Task 2 core.
- Produces these commands:
  - `pnpm cli setup`: in **one** hybrid tx, send `openEvmWindowMsg` (blocks 600, maxTxs 10, `allowedTargets=[fUSD, VAULT]`). Then send EVM `approve(VAULT, max)` for fUSD/fETH/fBTC, then `linkAuthenticatorMsgs` with `{scheme:"ed25519", permissions:["evm"], expiryUnix: now+7d, spendingRule:{ perTxLimit, dailyLimit, allowedDenoms:["uqor"], allowedEvmCalls:[`${VAULT}/${RESCUE_SELECTOR}`] }}`.
  - `pnpm cli sign-withdraw <to> <token> <amount>`: writes `withdrawal.json` with `{to, token, amount, nonce, sig}`. This is the Guardian Signer; it runs locally and uses `pqcSign`.
  - `pnpm cli withdraw withdrawal.json`: any gas wallet can submit it.

- [x] **Step 1:** Write the `buildSetupRule()` test. Assert `allowedEvmCalls` has exactly one entry, `${VAULT}/${RESCUE_SELECTOR}`, and `allowedDenoms` has no `erc20/*` (so the agent can't move tokens itself).
- [x] **Step 2:** Implement, then run `pnpm -F cli test`. Expected: PASS.
- [x] **Step 3:** Run for real on diana: `setup`, check with `fetchSpendingRules` and `fetchAuthenticators`, then `sign-withdraw` and `withdraw` 1 fUSD. Expected: tx success and the `to` balance grows by 1 fUSD. Record the hash in `docs/EVIDENCE.md`.
- [x] **Step 4:** Commit.

As built: fUSD/fETH/fBTC are our own `TestToken` faucet contracts (public `mint`), deployed by `DeployTokens.s.sol`; addresses come from `FUSD_ADDRESS`/`FETH_ADDRESS`/`FBTC_ADDRESS`. `setup` sends ONE hybrid tx (`openEvmWindowMsg` + link msgs, or only `MsgUpdateSpendingRules` when the agent key is linked, not revoked and not expired), then the three EVM approvals (an ECDSA tx cannot ride in the hybrid tx). Window `allowedTargets=[fUSD, fETH, fBTC, VAULT]`. `withdraw` is submitted by `RELAYER_MNEMONIC` (default: owner), which needs its own live window. The window stays open after setup (the Task 5 attack needs it); record that exposure in Task 7.

### Task 4: Guardian agent (Nov 26–27), DONE 2026-11-20

**Files:**
- Create: `apps/agent/src/rules.ts`, `watch.ts`, `rescue.ts`, `report.ts`, `server.ts`, `index.ts`
- Create: `apps/agent/test/rules.test.ts`, `apps/agent/test/report.test.ts`

**Interfaces:**
- Produces:
  - `type OutboundTx = { hash: Hex; block: bigint; token: Hex; to: Hex; amount: bigint }`.
  - `decide(tx: OutboundTx, policy: { allowlist: Hex[]; maxOutbound: bigint }): { rescue: boolean; reason: string }`.
  - `watchOwner(onTx)`: viem `watchContractEvent` for `Transfer(from=owner)` on the 3 tokens, plus outbound QOR txs via `watchBlocks`.
  - `rescueAll(): Promise<{ token: Hex; hash: string; amount: bigint }[]>`: for each token where the owner still has a balance > 0, call `buildPhantomExecuteEvm({ to: VAULT, data: rescue(token), nonce: fetchAuthNonce(...) })` and broadcast through the gas wallet.
  - `Incident = { id; detectedAt; trigger: OutboundTx; reason; rescues; summary; agentPubkey; sig }`.
  - `signIncident(i)` and `verifyIncident(i)` (ed25519 over canonical JSON without `sig`).
  - `GET /incidents` and `GET /events` (SSE).

- [x] **Step 1:** Write the `decide` tests:
  - `test_rescueOnUnknownRecipient`.
  - `test_noRescueForAllowlistedRecipient` (Review Focus 4).
  - `test_rescueOnAmountAboveMax`.
- [x] **Step 2:** Write the `rescueAll` test (mocked chain client): `test_skipsTokensWithZeroOwnerBalance` (Review Focus 1).
- [x] **Step 3:** Write the report tests: `test_signedIncidentVerifies`, `test_tamperedIncidentFails`, and `test_summaryFallbackWhenLLMFails` (an LLM error still produces a template summary).
- [x] **Step 4:** Implement. Run `pnpm -F agent test`. Expected: all PASS.
- [x] **Step 5:** Commit.

As built (Task 4D, 2026-11-20): the agent no longer rescues through the authenticator lane. On diana the lane now refuses a token move from the owner's account unless the token is listed in the spending rule, and listing it lets the agent key `transfer` it directly (`docs/EVIDENCE.md` "Task 4"). `GuardianVault` (v3, not yet deployed) takes `(owner, guardian)`: `rescue` is callable by the owner or the immutable `guardian` (`NotAuthorized` otherwise), with an unchanged body and message vector; `Deploy.s.sol` reads `GUARDIAN_ADDRESS`. The agent's `GAS_MNEMONIC` account is the guardian: `rescueAll` sends one plain EVM `vault.rescue(token)` tx per token (signed locally, sequential pending nonces, 120k gas, fee cap 150 gwei) and reads success and the moved amount from each receipt's `Rescued` logs; `window.ts` keeps the guardian's own EVM window (14400 blocks, 10 txs, budget sized at that same fee cap, vault as the only target) open with its hybrid signature, checked every 30 s with overlapping checks dropped. Proven on diana: v3 vault `0x7769…71e6`, guardian rescue of fETH + fBTC 4 blocks after a simulated drain (`docs/EVIDENCE.md` Task 4). A token whose balance/allowance read fails is recorded as a failed rescue (`expected` 0) and the others still go out, so even a queued recheck that only hit read errors produces an incident; that token is retried on the next trigger. At startup the agent checks the vault's `guardian()`. The owner's spending rule is back to `allowedDenoms=["uqor"]`, `allowedEvmCalls=[vault.rescue]`: the ed25519 key signs incidents and `pnpm cli agent-misuse` proves the chain refuses its direct token calls (Task 5 (b)).

### Task 5: Attacker + end-to-end `demo.sh` (Nov 28)

**Files:**
- Create: `apps/cli/src/attacker.ts`, `demo.sh`; append to `docs/EVIDENCE.md`

**Interfaces:**
- `pnpm cli attack`: uses **only** `OWNER_EVM_PRIVKEY` (the leaked ECDSA key) to send 3 transfers of 10 fUSD each to `ATTACKER_ADDR`, one block apart. Then it also tries:
  - (a) `withdraw` with a forged signature;
  - (b) `buildPhantomExecuteEvm` to `fUSD.transfer(attacker)` with the agent key (assuming the attacker also stole the agent key).

As built (5A, local code + unit tests only, 2026-11-20; the diana runs are 5B): every run uses a **fresh owner**. `pnpm cli fresh-owner` (`apps/cli/src/fresh.ts`) has the funder (`FUNDER_MNEMONIC`, default `OWNER_MNEMONIC`) send `FRESH_FUND_UQOR` (1.5 QOR) to a new mnemonic's account, which registers its ML-DSA-87 key with proof of possession in its own classically signed tx (`buildRegisterPqcKeyMsg` + `signProofOfPossession`; `ensurePqcRegistered` needs a cosmjs `TxClient`, which cannot sign for an eth_secp256k1 account), opens an unscoped 600-block/3-tx window, deploys `GuardianVault(owner, GUARDIAN_ADDRESS)` (950k gas), checks `owner()`/`guardian()` and mints 100 fUSD; `~/.config/qday/runs/<runId>/run.env` (0700/0600, never in the repo) holds the owner mnemonic with `RUN_COMPLETE=0` BEFORE the fund tx (so a failed run never loses the funded account; the run dir is printed on failure) and gains `VAULT_ADDRESS`, `ATTACKER_ADDR`, `SAFE_ADDR`, `RUN_COMPLETE=1` only when every step succeeded. The attacker uses `OWNER_MNEMONIC`'s ECDSA key (there is no `OWNER_EVM_PRIVKEY`), sends each 10 fUSD drain once the previous has a receipt (60k gas), and writes `attack.json`; (b) reuses `attemptAgentMisuse` from `misuse.ts`, relayed by the funder (`FUNDER_MNEMONIC`, never the guardian, whose nonce the rescues use). `pnpm cli demo-check` judges the run with the pure `evaluateRun`; "kept" counts the vault plus the 1 fUSD the recovery step already paid to `SAFE_ADDR`. `demo.sh` runs each run in its own process and always kills the agent's process group; `bash scripts/test-demo.sh` checks its flow offline with a stub `pnpm`. Agent latency: 300 ms polling (`POLL_MS`), the trigger's token rescued first, a 40 gwei tip (cap still 150 gwei), the guardian window reopened when it does not target the current vault, and `timing:` log lines (trigger block, detection time, rescue send time, receipt block).

- [ ] **Step 1:** Run `./demo.sh`: setup → fund 100 fUSD → start agent → attack → print blocks from detection to rescue and the percentage of value kept.
  Expected:
  - rescue ≤ 3 blocks, ≥ 80% kept;
  - (a) reverts with `BadSignature`;
  - (b) refused with "authenticator not permitted for this action".
- [ ] **Step 2:** Run 3 times in a row with fresh accounts. Expected: all 3 pass. Record the tx hashes in `EVIDENCE.md`.
- [ ] **Step 3:** Commit.

### Task 6: Dashboard (Nov 28–29)

**Files:**
- Create: `apps/dashboard/` (Vite React TS), with `src/panels/Status.tsx`, `Incidents.tsx`, `Recover.tsx`, `src/lib/verify.ts`, `src/lib/verify.test.ts`

**Interfaces:**
- Consumes: the agent's SSE `/events`, `evmWindowStatus`, `fetchSpendingRules`, `fetchAuthenticators`, and `verifyIncident` from core.
- Panels:
  - **Status:** window budget, agent rules, vault balance.
  - **Incidents:** incident timeline, each entry marked ✓ or ✗.
  - **Recover:** upload `withdrawal.json`, then submit through the QoreX EVM wallet.

- [ ] **Step 1:** Write `verify.test.ts`: `test_rejectsValidSigFromUnlinkedKey`. The pubkey must be in `fetchAuthenticators` and not revoked (Review Focus 5).
- [ ] **Step 2:** Implement. Run `pnpm -F dashboard test && pnpm -F dashboard build`. Expected: PASS and the build succeeds.
- [ ] **Step 3:** Run `demo.sh` with the dashboard open alongside. Expected: the incident appears on the dashboard within ≤ 5 seconds.
- [ ] **Step 4:** Commit.

**Scope cut if late:** drop the Recover panel and use the CLI `withdraw` instead.

### Task 7: Audit Stage 2 + submission (Nov 30 → Dec 2)

**Files:**
- Create: `docs/audit/stage2-YYYY-MM-DD.md`, `assets/cover-16x9.png`
- Finalise: `docs/AUDIT.md`, `docs/THREAT_MODEL.md`, `AI_USAGE.md`, `README.md`

- [ ] **Step 1:** Run QCAI Stage 2 on the final contract. Update the table in `AUDIT.md`: each Stage 1 finding is fixed, covered by a test, or explained.
- [ ] **Step 2:** Finalise `THREAT_MODEL.md` against the final code: EVM-window scope, the `approve(vault,0)` race, window budget as the only cap, a leaked agent key (the chain limits it to `rescue`), and the LLM having no authority.
- [ ] **Step 3:** Finish the README (run instructions, qor1/0x addresses) and `AI_USAGE.md`.
- [ ] **Step 4:** Record a video ≤ 3 minutes following the spec's 5-step script. Record a backup take before Dec 1.
- [ ] **Step 5:** Complete the project on build.qorechain.io: public repo, GitHub App installed, cover image, video, addresses, AI-native box ticked. Press "Check again". Expected: every item shows Verified.
