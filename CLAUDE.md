# Q-Day Guardian

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
7. The authenticator lane executes `MsgExecuteEVM` FROM the owner's EVM address: `msg.sender` == owner,
   so `GuardianVault.rescue` is owner-only and the agent still passes (tx `52B81C08…`, 2026-11-20).
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

SDK names that exist in `@qorechain/sdk@0.14.0`: `deriveUnifiedAccount`, `pqcSign`, `EthNativeSigner`,
`linkAuthenticatorMsgs`, `signAuthenticatorLinkEd25519`, `revokeAuthenticatorMsg`,
`buildPhantomExecuteEvm`, `fetchAuthNonce`, `fetchSpendingRules`, `fetchAuthenticators`,
`decodeAuthenticatorExecutions`, `resolveEvmAuthDigestVersion`, `openEvmWindowMsg`,
`closeEvmWindowMsg`, `fetchPqcStatus`. Check typings before using anything else. Working references:
`spike/probe/probe.mjs` and `spike/workshop/workshop-2/`.

## Session notes
- Commands the user runs with `!` start in the session's current directory, which may not be the repo
  root. Give them with absolute paths (`cd /Users/vanhuy/Desktop/Quantum && ...`).
- Diana deploy: `cd contracts && set -a && . ../.env && set +a && forge script script/Deploy.s.sol --rpc-url diana [--broadcast]`.
  The owner's EVM window must be open (`spike/probe`: `node probe.mjs window-open 600 3`).

## Hard rules
- Testnet only. Never commit mnemonics, private keys or `.env`. Keys live in `spike/.keys/` or
  `~/.config/qday/`, never in the repo.
- The LLM **never** decides to move funds. Only `apps/agent/src/rules.ts` does. The LLM only writes
  the incident summary, with a template fallback.
- The agent's rule is exactly `allowedEvmCalls=["<vault>/<rescue selector>"]`,
  `allowedDenoms=["uqor"]`, with no `erc20/*` denoms, so the agent can't move tokens directly.
- `GuardianVault`: `owner` is immutable, there are no setters, the nonce is bumped before any
  external call, and the signed message binds tag, chainId, vault, to, token, amount and nonce.
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
