# Task 6F: Protect onboarding (sub-plan)

> Sub-plan of `docs/plans/2026-11-19-qday-guardian.md` Task 6F. Execute with superpowers:subagent-driven-development.

**Goal:** a self-serve Protect screen that takes the owner connected in MetaMask from "nothing" to "the Guardian
watches this account": connect, create the vault, approve tokens, turn on the Guardian (link + agent + gas tank),
trusted list, recovery address and alerts. Hybrid steps show a CLI command (6A gate); EVM steps sign in MetaMask.

**Spec:** `docs/specs/2026-11-19-qday-guardian-mvp.md` §2.3 "Protect" and §8.

**Approved departures (builder, 2026-11-23):**
- Step order: link the Guardian (and start the agent for this owner, fund the gas tank) BEFORE the trusted list,
  because `PUT /policy` writes only for the owner the running agent watches. Mockup order was trusted list first.
- The vault is deployed from MetaMask with the forge artifact's bytecode (`contracts/out`, so the dashboard build
  needs `forge build` first). A window with `allowedTargets` refuses contract creation (chain fact 10), so
  onboarding uses one UNSCOPED owner window opened by the CLI (`window open --onboard`).
- The diana run (Task 5) onboards a fresh owner from `pnpm cli fresh-owner --no-vault`, whose mnemonic the builder
  imports into MetaMask. The root owner and root `.env` stay untouched.

## Global Constraints

- Testnet `qorechain-diana` only, EVM chain id `9800`. Never commit a mnemonic, private key or `.env`.
- The agent key's rule is exactly `allowedEvmCalls=["<vault lowercase>/0x839006f2"]` (`RESCUE_SELECTOR`),
  `allowedDenoms=["uqor"]`, no `erc20/*` denom. `link` must send the same rule as `setup` (`buildSetupRule`).
- An authenticator key links to ONE account only (chain fact 14): a fresh owner uses its own `AGENT_ED25519_SK`.
- Against a leaked ECDSA key the EVM window budget is the only cap (chain fact 4). Every window the CLI opens is
  bounded in blocks, txs and `maxValue`; an unscoped window says so when it is opened.
- Tight gas limits (chain fact 5): vault deploy `950_000n` (`DEPLOY_GAS` in `apps/cli/src/fresh.ts`), `approve`
  `100_000n` (`APPROVE_GAS` in `apps/cli/src/setup.ts`), guardian top-up `50_000n` (`TOPUP_GAS` in the dashboard).
- `GuardianVault` constructor is `(address owner_, address guardian_)`; `owner` and `guardian` are immutable.
- CLI commands that sign refuse, BEFORE signing, when `--expect <0x>` is given and `OWNER_MNEMONIC` is another account
  (`checkExpectedOwner` in `apps/cli/src/window.ts`).
- The CLI logs addresses and tx hashes only, never a secret. Errors print the message only.
- Dashboard REST reads go through the `/qore-rest` proxy (`restBase()`), never `api-testnet.qore.host` directly
  (chain fact 18). EVM tx hashes are shown as copyable text, never explorer links (chain fact 19).
- Repo files, code comments and commits are in English. TDD: the failing test first.
- Commands: `pnpm -F cli test`, `pnpm -F cli typecheck`, `pnpm -F dashboard test`, `pnpm -F dashboard build`.

## Review Focus

1. `window open --onboard` opens a window with NO `allowedTargets`, bounded blocks/txs/`maxValue`, and never reads
   `VAULT_ADDRESS`; the scoped `window open` is unchanged.
2. `link` refuses before signing when the vault's on-chain `owner()` is not `OWNER_MNEMONIC`'s address, or its
   `guardian()` is not `GUARDIAN_ADDRESS` (when set), or `--expect` names another owner. It sends exactly the
   rule `setup` sends, and no window message.
3. The dashboard deploys only with the connected wallet as `owner_` and a guardian it shows first; after the deploy
   it reads `owner()`/`guardian()` back and refuses to remember a vault whose roles differ.
4. A step is shown done only from chain (or agent) reads, never from a click alone, except the optional trusted
   list review and the recovery address, which are local choices.

