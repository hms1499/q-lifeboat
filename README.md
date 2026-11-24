# Q-Lifeboat

> Entry for QoreChain *Build Before Q-Day*, category **Post-Quantum AI Agents**.
> Testnet `qorechain-diana` only. Test tokens have no value.

**An AI agent that, when an owner's ECDSA key leaks during an open EVM window, sweeps their ERC-20 tokens into a vault that
only opens with the owner's ML-DSA-87 (post-quantum) key.**

When an account's classical ECDSA key leaks, anything it can reach on the EVM lane is at risk while its EVM window is open.
**Q-Lifeboat** spots the drain (a transfer to an address the owner doesn't trust, or an approval to an untrusted spender) and
sweeps the approved ERC-20s that are left into a `GuardianVault`, which only releases funds with the owner's **ML-DSA-87**
signature. Fixed rules decide every rescue; the AI only writes the signed incident report. QOR on the EVM lane is not swept:
the window's budget caps it.

The agent itself is boxed in. Its own account is the vault's immutable `guardian`, which may call **one function**
(`GuardianVault.rescue`), inside an EVM window that targets only the vault. Its linked ed25519 key may call only
`vault.rescue` and move no tokens. Even stolen agent keys can only move the owner's funds *to safety*.

## How it works

```
 attacker (leaked ECDSA key, or a phished approval) ──▶ owner's tokens on the EVM lane
                                              │  watched every block (Transfer + Approval logs)
                                              ▼
 Guardian agent: fixed rules decide (apps/agent/src/rules.ts); the LLM only writes the report
        │ vault.rescue(token) from the guardian account: pulls owner → vault
        ▼
 GuardianVault ──withdraw only with an ML-DSA-87 signature (pqcVerify 0x…0a01)──▶ owner's new safe address
```

| Piece | What it does |
|---|---|
| `contracts/` | `GuardianVault.sol`: `rescue(token)` (owner or immutable guardian only, owner → vault only), `withdraw(...)` gated by `pqcKeyStatus` + `pqcVerify`, nonce bound in the signed message |
| `packages/core/` | Shared config, accounts and the withdrawal message (byte-identical to Solidity, shared test vector) |
| `apps/agent/` | Watches the owner, decides with fixed rules, rescues, publishes an ed25519-signed incident report (LLM summary, template fallback), Telegram/webhook alerts, local API for the dashboard |
| `apps/cli/` | `setup`, `link`/`unlink`, `window open/close`, `sign-withdraw` (local Guardian Signer, ML-DSA-87), `withdraw`, and the demo: `fresh-owner`, `attack`, `phish`, `demo-check` |
| `apps/dashboard/` | Overview (exposure, the waterline of account vs vault), Incidents (each report verified in the browser against the chain), Recover, Protect (onboarding), Rules (trusted list, threshold, turn off protection), Fire drill |

## Honest limits

Q-Lifeboat reacts to what lands on chain; it does not see the mempool.

- **A one-shot drain is not stopped.** A `transfer` of the whole balance in one tx inside an open owner window is final before
  the Guardian sees it: the window's `maxValue` bounds QOR and gas, not tokens, and spending rules do not bind the owner's own
  key. The real defence is a **closed EVM window by default** (with no window a leaked ECDSA key moves nothing). The Guardian
  covers the time a window is open, a drain spread over several txs, and the gap between an `approve` and its `transferFrom`.
- **A drainer as fast as the Guardian wins the approval race.** On diana the rescue lands 1-2 blocks after a phished approval
  (~1.4 s blocks). A drainer that waits 2 blocks got nothing (3/3 runs). One that pulls the moment it sees the approval won 1 of
  2, and lost the other only on the rescue's higher tip in a shared block
  ([evidence](docs/EVIDENCE.md#task-7-approval-phishing-race-on-diana-2026-11-24)).
- **The agent runs on the owner's machine.** While it is stopped nothing watches ("Rescue now" on the dashboard is the manual
  fallback).

Roadmap: mempool front-running where the chain exposes pending txs, a hosted agent, and a withdrawal timelock on the vault.
Details in the [threat model](docs/THREAT_MODEL.md#honest-limits).

## QoreChain features used

Hybrid secp256k1 + ML-DSA-87 transactions · scoped EVM windows (`allowedTargets`, `maxTxs`, `maxValue`) · authenticator lane
with spending rules (`allowedEvmCalls`, `allowedDenoms`, per-tx/daily limits, expiry) and `MsgRevokeAuthenticator` ·
`pqcVerify` / `pqcKeyStatus` precompiles · classical bootstrap of an ML-DSA-87 key (`MsgRegisterPQCKeyV2`) · two-stage QCAI
audit. Every claim about the chain is backed by a diana tx in [`docs/EVIDENCE.md`](docs/EVIDENCE.md).

## Run it

Testnet `qorechain-diana` only. Node >= 22, pnpm, Foundry. MetaMask for the dashboard's wallet actions.

```bash
pnpm install
cd contracts && forge build && forge test -vv && cd ..   # the dashboard and fresh-owner use contracts/out/
cp .env.example .env                                     # fill it in; never commit it
```

`.env` needs the owner (`OWNER_MNEMONIC`), the guardian (`GAS_MNEMONIC`, `GUARDIAN_ADDRESS`), the agent key
(`AGENT_ED25519_SK`), the vault and token addresses, and a funder (`FUNDER_MNEMONIC`) for demo runs. See `.env.example`.

**Protect your own account**

```bash
pnpm agent                        # the Guardian: watches OWNER_MNEMONIC's account, API on 127.0.0.1:8787
pnpm -F dashboard dev             # http://127.0.0.1:5173 (Overview, Protect, Rules, Recover, Fire drill)
pnpm cli setup                    # or onboard from the dashboard's Protect screen (MetaMask + the CLI lines it shows)
pnpm cli window close             # keep the EVM window closed unless you are using it
pnpm cli sign-withdraw <to> fUSD 1 && pnpm cli withdraw withdrawal.json   # recovery with the ML-DSA-87 key
```

Turn protection off from Rules → "Turn off protection" (revoke the vault allowances in MetaMask, then `pnpm cli unlink`).

**Demos** (each run creates a fresh owner funded by `FUNDER_MNEMONIC`, ~2 QOR; `--phish` also needs `FUNDER_MNEMONIC` set, since its account is the drainer; stop `pnpm agent` first, demo.sh runs its own on :8787)

```bash
./demo.sh                            # leaked key: 3 drains, rescue, forged withdraw refused, agent-key misuse refused, recovery
./demo.sh --runs 3                   # three runs in a row
./demo.sh --phish                    # approval phishing, drainer pulls at once (worst case)
./demo.sh --phish --drainer-delay 2  # ... drainer pulls 2 blocks after the approval
./demo.sh --drill                    # fire drill with its own guardian (also from the dashboard's Fire drill screen)
bash scripts/test-demo.sh            # offline check of demo.sh's flow (stub pnpm, no chain)
```

One `./demo.sh` run: `fresh-owner` (new owner, its ML-DSA-87 key, its own vault, 100 fUSD) → `setup` (scoped window, agent link
and spending rule, vault approvals) → the agent starts → `attack` (the leaked key drains 3 × 10 fUSD, (a) tries `withdraw` with a
forged signature, (b) makes the agent key call `fUSD.transfer` directly) → the agent rescues and signs a report → recovery (an
ML-DSA-87-signed 1 fUSD withdrawal to a fresh address) → `demo-check`: PASS needs the rescue within 3 blocks of the first
drain, at least 80% kept, (a) reverted with `BadSignature` and (b) refused by the chain. Run secrets live in
`~/.config/qday/runs/<run id>/` (0600), never in the repo.

Tests: `cd contracts && forge test -vv`, `pnpm -F core test`, `pnpm -F agent test`, `pnpm -F cli test`, `pnpm -F dashboard test`.

## Deployed (diana)

| Contract / account | EVM address | Native address |
|---|---|---|
| GuardianVault v3 (owner + immutable guardian) | `0x776913Abe058941d4c8ac097EE47E29F528f71e6` | |
| Guardian (agent account, may call `rescue`) | `0xFf82cAD6638a38d7009D0d5DfB757136B0C03850` | `qor1l7pv44nr3gudwqyap4wlkat3x6cvqwzsvtm0pt` |
| Owner (ML-DSA-87 key registered) | `0xE871748C0922745Ad94d065a388e95eC420A67EB` | `qor1apchfrqfyf694k2dqedr3r54a3pq5eltmjxxpv` |
| fUSD / fETH / fBTC (faucet test tokens, public `mint`) | `0x8478737e5ac2c2cbf70aad17f459d1b8ab8a7a14` / `0x0a958bba25f5fddca1b1f9cec44bdf076a8ea6c5` / `0xbd16bc9ffaddf241593d891844cc4281f5af903e` | |
| GuardianVault v2 (retired) | `0x17d867860a0A0Ff528dF655439ff59176b061B3C` | |

The diana explorer shows Cosmos-lane txs only; EVM tx hashes in the docs are checked through their receipts on
`https://evm-testnet.qore.host`.

## Documents

- [Threat model](docs/THREAT_MODEL.md), including the honest limits
- [Audit](docs/AUDIT.md): QCAI Stage 1 (85/100, MEDIUM) and Stage 2 on the final contract (MEDIUM, no finding on the guardian path), every finding fixed, tested or explained
- [On-chain evidence](docs/EVIDENCE.md): every diana tx behind a claim
- [How AI was used](AI_USAGE.md)
- [Spec](docs/specs/2026-11-19-qday-guardian-mvp.md) and [plan](docs/plans/2026-11-19-qday-guardian.md)

## Credits

- [`qorechain/build-before-qday`](https://github.com/qorechain/build-before-qday), workshop-2: the `QDayVault` ML-DSA withdrawal
  pattern and the `pq-agent` authenticator flow (see upstream for its license).
- QoreChain kits: `@qorechain/sdk`, `@qorechain/evm` (`@qorechain/react` was evaluated in Task 6A: it has no hybrid signing path).
- viem, Foundry, React, Vite, `@noble/curves`. Fonts: Archivo, IBM Plex Mono (Google Fonts, SIL OFL).

## License

MIT. See [LICENSE](LICENSE).
