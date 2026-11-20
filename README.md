# Q-Day Guardian

> **Status: work in progress** for QoreChain *Build Before Q-Day* (Post-Quantum AI Agents).
> Testnet `qorechain-diana` only. Test tokens have no value.

When an account's classical ECDSA key leaks, anything it can reach on the EVM lane is at risk
while its EVM window is open. **Q-Day Guardian** is an AI agent that spots the drain and sweeps
what is left into a `GuardianVault`, which only releases funds with the owner's **ML-DSA-87**
(post-quantum) signature.

The agent itself is boxed in by the chain. Its linked key may call **one function of one contract**
(`GuardianVault.rescue`). Even a stolen agent key can only move the owner's funds *to safety*.

## How it works

```
 attacker (leaked ECDSA key) ──transfer──▶ owner's tokens on EVM lane
                                              │  watched every block
                                              ▼
 Guardian agent (ed25519 key, linked on-chain, allowedEvmCalls = vault.rescue only)
        │ MsgExecuteEVM via authenticator lane
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
| Owner (ML-DSA-87 guardian) | `0xE871748C0922745Ad94d065a388e95eC420A67EB` / `qor1apchfrqfyf694k2dqedr3r54a3pq5eltmjxxpv` |

## Credits
- [`qorechain/build-before-qday`](https://github.com/qorechain/build-before-qday), workshop-2: the
  `QDayVault` ML-DSA withdrawal pattern and the `pq-agent` authenticator flow (Apache-2.0/MIT, see upstream).
- QoreChain kits: `@qorechain/sdk`, `@qorechain/evm`, `@qorechain/react`.
- viem, Foundry, `@noble/curves`.

## License
MIT. See [LICENSE](LICENSE).