---

### Task 1: CLI `window open --onboard` (high tier)

**Files:** `apps/cli/src/window.ts`, `apps/cli/test/window.test.ts`, `apps/cli/src/index.ts` (usage text).

- [ ] **Step 1:** Failing tests in `window.test.ts`:
  - `parseWindowArgs(["open","--onboard"])` → `{action:"open", onboard:true, blocks:1800, txs:5, topupUqor:0n}`;
    `--onboard` combines with `--blocks`, `--txs`, `--topup`, `--expect`; a second `--onboard` and
    `close --onboard` throw. Without `--onboard`, `onboard` is `false` (existing tests keep passing).
  - `buildOnboardWindowParams(cosmos, {blocks, txs, topupUqor})` returns `{sender, blocks, maxTxs, maxValue}` with
    `maxValue = evmWindowCost({gas: 3_000_000n, maxFeePerGas: 112_500_000_000n}) * txs + topupUqor` (same per-tx
    budget as `buildOwnerWindowParams`) and NO `allowedTargets` key at all.
  - `runWindow(["open","--onboard"], env)` with an env that has `OWNER_MNEMONIC` but no `VAULT_ADDRESS` and no
    token addresses does not throw for a missing vault (make `runWindow` testable by injecting the broadcast and the
    status read the way the other CLI tests inject deps; follow the existing pattern in `apps/cli/test`).
- [ ] **Step 2:** Implement. `--onboard` default txs is `ONBOARD_WINDOW_TXS = 5` (1 vault deploy, 3 approvals,
  1 guardian top-up). The open line prints `window open (onboard, UNSCOPED: any target, N blocks, M txs[, top-up
  headroom X QOR]): <hash>` and then one warning line: `unscoped: until it expires or you run \`pnpm cli window close\`,
  a leaked ECDSA key can send any tx within this budget`. Update the usage text in `index.ts`.
- [ ] **Step 3:** `pnpm -F cli test && pnpm -F cli typecheck`. Expected: all pass. Commit
  `feat(cli): window open --onboard opens an unscoped onboarding window (Task 6F)`.

### Task 2: CLI `link` and `fresh-owner --no-vault` (high tier)

**Files:** `apps/cli/src/setup.ts`, new `apps/cli/src/link.ts`, `apps/cli/src/fresh.ts`, `apps/cli/src/index.ts`,
`demo.sh`, tests `apps/cli/test/link.test.ts`, `setup.test.ts`, `fresh.test.ts`, `scripts/test-demo.sh` if it covers
`--resume`.

- [ ] **Step 1:** Failing tests:
  - `link.test.ts`: `checkLinkTarget({owner, guardian}, {owner, guardian?})` throws when the vault's `owner()` differs
    from the signer's EVM address (message names both), when `GUARDIAN_ADDRESS` is set and `guardian()` differs,
    and passes otherwise (case-insensitive). `runLink` (deps injected) refuses with `--expect` naming another owner
    BEFORE any broadcast or chain read of the vault; refuses when the vault has no code; on success broadcasts ONE
    hybrid tx whose messages are exactly `selectLinkMsgs(linkAuthenticatorMsgs(...))` (no `MsgOpenEVMWindow`) and
    whose spending rule equals `buildSetupRule(vault)`.
  - `setup.test.ts`: `setup` and `link` build their link messages through the same exported helper
    (`buildGuardianLinkMsgs`), so the rule cannot drift.
  - `fresh.test.ts`: with `noVault: true`, `freshOwner` funds, registers, opens the deploy window and mints 100 fUSD,
    never calls `deployVault`/`readRoles`, does not require `GUARDIAN_ADDRESS`, and writes a complete `run.env`
    (`RUN_COMPLETE="1"`, `ATTACKER_ADDR`, `SAFE_ADDR`) WITHOUT `VAULT_ADDRESS`; it prints `RUN_ENV=` and a next-step
    line naming the Protect screen (`http://127.0.0.1:5173/#/protect`) and that `OWNER_MNEMONIC` in that run.env is
    what MetaMask imports (never the mnemonic itself).
