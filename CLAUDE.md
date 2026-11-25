# Q-Lifeboat (formerly Q-Day Guardian)

AI agent that rescues a QoreChain account's EVM-lane assets into an ML-DSA-87-locked vault when the
account's classical (ECDSA) key leaks. Entry for **QoreChain Build Before Q-Day**, category
**Post-Quantum AI Agents** (+ Best AI-Native). Solo builder. Testnet `qorechain-diana` only.

- Spec: `docs/specs/2026-11-19-qday-guardian-mvp.md`, the source of truth for scope.
- Plan: `docs/plans/2026-11-19-qday-guardian.md`. Work task by task, tick the checkboxes.
- Deadline **2026-12-02 23:59 UTC**. Feature freeze **2026-11-30**. Cut scope per the plan, never the deadline.

## Language
- Talk to the user in **Vietnamese**.
- Every file in the repo (spec, plan, README, AI_USAGE, docs, code comments, commits) is in **English**.

## Layout (target, see plan)
```
contracts/        Foundry: GuardianVault.sol, tests, mocks, Deploy.s.sol
packages/core/    shared config, accounts, withdrawalMessage (byte-identical to Solidity)
apps/agent/       rules · watch · rescue · report · server (SSE)
apps/cli/         setup · signer · withdraw · attacker
apps/dashboard/   Vite + React
docs/             specs/, plans/, audit/, AUDIT.md, THREAT_MODEL.md, EVIDENCE.md
spike/            THROWAWAY Task 0 probes + workshop clone. Gitignored. Never import from it.
```

