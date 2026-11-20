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

`GuardianVault` at `0x8A11587A08F509781c0ce190EeaD715e4d81b0A5`, owner `0xE871748C0922745Ad94d065a388e95eC420A67EB` (`qor1apchfrqfyf694k2dqedr3r54a3pq5eltmjxxpv`).

| Claim | Result | Tx / check |
|---|---|---|
| Owner's PQC key is ML-DSA-87, registered and proven | `pqcKeyStatus` precompile and REST: registered, `algorithmId` 1 (Dilithium5 / ML-DSA-87), 2592-byte pubkey, `possessionProven` true | read-only, 2026-11-20 |
| Owner opens an unscoped EVM window for the deploy (600 blocks, 3 txs) | OK | `4F80AAD7CD12ABE69BE7F5661A4E27316ACDC3C49A1C363B1F152EE3A96A32D9` |
| `GuardianVault` deployed by `Deploy.s.sol` (key derived from the owner mnemonic) | Success, block 10407569. `owner()` = owner, `nonce()` = 0. `gasUsed` 675529 of the 878187 limit (77%, so the 50% figure in Task 0 is a floor, not a constant) | `0xc100b0504cf5b5991a9ff73c541d933c041db9d5b919a28d773a5a19b2fcb84d` |
| Review Focus 2: the deployed vault's `withdrawalMessage(0x2222…, 0x3333…, 1e18, 0)` is byte-identical to `@qday/core` `withdrawalMessage` for the same inputs | MATCH, 172 bytes, keccak `0x89fae1e18eb9f7f687cf95d6080760a6626801cc45ad31ad5bb4d727a9a6177b` on both sides | `eth_call` on diana, 2026-11-20 |