- [ ] **Step 2:** Implement:
  - `buildGuardianLinkMsgs(owner: UnifiedAccount, vault, agent, existing, nowUnix?)` in `setup.ts`, extracted from
    `runSetup`, which keeps its behaviour.
  - `pnpm cli link [--expect 0xOWNER]` in `link.ts`: env `OWNER_MNEMONIC`, `VAULT_ADDRESS`, `AGENT_ED25519_SK`,
    optional `GUARDIAN_ADDRESS`. Order: parse args → derive owner → `checkExpectedOwner` → vault code check →
    read `owner()`/`guardian()` → `checkLinkTarget` → fetch authenticators → broadcast `qday: link guardian` →
    print `link (<n> msg): <hash>` → informational read of the first enabled spending rule (a REST failure is
    printed, not thrown).
  - `pnpm cli fresh-owner [--no-vault]`: `freshOwner(env, deps, {noVault})`.
  - `demo.sh --resume` refuses a run.env without a `VAULT_ADDRESS=` line with the message
    `refusing --resume: <file> has no VAULT_ADDRESS (a --no-vault run is onboarded from the dashboard's Protect screen)`.
  - Usage text in `index.ts` for both.
- [ ] **Step 3:** `pnpm -F cli test && pnpm -F cli typecheck` (and `bash scripts/test-demo.sh` if it exists).
  Expected: all pass. Commit `feat(cli): link command and fresh-owner --no-vault for browser onboarding (Task 6F)`.

### Task 3: Dashboard Protect logic (lib, TDD)

**Files:** new `apps/dashboard/src/lib/protect.ts`, `protect.test.ts`, new `apps/dashboard/src/lib/vaultArtifact.ts`
(+ test), `apps/dashboard/src/lib/actions.ts` (export the window blocker helper), `vite.config.ts`/`tsconfig.json`
only if the artifact import needs it.

Pure functions only; the UI (Task 4) calls them with chain and agent reads.

- [ ] **Step 1:** Failing tests:
  - `vaultArtifact.test.ts`: the forge artifact `contracts/out/GuardianVault.sol/GuardianVault.json` loads through
    `vaultArtifact.ts` (Vite JSON import), has a `constructor(address,address)` and `0x` creation bytecode;
    `parseVaultArtifact` throws on a wrong constructor or missing bytecode (same checks as `loadVaultArtifact` in
    `apps/cli/src/fresh.ts`).
  - `protect.test.ts`, step derivation `protectSteps(input)` → 6 steps `{id, state: "done"|"current"|"todo"|"blocked",
    detail}` with ids `connect, vault, approve, guardian, trusted, recovery` (in that order; the first not-done step is
    `current`, later ones `todo`):
    - `connect` done when a wallet is connected on chain 9800 and its PQC key is registered with possession proven;
      not registered → blocked with the hint `pnpm cli fresh-owner --no-vault` (a demo owner) in `detail`.
    - `vault` done only when a vault address is known AND its on-chain `owner()` equals the wallet AND `guardian()`
      equals the expected guardian (case-insensitive); a known vault with other roles is blocked, naming both.
    - `approve` done when the allowance of each of fUSD, fETH, fBTC from the wallet to the vault is `maxUint256`.
    - `guardian` done when (a) an authenticator is linked, not revoked, not expiring within 60 s, (b) the first
      enabled spending rule has exactly `allowedEvmCalls=["<vault lowercase>/0x839006f2"]` and
      `allowedDenoms=["uqor"]`, (c) the agent is online and its `/config` names this owner and vault with the
      on-chain check ok, and (d) `/health` gas is not low. Each missing part is listed in `detail`.
    - `trusted` done when the policy has at least one entry or the owner marked the list reviewed.
    - `recovery` done when a recovery address is saved; `validateRecovery(addr, {owner, vault, guardian})` refuses a
      non-address and any of those three (case-insensitive).
  - Commands `protectCommands(owner, vault)`: `pnpm cli window open --onboard --expect <owner>`,
    `pnpm cli link --expect <owner>` and `pnpm agent`, each with a one-line env note (`OWNER_MNEMONIC` and
    `AGENT_ED25519_SK` of this owner, `VAULT_ADDRESS=<vault>`); `pnpm cli sign-withdraw <recovery> fUSD <amount>`.
  - Planners `planDeploy` and `planApprove(tokens)` return `{cost, blockers, command}` like `planRescueNow`:
    deploy is blocked unless the owner window is live AND unscoped (`allowedTargets` empty) with ≥ 1 tx and budget
    for `950_000n` gas at the read `maxFeePerGas`; approvals need ≥ n txs and budget for `n × 100_000n` gas, and the
    tokens as targets when the window is scoped. A closed or too-small window yields the `--onboard` command.
  - Per-owner local storage helpers (`loadProtectState`/`saveProtectState`, key `qday.protect.v1.<owner lowercase>`,
    fields `vault`, `recovery`, `trustedReviewed`), tolerant of missing/blocked storage and of malformed JSON.
