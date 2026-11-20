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
_Coming with Tasks 1–5. See `docs/plans/`._

## Documents
- [Threat model](docs/THREAT_MODEL.md)
- [Audit (QCAI Stage 1 + 2)](docs/AUDIT.md): Stage 1 scored 85/100 (MEDIUM), every finding handled
- [On-chain evidence](docs/EVIDENCE.md)
- [How AI was used](AI_USAGE.md)

## Deployed (diana)
| Contract / account | Address |
|---|---|
| GuardianVault (v2, after QCAI Stage 1) | [`0x17d867860a0A0Ff528dF655439ff59176b061B3C`](https://explore.qore.network/address/0x17d867860a0A0Ff528dF655439ff59176b061B3C) |
| fUSD / fETH / fBTC (faucet test tokens, public `mint`) | `0x8478737e5ac2c2cbf70aad17f459d1b8ab8a7a14` / `0x0a958bba25f5fddca1b1f9cec44bdf076a8ea6c5` / `0xbd16bc9ffaddf241593d891844cc4281f5af903e` |
| Owner (ML-DSA-87 guardian) | `0xE871748C0922745Ad94d065a388e95eC420A67EB` / `qor1apchfrqfyf694k2dqedr3r54a3pq5eltmjxxpv` |

## Credits
- [`qorechain/build-before-qday`](https://github.com/qorechain/build-before-qday), workshop-2: the
  `QDayVault` ML-DSA withdrawal pattern and the `pq-agent` authenticator flow (Apache-2.0/MIT, see upstream).
- QoreChain kits: `@qorechain/sdk`, `@qorechain/evm`, `@qorechain/react`.
- viem, Foundry, `@noble/curves`.

## License
MIT. See [LICENSE](LICENSE).
