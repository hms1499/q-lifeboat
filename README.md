# Q-Day Guardian

> **Status: work in progress** for QoreChain *Build Before Q-Day* (Post-Quantum AI Agents).
> Testnet `qorechain-diana` only. Test tokens have no value.

When an account's classical ECDSA key leaks, anything it can reach on the EVM lane is at risk
while its EVM window is open. **Q-Day Guardian** is an AI agent that spots the drain and sweeps
what is left into a `GuardianVault`, which only releases funds with the owner's **ML-DSA-87**
(post-quantum) signature.

The agent itself is boxed in. Its own account is the vault's immutable `guardian`, which may call
**one function** (`GuardianVault.rescue`), inside an EVM window that targets only the vault. Its linked
ed25519 key may call only `vault.rescue` and move no tokens. Even stolen agent keys can only move the
owner's funds *to safety*.

## How it works

```
 attacker (leaked ECDSA key) ──transfer──▶ owner's tokens on EVM lane
                                              │  watched every block
                                              ▼
 Guardian agent (own guardian account, EVM window scoped to the vault; ed25519 key signs reports)
        │ vault.rescue(token): pulls owner → vault
        ▼
 GuardianVault ──withdraw only with ML-DSA-87 signature (pqcVerify 0x…a01)──▶ owner
```

| Piece | What it does |
|---|---|
| `contracts/` | `GuardianVault.sol`: `rescue(token)`, `deposit()`, `withdraw(...)` gated by `pqcKeyStatus` + `pqcVerify` |
| `apps/agent/` | Watches the owner, decides with fixed rules, rescues, and publishes a signed incident report (LLM-written summary) |
| `apps/cli/` | `setup` (window + approve + link agent), `sign-withdraw` (local Guardian Signer), `withdraw`, `attack` (demo) |
| `apps/dashboard/` | Window budget, agent rules, verified incident timeline, recovery |

## QoreChain features used
Hybrid secp256k1 + ML-DSA-87 transactions · scoped EVM window · authenticator lane with spending
rules (`allowedEvmCalls`, per-tx/daily limits, expiry) · `pqcVerify` / `pqcKeyStatus` precompiles ·
`qore pq status` · two-stage QCAI audit.

## Run it
Testnet `qorechain-diana` only. Node >= 22, pnpm, Foundry.

```bash
pnpm install
cd contracts && forge build && forge test -vv && cd ..   # builds contracts/out/GuardianVault.sol/GuardianVault.json
cp .env.example .env                                     # fill it in; never commit it
./demo.sh                                                # one end-to-end run
./demo.sh --runs 3                                       # three runs in a row, each from a fresh owner
./demo.sh --resume ~/.config/qday/runs/<id>/run.env     # redo one run from a complete fresh owner
bash scripts/test-demo.sh                                # offline check of demo.sh's flow (stub pnpm, no chain)
```

One run of `demo.sh`:
1. `pnpm cli fresh-owner`: the funder (`FUNDER_MNEMONIC`, default `OWNER_MNEMONIC`) sends 1.5 QOR to a
   brand-new owner, which registers its ML-DSA-87 key, deploys its own `GuardianVault(owner, guardian)` from
   `contracts/out/GuardianVault.sol/GuardianVault.json` and mints 100 fUSD. Its secrets go to
   `~/.config/qday/runs/<run id>/run.env` (0600, written before the owner is funded, `RUN_COMPLETE=1` once every
   step succeeded), never into the repo.
2. `pnpm cli setup`: scoped EVM window, agent link and spending rule, vault approvals.
3. The guardian agent starts (log in the run directory) and watches the owner.
4. `pnpm cli attack`: the leaked ECDSA key drains 3 x 10 fUSD one block apart, then (a) tries `withdraw`
   with a forged signature and (b) makes the agent key call `fUSD.transfer` directly (relayed by the funder).
5. The agent rescues the rest into the vault and signs an incident report.
6. Recovery: the Guardian Signer signs (ML-DSA-87) a 1 fUSD withdrawal to a fresh safe address.
7. `pnpm cli demo-check` prints the verdict and `demo.sh` a final `PASS`/`FAIL` line: rescue at most
   3 blocks after the first drain, at least 80% kept, (a) reverted with `BadSignature`, (b) refused with
   "authenticator not permitted for this action".

## Documents
- [Threat model](docs/THREAT_MODEL.md)
- [Audit (QCAI Stage 1 + 2)](docs/AUDIT.md): Stage 1 scored 85/100 (MEDIUM), every finding handled
- [On-chain evidence](docs/EVIDENCE.md)
- [How AI was used](AI_USAGE.md)

## Deployed (diana)
| Contract / account | Address |
|---|---|
| GuardianVault (v3, owner + immutable guardian) | [`0x776913Abe058941d4c8ac097EE47E29F528f71e6`](https://explore.qore.network/address/0x776913Abe058941d4c8ac097EE47E29F528f71e6) |
| Guardian (agent account, may call `rescue`) | `0xFf82cAD6638a38d7009D0d5DfB757136B0C03850` |
| GuardianVault v2 (retired) | `0x17d867860a0A0Ff528dF655439ff59176b061B3C` |
| fUSD / fETH / fBTC (faucet test tokens, public `mint`) | `0x8478737e5ac2c2cbf70aad17f459d1b8ab8a7a14` / `0x0a958bba25f5fddca1b1f9cec44bdf076a8ea6c5` / `0xbd16bc9ffaddf241593d891844cc4281f5af903e` |
| Owner (ML-DSA-87 guardian) | `0xE871748C0922745Ad94d065a388e95eC420A67EB` / `qor1apchfrqfyf694k2dqedr3r54a3pq5eltmjxxpv` |

## Credits
- [`qorechain/build-before-qday`](https://github.com/qorechain/build-before-qday), workshop-2: the
  `QDayVault` ML-DSA withdrawal pattern and the `pq-agent` authenticator flow (Apache-2.0/MIT, see upstream).
- QoreChain kits: `@qorechain/sdk`, `@qorechain/evm`, `@qorechain/react`.
- viem, Foundry, `@noble/curves`.

## License
MIT. See [LICENSE](LICENSE).