## Commands
- Contracts: `cd contracts && forge test -vv`
- TS workspaces: `pnpm -F <core|agent|cli|dashboard> test`
- E2E: `./demo.sh` (must pass 3 runs in a row from fresh accounts)
- CLI (diana, reads root `.env`): `pnpm cli status | setup | sign-withdraw <to> <fUSD|fETH|fBTC|QOR|0x…> <amount> | withdraw <file>`
- Turn off protection (Task 6E step 4): dashboard Rules → "Turn off protection" (revoke allowances via MetaMask), then
  `pnpm cli unlink --expect <0x>` (revokes the Guardian's key; hybrid), then stop the agent. Turn back on: Protect (approve + `pnpm cli link`).
- Browser onboarding (Task 6F): `pnpm cli fresh-owner --no-vault`, `pnpm cli window open --onboard [--topup QOR] --expect <0x>`
  (UNSCOPED, for the MetaMask vault deploy), `pnpm cli link --expect <0x>` (run.env loaded + `VAULT_ADDRESS` exported).
- The dashboard imports the forge artifact: run `cd contracts && forge build` before `pnpm -F dashboard build|test|dev`.
- Approval phishing demo (Task 7): `./demo.sh --phish [--drainer-delay N]` (fresh owner, its own agent on :8787: stop `pnpm agent`
  first). The drainer is FUNDER_MNEMONIC's account in its own fUSD-scoped window; `phish.json` in the run dir. Same-block drainers can win.
- Fire drill (Task 6G): `pnpm cli drill-guardian init` (once, idempotent: separate drill guardian in `~/.config/qday/drill-guardian.env`,
  topped up to 2 QOR) and `pnpm cli drill-guardian check` (read-only, needs >= 0.5 QOR). Then `pnpm agent` + dashboard `#/drill` "Run drill",
  or `./demo.sh --drill` from a terminal (needs `FUNDER_MNEMONIC`, drill agent on `DRILL_AGENT_PORT` default 8788, one drill at a time).

Run the real command and read its output before claiming anything passes.

## Workflow per task
```
Explore → Plan (+ verify command, failing test first) → [user approves]
  → Implement ⇄ Verify (local + on-chain, max 3 loops)
  → Review (fresh context, against Review Focus) ⇄ Implement
  → Record → Ship (commit; push only when asked)
```
Execute plan tasks with `superpowers:subagent-driven-development`. Run `/clear` between tasks: the plan
checkboxes and the docs below are the handoff state, not the chat history.

**Risk tiers** decide how much of the loop runs:
- **High**: `contracts/`, `packages/core` message encoding, `apps/agent/src/rules.ts` and `rescue.ts`,
  `apps/cli` setup/signer/withdraw, and anything that signs or broadcasts on diana. Run every step.
- **Low**: dashboard UI, docs, README, styling. Implement → Verify → Ship. Skip the independent review.

1. **Explore**: read the task in the plan, the spec section it implements, the chain facts above and
   the `docs/EVIDENCE.md` entries it depends on. Check `@qorechain/sdk` typings before using any API.
   Do not write code in this step.
2. **Plan**: list the files to touch, the failing tests to write first, and the exact verify command
   with its expected output. The plan document already holds this for most tasks. Confirm it still
   holds, or flag the gap. Stop for user approval if the approach departs from the plan.
3. **Implement**: TDD. Write the failing test, run it and see it fail for the right reason, then write
   the minimum code to pass.
4. **Verify**: two layers.
   - Local: the task's `forge test` / `pnpm -F <ws> test` command, run fresh, output read in full.
   - On-chain (any change that touches diana): the claim counts only with a real tx hash on diana.
     Mocks such as `MockPqc` can disagree with the chain.
   On failure, use `superpowers:systematic-debugging`. Do not patch and retry blindly. **After 3 failed
   loops on the same problem, stop** and report to the user what was tried and what was observed.
5. **Review** (high tier): an independent reviewer in a fresh context (the subagent reviewers in
   subagent-driven-development, or `/code-review`). Check against the spec, the Hard rules below and
   the plan's **Review Focus** items. The author's explanations are not inputs. Findings loop back to
   Implement. Contract changes also go through QCAI (Stage 1 in Task 2, Stage 2 in Task 7).
6. **Record**: update the files listed under "Keep these files current". If a new chain fact turned
   up, or the user had to correct a mistake, add it to this file so the next session doesn't repeat it.
7. **Ship**: tick the plan checkboxes and commit without asking, but only once Verify (and Review, for
   the high tier) has passed. Report the commit hash with the verify output. **Never push** and never
   run `forge script` (deploy/broadcast) without asking the user first.

## Network (diana)
| | |
|---|---|
| Chain ID / EVM chain ID | `qorechain-diana` / `9800` |
| REST / RPC / EVM RPC | `https://api-testnet.qore.host` · `https://rpc-testnet.qore.host` · `https://evm-testnet.qore.host` |
| `pqcVerify` / `pqcKeyStatus` | `0x0000000000000000000000000000000000000a01` / `…0a02` (lowercase in Solidity) |
| Faucet (web only, 1 claim / 24 h) | https://dashboard.qorechain.io/faucet |
| Explorer | https://explore.qore.network |

## Chain facts verified on diana (spike, 2026-11-19, see docs/EVIDENCE.md)
1. `allowedEvmCalls` entries `"0x<target>/0x<selector>"` restrict a linked key to that exact function.
   Other selectors/contracts → "authenticator not permitted for this action".
2. **Changed on 2026-11-20** (held at `52B81C08…`, refused at `8508B568…`): a token move FROM the account
   made inside an allowed call (`transferFrom` in `rescue`) is refused unless the token is listed as
   `erc20/<addr>` in `allowedDenoms`. The authenticator lane can no longer sweep unlisted tokens.
3. The authenticator lane (`MsgExecuteEVM` via `buildPhantomExecuteEvm`) works with the owner's
   EVM window **closed**.
4. Spending rules do **not** bind the owner's own ECDSA key. Against an attacker holding that key,
   the **EVM window budget is the only cap**.
5. EVM receipts report at least 50% of the gas limit as `gasUsed` (withdraw: 500000 of 1M; the vault
   deploy: 675529 of 878187), so set tight gas limits.
6. QoreX refuses `signArbitrary`, so ML-DSA signatures for `withdraw` come from the local Guardian
   Signer (`pqcSign`), not the wallet.
7. The authenticator lane executes `MsgExecuteEVM` FROM the owner's EVM address: `msg.sender` == owner
   (tx `52B81C08…`, 2026-11-20). Since fact 2 the agent no longer rescues through that lane: `GuardianVault`
   v3 lets the owner OR an immutable `guardian` (the agent's `GAS_MNEMONIC` account) call `rescue`, and the
   agent sends plain EVM txs from its own window.
8. Spending rules live on the ACCOUNT, not on a key. `MsgUpdateSpendingRules` (`linkAuthenticatorMsgs(...)[0]`)
   replaces them wholesale; the first enabled rule applies. Retarget the agent without re-registering it.
9. From chain v3.2.8 a failed `MsgExecuteEVM` (revert, policy) burns the auth nonce and returns
   `success=false` inside a SUCCESSFUL tx. Read results with `decodeAuthenticatorExecutions`, never the tx code.
10. `MsgOpenEVMWindow` while an earlier window is still unexpired (even exhausted) is accepted and replaces
    it (tx `2659F7BE…`, 2026-11-20). A window with `allowedTargets` refuses contract creation, so deploys
    need an unscoped window; size `maxTxs` for every tx a `forge script` sends (DeployTokens = 6).
11. `EthNativeSigner` in sdk 0.14.0 has no `simulate()`: the spike's `signer.simulate?.()` was a no-op.
    `apps/cli/src/chain.ts` uses a fixed 1.5M gas limit for hybrid txs.
12. Listing a token as `erc20/<addr>` lets the linked key call that token's `transfer`/`approve` DIRECTLY,
    whatever `allowedEvmCalls` says (tx `CADB1412…`). `denomLimits` only caps the amount. So never list a
    token the agent must not be able to move. With `allowedDenoms=["uqor"]` a direct token call is refused
    (tx `7E9B629F…`).
13. Several `MsgExecuteEVM` with auth nonces n, n+1… in ONE cosmos tx are accepted and each decodes
    separately (tx `8508B568…`). `eth_getLogs` with an indexed-topic filter works on diana.
14. An authenticator (ed25519) key can be linked to ONE account only: linking it to a second account is
    refused with "authenticator key already bound to another account" (tx `422FE489…`, 2026-11-20). Each
    fresh demo owner gets its own agent key (`AGENT_ED25519_SK` in its run.env).
15. A brand-new account can register its ML-DSA-87 key with a classically signed `MsgRegisterPQCKeyV2`
    (tx `A665D9CB…`). Until its first link, the abstractaccount REST answers HTTP 404 "account … not found"
    for `authenticators`/spending rules (`auth_nonce` answers 200); treat that exact 404 as "none".

16. Wallets (Task 6A, 2026-11-21): the builder's QoreX build offers mainnet (`qorechain-vladi`) only; every
    `signAndBroadcast` for diana is refused "chain qorechain-diana does not match the active network". Its EVM
    account (`0xa88D…`) differs from its native account (`0x4b86…`). It declares `signDirectAddsPqcLayer` and
    `signArbitrary`, newer than `@qorechain/qorex-types@0.1.0`. `@qorechain/react` has no hybrid signing path.
17. MetaMask (owner mnemonic imported, same `m/44'/60'/0'/0/0` address as `deriveUnifiedAccount`) signs the
    owner's EVM txs on diana inside an open window (`approve` `0xf6fc5775…`, QOR to guardian `0x65282be0…`,
    `vault.rescue` `0xb4119a4c…`). With no window, EVERY account is refused at broadcast ("no open EVM
    authorisation window"), no hash and no gas. `wallet_addEthereumChain` for 9800 works. Hybrid txs (window,
    link) still need the CLI.
18. diana's REST (`api-testnet.qore.host`) sends NO CORS headers (OPTIONS → 501), even for Origin
    `https://dashboard.qorechain.io`; the EVM RPC sends `Access-Control-Allow-Origin: *` (2026-11-21). Browser code
    reads REST through the dashboard's same-origin Vite proxy `/qore-rest` (dev and preview).
19. The diana explorer (`explore.qore.network`) shows Cosmos-lane txs only: `/tx/0x<EVM hash>` fails "encoding/hex: invalid
    byte 'x'" and the hash without `0x` is "tx not found" (2026-11-23). Never link an EVM tx hash to it; show the hash and
    check its receipt on the EVM RPC. A window's `maxValue` bounds value PLUS each tx's gas limit × fee cap (uqor), so a
    QOR send needs headroom: `pnpm cli window open --topup <QOR>`.
20. MetaMask deploys a contract (GuardianVault, gasUsed 725168 of 950000) inside an owner window opened with NO `allowedTargets`
    (`0x469bba2a…`, 2026-11-23). A window whose txs are used up shows closed ("used up its txs"), like an expired one.
21. `MsgRevokeAuthenticator` (`pnpm cli unlink`) disables a linked key at once (`revoked: true`). Re-linking the SAME revoked key to
    the SAME account is accepted and makes it live again with a new expiry (tx `D06BA5BD…`, 2026-11-24), so turning protection back
    on needs no new agent key. A hybrid tx costs the signer 0.225 QOR of fees: a demo owner that spent its funding cannot send one.

22. diana's Tendermint RPC (`rpc-testnet.qore.host`) sends NO CORS headers either (2026-11-25): browser code broadcasts through a
    same-origin `/qore-rpc` proxy, like `/qore-rest`.
23. A browser page can run the whole hybrid flow (Task 9 spike, 2026-11-25): `unifiedAccountFromSeed(seed, { recoveryCode })` gives an
    account whose ML-DSA-87 key comes from a `QRC1-…` code, independent of the classical key; it registers with a classical
    `MsgRegisterPQCKeyV2` (`A99A9932…`, possession proven), then window + link go in ONE hybrid tx (`27B2E8FC…`), and a viem
    local-account EVM tx lands in that window. A window sized to exactly its txs shows `live: false` once they are used.

SDK names that exist in `@qorechain/sdk@0.14.0`: `unifiedAccountFromSeed`, `generatePqcRecoveryCode`, `pqcKeyFromRecoveryCode`,
`normalizeRecoveryCode`, `pqcVerify`, `generatePqcKeypair`, `signProofOfPossession`, `buildRegisterPqcKeyMsg`, `deriveUnifiedAccount`, `pqcSign`, `EthNativeSigner`,
`linkAuthenticatorMsgs`, `signAuthenticatorLinkEd25519`, `revokeAuthenticatorMsg`,
`buildPhantomExecuteEvm`, `fetchAuthNonce`, `fetchSpendingRules`, `fetchAuthenticators`,
`decodeAuthenticatorExecutions`, `resolveEvmAuthDigestVersion`, `openEvmWindowMsg`,
`closeEvmWindowMsg`, `fetchPqcStatus`. `@qorechain/qoresign@0.2.0` (agent + dashboard): `classicalKeyFromPrivate(pk,
"eth_secp256k1")`, `signMessage`, `verifyMessage`, and `verifyMessageWithChain` from `@qorechain/qoresign/network`. Check typings before using anything else. Working references:
`spike/probe/probe.mjs` and `spike/workshop/workshop-2/`.

## Session notes
- Commands the user runs with `!` start in the session's current directory, which may not be the repo
  root. Give them with absolute paths (`cd /Users/vanhuy/Desktop/Quantum && ...`).
- Diana deploy: `cd contracts && set -a && . ../.env && set +a && forge script script/Deploy.s.sol --rpc-url diana [--broadcast]`.
  The owner's EVM window must be open (`spike/probe`: `node probe.mjs window-open 600 3`).

- viem's `publicClient` caches `eth_blockNumber` for 4 s when the chain has no `blockTime`. Latency-critical
  reads (the agent's watcher) pass `cacheTime: 0` and batch tip + logs in one request (`apps/agent/src/rpc.ts`).
- Owner windows of 600 blocks last ~14 min (1.4 s blocks): when the builder clicks MetaMask txs by hand, open
  1800 blocks (`pnpm cli window open` defaults to 1800 blocks, 5 txs).
- `FUNDER_MNEMONIC` in root `.env` is the builder's wallet (82.9 QOR on 2026-11-25) (`qor14zxae5…`, `0xa88D…`): its SDK-derived ML-DSA
  key matches the registered one, so the CLI signs hybrid for it. `spike/probe/fund.mjs check|send` moves QOR.
- `./demo.sh --runs 3` needs ~2 QOR per run in the funder (root `OWNER_MNEMONIC`) and ~0.25 QOR per run in the
  guardian (`GAS_MNEMONIC`). `./demo.sh --resume <run.env>` finishes a funded run whose later step failed.

- Owner EVM window from the CLI (Task 6D): `pnpm cli window open [--blocks N] [--txs N] [--expect <0x owner>]` and
  `pnpm cli window close [--expect <0x owner>]` sign for `OWNER_MNEMONIC`; for a demo owner load its run.env first.
  Dashboard: `pnpm -F dashboard dev` (127.0.0.1:5173) against the agent on :8787 (`GET /config`). `./demo.sh` starts
  its own agent on :8787: do not run `pnpm agent` alongside it.
- Agent alerts (Task 6C): `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` in root `.env` (the builder's bot; chat id from
  `getUpdates`). The agent's API on :8787 serves `/incidents`, `/events`, `/health`, `/config` and `/policy` (policy in
  `data/policy-<owner>.json`, writes from loopback + dashboard origin only). Demo run logs in `~/.config/qday/runs/`
  are not readable from this session: ask the builder for what they show.
- The root owner's agent key is linked until 2026-12-24 13:51 UTC (30-day TTL, renewed 2026-11-24). `pnpm cli link` does not renew a
  live key: renew with `pnpm cli unlink --expect <0x>` then `pnpm cli link --expect <0x>` (chain fact 21).
- One drill costs the funder ~1.5 QOR + fees and the drill guardian ~0.47 QOR (2026-11-24, run `20261124T081242Z`). The drill's
  incidents live in its run dir, never in `data/incidents.jsonl`; `GET /drill/runs` reads `verdict.json` only.

## Hard rules
- Testnet only. Never commit mnemonics, private keys or `.env`. Keys live in `spike/.keys/` or
  `~/.config/qday/`, never in the repo.
- The LLM **never** decides to move funds. Only `apps/agent/src/rules.ts` does. The LLM only writes
  the incident summary, with a template fallback.
- The agent's rule is exactly `allowedEvmCalls=["<vault>/<rescue selector>"]`,
  `allowedDenoms=["uqor"]`, with no `erc20/*` denoms, so the agent can't move tokens directly.
- `GuardianVault`: `owner` and `guardian` are immutable, there are no setters, only the owner or the
  guardian may call `rescue` (which only moves owner → vault), the nonce is bumped before any external
  call, and the signed message binds tag, chainId, vault, to, token, amount and nonce.
- License MIT. Credit `qorechain/build-before-qday` (workshop-2 vault + agent patterns) and every
  kit used in the README.
- TDD: failing test first. Any message encoding change must keep the shared TS↔Solidity test vector green.
- Commits are pre-approved after Verify/Review pass (see Ship above). Push and `forge script` always
  need the user's go-ahead.

## Keep these files current as you go
- `docs/EVIDENCE.md`: every testnet tx that proves a claim (hash + what it proves).
- `AI_USAGE.md`: what AI did in each task (needed for the Best AI-Native award).
- `docs/AUDIT.md`: QCAI Stage 1/2 findings → fix/test/explanation.
- `docs/THREAT_MODEL.md`: update when a chain fact or design choice changes.