- [ ] **Step 2:** Implement. Reuse `senderBlockers` from `actions.ts` (export it; Rescue now and top-up keep their
  behaviour and tests).
- [ ] **Step 3:** `pnpm -F dashboard test && pnpm -F dashboard build`. Expected: all pass. Commit
  `feat(dashboard): Protect step logic, vault artifact and onboarding planners (Task 6F)`.

### Task 4: Dashboard Protect screen (UI)

**Files:** new `apps/dashboard/src/screens/Protect.tsx`, `apps/dashboard/src/App.tsx` (nav: Protect becomes a link,
route `#/protect`), possibly a `TrustedEditor` component extracted from `Rules.tsx`, `Recover.tsx` (recovery note),
`styles.css`.

- [ ] **Step 1:** Screen per the mockup layout (step list left, current step card right; mockup source:
  `Protect.dc.html` in the design canvas, layout and copy only, not its QoreX wording): driven by the connected
  wallet (`WalletConnect`), not by the agent's `/config`.
  - Connect: wallet, chain, PQC status, QOR balance.
  - Create vault: the guardian address (from the agent's `/config`, shown before signing; no config → blocked:
    "start the agent"), the onboarding window command when `planDeploy` is blocked, "Deploy vault" in MetaMask
    (`deployContract`, gas `950_000n`, fees from `readFees`), then read `owner()`/`guardian()` and save the vault only
    if they match; an "I already have a vault" address field checked the same way.
  - Approve: each token's balance and allowance, "Approve N tokens" in MetaMask (`approve(vault, maxUint256)`, gas
    `100_000n`), one tx per token not yet at `maxUint256`.
  - Turn on the Guardian: the rule it will get (read only), the `link` and `pnpm agent` commands with their env notes,
    live status of each part, then the existing `GasTank` once the agent serves this owner.
  - Trusted list: the trusted wallets/apps editor from Rules (extract, do not copy), plus "Continue without".
  - Recovery and alerts: recovery address (saved locally, checked by `validateRecovery`), the `sign-withdraw` command
    using it, alert channels from `/health` (read only, as in Rules).
  - Done: "You're protected" with links to Overview and Recover.
  - Recover shows a warning when the loaded withdrawal's `to` differs from the saved recovery address.
- [ ] **Step 2:** `pnpm -F dashboard test && pnpm -F dashboard build`; open the screen with `pnpm -F dashboard dev`
  and check it renders with and without a wallet. Commit `feat(dashboard): Protect onboarding screen (Task 6F)`.

### Task 5: On diana (controller + builder, not a subagent)

- [ ] **Step 1:** `pnpm cli fresh-owner --no-vault`; the builder imports its mnemonic into MetaMask; onboard it from
  `#/protect` (window `--onboard`, deploy, approvals, `link`, agent, top-up, trusted list, recovery).
- [ ] **Step 2:** `pnpm cli window open --expect <owner>` (scoped, for the attack), `pnpm cli attack`,
  `pnpm cli demo-check --wait 60`. Expected: PASS. Record every hash in `docs/EVIDENCE.md`.
- [ ] **Step 3:** Update `docs/THREAT_MODEL.md` (the unscoped onboarding window), `AI_USAGE.md`, CLAUDE.md commands,
  tick the main plan's 6F, commit.
