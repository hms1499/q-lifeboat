# On-chain evidence (qorechain-diana)

Every claim in the README, threat model and demo is backed by a testnet transaction here.
Explorer: https://explore.qore.network/tx/<hash>

## Task 0 spike (2026-11-19, throwaway accounts and contracts)

Agent rule under test: `allowedEvmCalls = ["0x3f674746ffcdc3adeee2377accd5a2e706efc7df/0x52d11238"]` (`SpikeTarget A.pull(address)`), perTx 1 QOR, daily 3 QOR, `allowedDenoms = ["uqor"]`.

| Claim | Result | Tx |
|---|---|---|
| Agent link is a hybrid-signed owner tx | OK | `DFA4A7F35F2683338E4FC04119F28987391E0DFDFBF7E84190273A49C4C58171` |
| Agent can't call another function of the allowed contract (`A.ping`) | Refused: "authenticator not permitted for this action" | `D17AD5F7E493AF5019A27199BB8B329551A28EB6132895807B9BE4C28D55E62F` |
| Agent can't call another contract (`B.ping`) | Refused, same reason | `85CA48138B10516C2782664725C19E6AE899EC23C8E81F73BB1851F838EA8A4A` |
| Agent can call the allowed function, and token moves inside it ignore the limits (1000 tokens pulled, perTx 1 QOR) | Success | `D5DAAD0A3BA4B1D953A95BE3CF30D94EB19A36E438DAB9C65C4AEEB30986D5E7` |
| Owner closes their EVM window | OK | `276ED221772AD814726C8D2B2FBABE005CC260D570814844E947490FDFE46DC5` |
| Agent lane still works with the window closed | Success | `9ADDC2409A96DAD7DA996782E401CB936E4F6CAAB71138F479C56CF1594A40A9` |
| Spending rules don't bind the owner's ECDSA key (2 QOR sent, perTx 1 QOR) | Success | `0x282a67c7d43bafd037f7b836e2bf08ae8513450f2021830d9446336bdda56f4e` |
| Workshop `QDayVault` withdraw with ML-DSA-87 (4627-byte sig). Forged sig was blocked in simulation (`BadPqcSignature`) | Success, `gasUsed` reported 500000 of 1M limit | `0x3783c450f90d846e120d1d29b02d8ef1c6f3d5b23d20aaac495b9098a8eff840` |

## Project contracts
_Added from Task 2._
