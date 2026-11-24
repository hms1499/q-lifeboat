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

Current `GuardianVault` is v3 (owner + immutable guardian, Task 4D) at `0x776913Abe058941d4c8ac097EE47E29F528f71e6`. v2 (QCAI Stage 1 fixes) at `0x17d867860a0A0Ff528dF655439ff59176b061B3C` is retired. v1 at `0x8A11587A08F509781c0ce190EeaD715e4d81b0A5` is retired (empty, pre-audit bytecode). Owner `0xE871748C0922745Ad94d065a388e95eC420A67EB` (`qor1apchfrqfyf694k2dqedr3r54a3pq5eltmjxxpv`).

| Claim | Result | Tx / check |
|---|---|---|
| Owner's PQC key is ML-DSA-87, registered and proven | `pqcKeyStatus` precompile and REST: registered, `algorithmId` 1 (Dilithium5 / ML-DSA-87), 2592-byte pubkey, `possessionProven` true | read-only, 2026-11-20 |
| Owner opens an unscoped EVM window for the deploy (600 blocks, 3 txs) | OK | `4F80AAD7CD12ABE69BE7F5661A4E27316ACDC3C49A1C363B1F152EE3A96A32D9` |
| `GuardianVault` deployed by `Deploy.s.sol` (key derived from the owner mnemonic) | Success, block 10407569. `owner()` = owner, `nonce()` = 0. `gasUsed` 675529 of the 878187 limit (77%, so the 50% figure in Task 0 is a floor, not a constant) | `0xc100b0504cf5b5991a9ff73c541d933c041db9d5b919a28d773a5a19b2fcb84d` |
| Review Focus 2: the deployed vault's `withdrawalMessage(0x2222…, 0x3333…, 1e18, 0)` is byte-identical to `@qday/core` `withdrawalMessage` for the same inputs | MATCH, 172 bytes, keccak `0x89fae1e18eb9f7f687cf95d6080760a6626801cc45ad31ad5bb4d727a9a6177b` on both sides | `eth_call` on diana, 2026-11-20 |
| v1 retired after QCAI Stage 1; owner opens a 5-tx window for the v2 deploy and proof | OK | `F399C7FEF27DD31B64AC0C4CD4788DDB64F42D59ED87F0AFB5CD4B924D86662C` |
| `GuardianVault` v2 deployed (owner-only `rescue`, SafeERC20-style return checks) | Success, block 10408285. `owner()` = owner. `gasUsed` 695387 of 904003 | `0x49ce4031f63cd65f5a2891e4a650c41941b17ac2deae1e4fa23832e0609edb41` |
| Review Focus 2 on v2: on-chain `withdrawalMessage(0x2222…, 0x3333…, 1e18, 0)` == `@qday/core` | MATCH, 172 bytes, keccak `0x5ba836cbac295e4585d81e417d620e678c09c1d911375e14c3e4e7858d19e4a4` | `eth_call` on diana, 2026-11-20 |
| Throwaway test token (100e18 to owner) and `approve(v2, max)` | Success | `0xdfae29d314c6484d859ee34311cedd977d69b20938c85357426745f84594d59a`, `0x86ba4e4dc750961171f916fca03eaff035382d43fe32916ba1ad003f4cc7e85a` |
| Owner replaces the account's spending rules with the production shape: `allowedEvmCalls=["0x17d867860a0a0ff528df655439ff59176b061b3c/0x839006f2"]`, `allowedDenoms=["uqor"]` (only `MsgUpdateSpendingRules`; the key stays registered) | OK, `fetchSpendingRules` shows the single rule | `B71F68C7E428653A5DB0D8D0D5DA97B3CE58EAE958EBAFD3EACE99A00BF9E5BF` |
| A stranger (gas wallet `0xFf82…3850`) cannot call `rescue` (QCAI #1) | Reverts `NotOwner` | `eth_call` simulation on diana, 2026-11-20 |
| **The authenticator lane calls as the owner**: the agent's `MsgExecuteEVM` to owner-only `rescue(token)` succeeds, so `msg.sender` == owner's EVM address | `success: true`, `gasUsed` 58705; owner 100e18 → 0, vault 0 → 100e18 | `52B81C0850CD88D541CE1A3557621FB10BD5B2597A5B18F963D223A11CABE395` |

## Task 3: CLI setup, Guardian Signer and withdraw (2026-11-20)

Faucet test tokens (`TestToken`, public `mint`, testnet only) deployed by `DeployTokens.s.sol`:
fUSD `0x8478737e5ac2c2cbf70aad17f459d1b8ab8a7a14`, fETH `0x0a958bba25f5fddca1b1f9cec44bdf076a8ea6c5`,
fBTC `0xbd16bc9ffaddf241593d891844cc4281f5af903e`.

| Claim | Result | Tx / check |
|---|---|---|
| Owner opens an unscoped 5-tx window for the token deploy | OK | `52C2A31C7E0A5945ADB51856BC0C4AFEBE4C2AC0BCDCE2EC6FC96055B4281233` |
| Deploy fUSD / fETH / fBTC and mint 100 fUSD, 100 fETH. The 6th tx (mint fBTC) was refused: "EVM authorisation window exhausted" (5 txs used) | 5 × success | `0xd3a4d713…e000`, `0xf8d5c71b…d420`, `0xaff61942…4862`, `0x14e370ed…7764`, `0x0243c6d0…dd94` |
| `pnpm cli setup`: ONE hybrid tx with `MsgOpenEVMWindow` (600 blocks, 10 txs, `allowedTargets=[fUSD, fETH, fBTC, vault]`) + `MsgUpdateSpendingRules` (agent key already linked). Opening a window while an exhausted one is still unexpired is accepted and replaces it | OK. `status`: window live, 10 txs, the 4 targets; rules = exactly `allowedEvmCalls=["0x17d8…1b3c/0x839006f2"]`, `allowedDenoms=["uqor"]` | `2659F7BE26FC53E7D6A47A7B7C2D79D88C8E5CCEB6A5C98389C888C055CBA818` |
| `setup` approvals `approve(vault, max)` for fUSD / fETH / fBTC inside the scoped window | 3 × success, `allowance(owner, vault)` = 2^256-1 for all three | `0xbb22c55da83e90b83379fcde56ff2fa655d6299e0cb4a521c9a9dd32ea526416`, `0x274ed5452a0f377dda80a7567d475f5153edf9f9165e0124aca19d0abc41c32d`, `0x1a1c27145ed6555cace5b7f529f6b96595e5764f45c321b1de38969e3bd9b5c3` |
| Mint 100 fBTC to the owner (scoped window, fBTC is a target) | Success, gasUsed 68292 | `0x2d72a32ceaf5dac8467e57ddce9e6fca59a0b1ad0a8b33ef814eb82fe36b7993` |
| Owner calls `vault.rescue(fUSD)` with ECDSA inside the scoped window | Success; owner fUSD 100 → 0, vault 0 → 100 | `0xee41eb08a73c9a74385081196ec1001f392e3c4faf8f62798d45673dbea86534` |
| **Guardian Signer + withdraw**: `sign-withdraw 0x5afe…c0de fUSD 1` (local `pqcSign`, 4627-byte ML-DSA-87 sig; signer checked the on-chain key is registered + proven and that the vault's `withdrawalMessage` equals the TS bytes), then `withdraw withdrawal.json` | `status success`, gasUsed 500000 (1M limit); `to` fUSD 0 → 1, vault 100 → 99, `nonce()` 0 → 1 | `0xe5068a0537100f044ee573b0f4a6bb96d83b3d369d30f60fcf5d74b0bcc7c18c` |
| Review Focus 3 on diana: resubmitting the same `withdrawal.json` | CLI refuses before sending ("file nonce 0, vault nonce 1"); `eth_call` of the same args reverts `BadSignature()` (`0x5cd5d233`) | `eth_call` on diana, 2026-11-20 |

## Task 4: Guardian agent on diana (2026-11-20)

| Claim | Result | Tx / check |
|---|---|---|
| Owner opens a 3-tx window and sends 1 fETH to `0x…dEaD` with its ECDSA key (simulated drain) | Success, block 10410429 | `66C0721A4EDAEE3F66B219AC820561E5B76B5512055774013371241B214B5CDB`, `0xab3685e39e5be2af26fc1f3cb5bc18bca3359eba1ac31f688c1e7027b140f870` |
| The agent detects it (`getLogs` with the `from` topic filter works on diana), `decide` → RESCUE, and sends ONE cosmos tx with two `MsgExecuteEVM` (fETH, fBTC, auth nonces n, n+1) | Tx code 0, height 10410436 (7 blocks after the drain), gas 560149 of 1.5M. `decodeAuthenticatorExecutions` returns two results | `8508B568DE126539BA5DD8CAE4337E0DCFC1F1B6C47323BC4228495037EA84B7` |
| **Chain fact 2 no longer holds.** With `allowedDenoms=["uqor"]`, both rescues fail: "the call made a token transfer from the account on <token>, which the linked key's spending rule does not list: authenticator not permitted for this action". The same call shape succeeded earlier the same day (`52B81C08…`, Task 2), so the chain's policy changed in between | `success=false` ×2; the signed incident records amount 0 (from `Rescued` logs), not the 99e18 estimate | `8508B568…` |
| Owner lists fUSD/fETH/fBTC as `erc20/<addr>` with a 1000e18 `denomLimits` cap each; `allowedEvmCalls` stays `[vault/rescue]` | OK, `fetchSpendingRules` shows 3 denoms + caps | `5151AC312D8B9C904CC6DC11568C6E25117B8E69FB0E2D9370290D1D63DF87EE` |
| **Listing a token lets the linked key move it directly.** `pnpm cli agent-misuse fETH 0x…dEaD 1e18` (agent key calls `fETH.transfer`, not the vault) | `success=true`, owner fETH 99 → 98. `allowedEvmCalls` does not restrict transfers of listed tokens | `CADB1412182E060C3C951959EE155D6E7CF1E5314F413668A8B9A017DE270AC8` |
| Rule reverted to `allowedDenoms=["uqor"]` (closes the hole) | OK | `48078F2C7963FFDAF74D66DE22D6EA07852EB019B0F2E00E35379A00ADC80FF2` |
| Demo step 4(b): with the uqor-only rule the agent key calling `fETH.transfer` directly is refused: "a linked key with a spending rule may call <token> with data only if the rule lists the call in allowed_evm_calls (or lists the token as "erc20/<token>" for a token transfer or approval): authenticator not permitted for this action" | `success=false`, `agent-misuse` prints REFUSED | `7E9B629F2A8508848A350AF05AD63A36661F11D83A4A87EEE1D8B6FC497D0DDF` |
| Owner opens an unscoped 3-tx EVM window for the v3 deploy | OK | `E04CD6B63C94560D07289ECEFDCBACF142B0FE618A9BE3B8DE7A2CB875F5FD16` |
| `GuardianVault` v3 deployed by `Deploy.s.sol` with `GUARDIAN_ADDRESS` = the agent's `GAS_MNEMONIC` account (`0xFf82cAD6638a38d7009D0d5DfB757136B0C03850`, `qor1l7pv44nr3gudwqyap4wlkat3x6cvqwzsvtm0pt`, ML-DSA key registered) | Success, block 10421573, gasUsed 725168 of 942718. Vault `0x776913Abe058941d4c8ac097EE47E29F528f71e6`; `cast call` gives `owner()` = owner, `guardian()` = guardian | `0x77f4eea0e461cf17110d10656cc94eaad5c34afc75342bfee30c3df2e9846a71` |
| `pnpm cli setup` against v3: hybrid tx (scoped owner window + rule) and `approve(vault v3, max)` ×3. Rule = exactly `allowedEvmCalls=["0x776913abe058941d4c8ac097ee47e29f528f71e6/0x839006f2"]`, `allowedDenoms=["uqor"]` | OK; approvals status 1 ×3 | `0B0A3EFD5DED59EC3F455BB33F2D278A9C5B1A3B2CBAAA7FA07FC83ED1315CEA`; `0x60f07f07…71fa`, `0x44bf80be…fc11`, `0x1c1bb2ff…ff71` |
| Agent startup: vault `guardian()` matches `GAS_MNEMONIC`; the guardian opens its own hybrid-signed EVM window (14400 blocks, 10 txs, `allowedTargets=[vault]`) | OK | `715C67A3DA36954DD70347B74F962388F9ED8F4F3A5133FBD14898C41B4EC117` |
| Simulated drain: owner ECDSA key sends 1 fETH to `0x…dEaD` (owner window reopened first, `002B810B…`) | Success, block 10422295 | `0x62ba45325b5c641b3695fba8e58b4250a575563a7edbe9d6cd928b882a0c342f` |
| **Guardian rescue (Task 4 done).** `decide` → RESCUE (recipient not allowlisted); the agent sends two plain EVM `vault.rescue(token)` txs FROM the guardian `0xFf82…3850` (not the owner), sequential nonces, `maxFeePerGas` 150 gwei | Both status 1 in block 10422299 (4 blocks after the drain), gasUsed 60000 each (50% of the 120k limit). `Rescued` logs: fETH 97e18, fBTC 100e18 = pre-read estimate. Owner fETH 97 → 0, fBTC 100 → 0; vault fETH 0 → 97, fBTC 0 → 100. Signed incident `101a81ba…` (2/2 rescued, template summary) served on `GET /incidents`; the vault-bound transfers did not re-trigger | `0x2660fb6f6a353c0a6cbec5b0e520bef5e54926f8834b8551248c011229080cff` (fETH), `0xc95e29069d47527b3b4d86b30a8aa4db86e12aaa326c935c8c958c672a3acd40` (fBTC) |

## Task 5: end-to-end demo on diana (2026-11-20)

Each run uses a brand-new owner provisioned by `pnpm cli fresh-owner` (its own ML-DSA-87 key, its own `GuardianVault` with the agent account `0xFf82…3850` as guardian, its own agent ed25519 key, 100 fUSD), then `./demo.sh` runs setup → agent → attack → recovery → verdict.

### Run 1 — `20261120T141722Z` — PASS

Fresh owner `0x0aEb66a9Ba4A39B4B5339BB2590e64FA66e9d04A` (`qor1pt4kd2d6fgumfdfnnwe9jrnylfnwn5z223sypr`), vault `0x9e94b1696eb0467e434c4ecdbd2fbb42dd2ed70d`, attacker `0x9d9E5b294A8EAD99134Cffd18fe2a8D2A36560DB`, safe address `0x61e095243b41343713292fA2629089838a925Ba8`. Resumed once with `--resume` after two `setup` bugs (below) were fixed; the fresh-owner txs were not repeated.

| Claim | Result | Tx / check |
|---|---|---|
| Funder sends 1.5 QOR to the fresh owner | OK | `C34F85BA55E5E57A211304886EB328F52DC8E5C8C1A62AF4E143BBE8E7FE14D3` |
| **A brand-new account registers its ML-DSA-87 key** with a classically signed `MsgRegisterPQCKeyV2` (proof of possession) | OK, key registered and proven (the signer's check passed later) | `A665D9CBED0C659B4598E39D796E42E8CCB03082991E70386EBE7D27B675EBF2` |
| Fresh owner opens an unscoped 3-tx window, deploys its vault, mints 100 fUSD | OK; `owner()`/`guardian()` read back | `DFEB0823AF4CCD8C3BCC47BC3C30DF0AABE108B5483D5E0304602C1EB5374338`, `0xe9bc1628cc3663ee424baf12a5dd828d2b6a4b37232cfc9c43b278fadc035d7f`, `0xc6f1fe8b178d27dfd46e3dee858c4d2bb916b67e6e76db49e32dbe87481870a1` |
| Before the first link the abstractaccount REST answers HTTP 404 "account … not found" for `authenticators` | `setup` failed until the 404 was read as "no keys" | REST, 2026-11-20 |
| **An authenticator key binds to ONE account**: linking the root agent key to the fresh owner is refused, "authenticator key already bound to another account" | Tx failed (code 1); fixed with a per-run agent key | `422FE4897AA6362A99904C66152A5E6E77644D68BCC01C323593F99822AE8357` |
| `setup`: scoped window + link (per-run key) + rule, then `approve(vault, max)` ×3 | OK | `4B6390CED56BE8A62117BA0C1643C926EEF3E0A8E58374BD9000039B27E28C4A`; `0x828cf3194bfcb5889b8d54c3d63eac65f2b75fa8757eeeb87f3baf3960722432`, `0x4831e6470027d487744261da7f19087a1c812826da98934ee191c6eb6814fccc`, `0xe5540d8723c06be5bbad1384462fec933fc1f3aac8f5c1cd9be7105d52438039` |
| Attack drain 1: leaked ECDSA key sends 10 fUSD to the attacker | Success, block 10437759 | `0x307f314660f0a0eff7809d7fcd96e8d6522c9b038a05b6c1ab3b4e6506901878` |
| **Guardian rescue**: detected 5.4 s after the agent started polling the block, sent 1.5 s after detection (trigger token first, 40 gwei tip) | Success, block 10437761 = **2 blocks** after drain 1; 89 fUSD into the vault | `0xc32258f9e31759d496013cf2281a4940c818d2918115b8d8ae45439e54ca1cfb` |
| Drains 2 and 3 (one block apart) find nothing left | Both reverted | `0xcda42340b4a4e373538d23c33610b7628dd84f7963c665248a7c0ed6ea6f3995` (block 10437761), `0x71fcac126aa3e90d0a88e28ab8137792345c118787dc27c070dc6b1a2e4b8057` (block 10437762) |
| Demo 4(a): attacker calls `vault.withdraw` with a forged 4627-byte signature | `eth_call` → `BadSignature`; the real tx reverted | `0x1cf584df8d0e1e1fce27bc0641d81c17445a4d6f74852953ea55acd43490fb00` |
| Demo 4(b): the (stolen) agent key calls `fUSD.transfer(attacker)` directly | Refused: "… authenticator not permitted for this action" | `2CCD028471839B0550472B4F054FBA3570400F614B17994BE21654765E952736` |
| Signed incident served by the agent | `4da6d493-23c5-4caa-898e-0cf29d33f006`, trigger = drain 1 | `GET /incidents` |
| Recovery: Guardian Signer (ML-DSA) + `withdraw` 1 fUSD to the safe address | `status success`, safe 0 → 1 fUSD | `0xf0ed540a7e0d6a1230a92fa18983c3fbf80851d6a29bd3fb980e8c90af5bc698` |
| **Verdict** | 2 blocks (≤ 3), **90% kept** (vault 89 + recovered 1 of 100), attacker 10 fUSD, (a) PASS, (b) PASS | `demo-check` RESULT PASS |

### Series of 3 fresh runs before the latency fix — run 2 FAILED (kept for the record)

`./demo.sh --runs 3` on `250ea48`: run `20261120T143255Z` PASS (rescue `0x3b9b8da3…` in block 10438058, 3 blocks after drain 1 `0xf46d0714…`, 80% kept); run `20261120T143420Z` FAIL (rescue `0xd1c80c76…` in block 10438112, 4 blocks after drain 1 `0x532bbc49…`, 70% kept, all 3 drains landed). Measured cause: blocks appear on the EVM RPC 2.0-2.9 s after their timestamp; on top of that the agent's tip read was cached 4 s by viem (no `blockTime` on the chain object), the watch loop was serial (a full block fetch per block before the next log poll), and the rescue made ~3 sequential RPC round trips (1.4 s detect → send). Fixed in `3a412d6` + `2da27e2` (uncached tip, tip + logs in one batched request per tick, native scan in its own loop, nonce read batched with the balance reads, no lone retries on the watcher).

### Series of 3 fresh runs in a row (`./demo.sh --runs 3` on `2da27e2`) — 3/3 PASS

| Run | Fresh owner / vault | Drain 1 (block) | Rescue (block) | Blocks | Kept | (a) forged withdraw (reverted `BadSignature`) | (b) agent key refused | Recovery withdraw | Incident |
|---|---|---|---|---|---|---|---|---|---|
| `20261120T150539Z` | `0x9A46B1D451E5885E76F4DE4a9C40592134D1a12B` / `0x3b2e939bb7360e3f32ecaadc40c7bd80321df06a` | `0xa03398b9767f5978bb157653caabd2166f5ab48d6e61ba85d754379182adc426` (10439427) | `0xa1d78c953d806250a9ddcf2b478f5a78d842eb83472113e438d75f7baeb84f0b` (10439428) | **1** | **90%** | `0x3b261065ba9c9963629f4bfd7e7698bdcbac47628b5939aad295b850876cc4a5` | `9C82080EFB86BDC0DD348E1827F704AB9DAE228F71789135CFB5B6F9C1211AC8` | `0xb0fbb6eebdeeefdc2e426e668dc8898c36783bce3fbd0ebba1c6b4646f79f618` | `04782c06…` |
| `20261120T150702Z` | `0x44858d4b5Ff19F871e13074E6D7EA9cB30223e58` / `0xd3d98f01e82bc449fb5491852ca6d75b526a0004` | `0x26ccb70bcd6809afb9980d9d863e8f579e9f4a56bd947952eb783dc76d074bab` (10439482) | `0xc775183951153ece774af6df2e07eede97b51b044e1cddcc4909221e13820393` (10439483) | **1** | **90%** | `0x6406e4e4031f169cde521138c306926525ba7cbb33d968e5ac358e85a3a2625f` | `3D54041D44056BF961245BCC79548D53708476E14540946E7DA695F42A79F114` | `0x87b0ce9f3a9d02073bbe7077e573e13f29708a14040471b2f41c6f8c1453e5be` | `eef21819…` |
| `20261120T150823Z` | `0x9ac26061A6AB91B8B2833010A175D26b05fCf3b2` / `0xa5c2b683da4c6ba7b870bed89d91d9cfec2f8e28` | `0x23502091c1384424179c1090293da90036db6f53808af7b90bca070562462f60` (10439541) | `0x71573efbc7542df78dcb1d222cbc4f6ecb84e6f82620ce3bcf13c1c6acbc03a5` (10439542) | **1** | **90%** | `0x0a720f32de7c28d55b20fd2678afd86c12159afefb2b4dad55c6427ced011eba` | `A53785CFF3FC045CD64335ED5B95F54033B42FB8A86C1411B767089125A3373F` | `0x3938ee536772169b4a4869ff9beded2d020175202b4fdd6cf79b5094c36aec29` | `969d0476…` |

In every run drains 2 and 3 reverted (nothing left), the attacker got 10 fUSD, the vault 89 and the safe address 1 (ML-DSA recovery). Agent timing (from `agent.log`): detected 0.57-0.67 s → rescue sent, receipt in the next block. Each fresh owner's setup (fund, ML-DSA register, deploy window, vault deploy, mint, scoped window + link, 3 approvals) is in the run log; fund txs `D8C73A9A…`, `516072D8…`, `D20C63B8…`.

## Task 6A: wallet signing spike (2026-11-21)

Throwaway page `spike/qorex-sign/` (gitignored). Builder's QoreX build and MetaMask, owner `0xE871748C0922745Ad94d065a388e95eC420A67EB`.

| Claim | Result | Evidence |
|---|---|---|
| QoreX `signAndBroadcast` on diana (MsgSend, window + rules + register, each alone, `MsgCrossVMCall`) | All refused before any prompt: "chain qorechain-diana does not match the active network qorechain-vladi". The build has no testnet option | Page log, 2026-11-21 02:51 UTC |
| QoreX build capabilities | `listAccounts`, `connectProofPicksAccount`, `executeRequest`, `signAndBroadcast`, `signDirectAddsPqcLayer`, `signArbitrary`; EVM account `0xa88D…36a1` differs from native `qor1fwr0…` (`0x4b86…9b74`) | Page log, 02:46 UTC |
| MetaMask `eth_sendTransaction` from an account with no EVM window (`0xa88D…`, 175 QOR) | Refused at broadcast: "account qor14zxae5fs0rks778qpdwwlr0aaw48jd4pk5dupt has no open EVM authorisation window; open one with MsgOpenEVMWindow, signed on the Cosmos lane with the account's post-quantum key". No hash, no gas | Page log, 03:10 UTC |
| Owner window opened by CLI (probe, hybrid): 600 blocks, 4 txs, 1.35 QOR budget | OK | `3A78EE03C41F002D6B896581F863F8349A0B1742E3B2E2D3D66E5D939A4F8504` |
| MetaMask (owner mnemonic imported): `fUSD.approve(0xdEaD, 1)` | Success, block 10469956, `from` = owner; `allowance(owner, 0xdEaD)` = 1 | `0xf6fc57752926acb970ef4b249ea76c1b829408bea6851b86ad886772149cf70a` (again: `0x563f1b830755bb76d1ecb6f286e4d4e0db0d2623fbe970f20171638805271f92`) |
| MetaMask: 0.01 QOR to the guardian (gas tank top-up) | Success, block 10469968, gasUsed 25000 of 50000 | `0x65282be012b3185d00d4a8802610b9f3e50bae2ec8c05276b58570b633006f50` |
| MetaMask: owner calls `vault.rescue(fUSD)` ("Rescue now") | Success, block 10469972, gasUsed 100000 of 200000 | `0xb4119a4cef70c4e5c48bd94afcdbc6088893b04f023b4844e4df34095cc5034b` |
| Window after the 4 txs | `usedTxs` 4/4, `live: false`, 60625 uqor used | `evmWindowStatus`, 03:15 UTC |
| Not tested: `vault.withdraw` through MetaMask (window spent) | Same EVM path as `rescue`; to prove in Task 6D step 4 | |

## Task 6B: `Approval` trigger on diana (2026-11-21)

Root owner `0xE871748C0922745Ad94d065a388e95eC420A67EB`, vault v3 `0x776913Abe058941d4c8ac097EE47E29F528f71e6`, agent at `b305196` (root `.env`, template summaries). Owner txs signed in MetaMask (Task 6A) inside a CLI-opened window.

| Claim | Result | Evidence |
|---|---|---|
| Funding: `FUNDER_MNEMONIC` (`qor14zxae5fs0rks778qpdwwlr0aaw48jd4pk5dupt`, `0xa88D…`) signs hybrid; its SDK-derived ML-DSA key equals the registered one (possession not proven, still accepted). 5 QOR each to owner and guardian | OK | `20BBB9CE3E44CF378D24819D21FCA6CD66CFFEB5C1882AFCF6485742266E4B7D` |
| Owner window 600 blocks expired before use (~14 min); MetaMask txs refused at broadcast: "does not admit this transaction (remaining: 0 blocks …): EVM authorisation window exhausted". No hash, no gas | Refused | Page log 03:57 UTC; first window `A239CE82…`, reopened 1800 blocks `C5290997010127437495A5E36A95FE38E43C3DAE9C89BFC50FC1827E942F6585` |
| Guardian window (agent at start) | OK | `0EE681A678902D0E80B9D7CDC3DA737569C14555FA0168CB997B0530BD54FE13` |
| Owner mints 100 fUSD | Success, block 10471875 | `0x89395a3ea368a297786745553e5a45ecfe5bb740ac369856c85e7480f7851fb3` |
| **Approve phishing**: owner `approve(0x5555…5555, max)` on fUSD | Success, block 10471888 | `0xc3b2c4e0e87292bbe676aaa850819c8041b5ba668ad0d01ea1dda2248f9c2cd9` |
| **Guardian rescue on the `Approval`**: seen 0.0 s after the block reached the RPC, sent 0.6 s later | Success, block 10471889 = **1 block** after the approval; owner 100 → 0 fUSD, vault 0 → 100 | `0x27a7bb043e2c9c7135b7a2b7f471407cad07b67be5400244684b6ff25206a278` |
| Incident for the approval: `trigger.kind = "approval"`, `to` = spender, 1/1 rescued | Signed incident | `a753fcba-bb41-4cbe-abac-770ce19a70d2` |
| **Review Focus 7**: owner key lowers the vault allowance, `approve(vault, 1)` | Alert-only incident, `rescues: []`, no rescue tx | tx `0x1ca3b1812d4ad28380a8f58c1a87146bc3861e3b8269b7db8543796c195e15b2`, incident `ea30c2ce-80d8-4ead-8f7b-1f429ffa4a5f` |
| Restore `approve(vault, max)` | No action ("the owner's own setup") | `0x90429203dfd5b712c93d1096f94dc7deb03f74e70734fd645c417384a421e55e` |

## Task 6C: alerts after the rescue on diana (2026-11-21)

Fresh demo owner `0xcfA6Dcc9DC26e3F5C07A953aC8B8D641530A3cf5` (run `20261121T043142Z`), vault `0x575bb2c1a0e423e1ceb7b68d7eb0c88b89310be5`, guardian `0xFf82cAD6638a38d7009D0d5DfB757136B0C03850`, agent at `e139a6a` with Telegram configured (startup log `alerts: telegram`, template summaries). `./demo.sh` one run: PASS.

| Claim | Result | Evidence |
|---|---|---|
| First drain with the leaked ECDSA key (10 fUSD to the attacker) | Success, block 10473248 | `0x1ae2adf83cadfeccd69686f7b457491ae99f7e7adf431c6fd71cb425de848576` |
| **Rescue latency unchanged with alerts on**: detected 04:32:43.151Z, sent 0.6 s later | Success, block 10473250 = **2 blocks** after the first drain (max 3); drains 2 and 3 reverted; 90% kept | `0x9dec4f3e74d800f999882dc1daa1df775f16dbc71d30923f1790745fd9b9581e` |
| Incident signed and recorded | 1/1 rescued | `f0d526dc-8a04-44e9-8443-bb362f094282` |
| **Telegram alert arrives after the rescue tx** (Review Focus 8) | Received by the builder: "Q-Day Guardian: RESCUE, 1/1 rescue tx(s) succeeded", trigger tx, reason, and the rescue tx `0x9dec4f3e…` marked OK, which the agent only knows from the receipt | Telegram chat, 2026-11-21 ~04:32:45 UTC |
| Policy file per owner seeded from env on first start | `data/policy-0xcfa6dcc9dc26e3f5c07a953ac8b8d641530a3cf5.json`, mode 0600 | local file |
| Forged withdraw (a) / agent-key misuse (b) | PASS / PASS | `0x2ecb2040…` reverted `BadSignature`; `6957CAF7…` "authenticator not permitted for this action" |
| Recovery withdraw 1 fUSD to a fresh safe address | Success | `0x7c07521b3f191852ada7f36aba8cd85211591b97523058a5621e69e4a499bb96` |

## Task 6D: dashboard core on diana (2026-11-21)

Branch `task-6d-dashboard-core` at `4a65e4f`. Dashboard `pnpm -F dashboard dev` (Vite, 127.0.0.1:5173), observed in a Playwright browser with a DOM observer timestamping each incident and its "Report verified" badge.

| Claim | Result | Evidence |
|---|---|---|
| diana REST sends no CORS headers (no `Access-Control-Allow-Origin`, even for `Origin: https://dashboard.qorechain.io`; `OPTIONS` → 501); the EVM RPC answers `Access-Control-Allow-Origin: *` | Browser REST reads go through the Vite `/qore-rest` proxy | `curl -D -` read-only, 2026-11-21 |
| `pnpm cli window open` for the root owner `0xE871…67EB` (1800 blocks, 5 txs, targets fUSD/fETH/fBTC/vault/guardian) | OK, "owner window live: 1799 blocks, 5 txs left" | `7D27B15C58861299F9750B0598DF9550816D74FD0E66AAB27033C1352883A9CC` |
| `pnpm cli window close --expect 0x…0001` (wrong owner) | Refused before signing: "--expect … but OWNER_MNEMONIC is 0xE871…: refusing to sign", exit 1, no tx | local run |
| `pnpm cli window close` | OK, "owner window closed" | `48DF539BBBBFDF0607615545074207080D71813F39E0470578BDADB98B5CEC5F` |
| `./demo.sh` with the dashboard open on `#/incidents`: fresh owner `0x759FE6725A1C6C3951016f156249280301083A7E`, vault `0xbfabc2540eb3c7a9dd5574d2b02406aca568663a`, run `20261121T140955Z` | PASS: first drain block 10497500 (`0x1be0f37f…`), rescue block 10497502 = 2 blocks, 90% kept, (a) and (b) PASS | rescue `0xd06e65f596713e5edc84cc178bbb33e512dc8e84f4f03b122ad24bc5f321a809`, recovery `0xf6af61001fd48a39c37fa4801d8c66080e98c2a9aebaaef7b3acc683fba27e2d` |
| **Incident on the dashboard within ≤ 5 s, ✓** (Task 6D Step 4): agent detected the drain 14:10:55.716Z, read the rescue receipt 14:10:59.009Z; the dashboard showed incident `6c092a4f` at 14:10:59.029Z and "Report verified" (signature, linked and active agent key, `Rescued` log from the vault) at 14:10:59.675Z | 4.0 s after detection, 0.7 s after the rescue receipt | incident `6c092a4f-5580-43c2-a5de-9d447bf52ffc` |
| Recover through MetaMask: owner window reopened, `pnpm cli sign-withdraw 0xa88D… fUSD 1` (vault nonce 0), file loaded on `#/recover`, all checks ✓, the builder submitted from MetaMask as the owner | Success, block 10497758, gasUsed 500000, `to` = vault v3; vault nonce 0 → 1, vault fUSD 100 → 99 | window `676DBCC2A6AB88D65D88E6BFCFE8A2E93BCEC0AEE4E9884C5D777175BADD9CF6`, withdraw `0xf21e3904e003ee11c36f48b174888578749ed7e8d4be1f0ec6923c1bc87bd88c`, window closed `5DD46E03C7BFB7D3A09940FBDE84DAD567E7ED84FF0D64C7F6EB601FA5354C38` |

## Task 6E: Rules, Rescue now and gas tank top-up on diana (2026-11-23)

Root owner `0xE871748C0922745Ad94d065a388e95eC420A67EB`, vault v3 `0x776913Abe058941d4c8ac097EE47E29F528f71e6`, guardian `0xFf82cAD6638a38d7009D0d5DfB757136B0C03850`. Branch `task-6e-dashboard-actions`; agent at `899a34d`, then `a4ed21d`. The builder clicked the MetaMask txs on `127.0.0.1:5173`.

| Claim | Result | Evidence |
|---|---|---|
| `pnpm cli window open --topup 0.2 --expect 0xE871…` adds 0.2 QOR of value headroom to the fee budget | OK: 1800 blocks, 5 txs, `maxValue` 1887500 uqor (5 × 337500 fees + 200000) | `9876E87F4BBEE37C9728EBDA8D48D325C5CD3C261CE35C587EC739B0FF72C7F9` |
| Setup for "Rescue now": withdraw 5 fUSD from the vault to the owner (`sign-withdraw` + `withdraw`, vault nonce 1) | Success, gasUsed 500000; owner fUSD 0 → 5 | `0xfe69d281766a628432fa0e0acb26e9fc39edad1558b066c00e8f0cc62285850e` |
| **Rescue now** from the dashboard: the planner listed fUSD only (fETH and fBTC had nothing to move, so no empty tx); MetaMask sent `vault.rescue(fUSD)` from the owner | Success, block 10587982, gas limit 200000, gasUsed 100000; owner fUSD 5 → 0, vault fUSD back to 99 | `0x378117ffada4d9c58df6f333115af5a4e4b3cb8d8f8585c4518472f659641c06` |
| **Gas tank top-up** from the dashboard: 0.1 QOR owner → guardian through MetaMask, fee cap 132.5 gwei checked against the window's `remainingValue` | Success, block 10588017, gas limit 50000, gasUsed 25000; window after the 3 txs: `usedValue` 388125 of 1887500 uqor | `0xa6b34d03e7ea67bbda3d300437d901380c9dc2e958f2ab919270e7f5f8d71c17` |
| **Finding:** the agent (at `899a34d`) treated that top-up as an untrusted outbound transfer | Logged `RESCUE (recipient 0xff82… is not in the allowlist …)`, incident `86fb4b30-a1f1-47f1-94e1-ad73b5f639e9` "0/0 rescued" and a Telegram alert; no rescue tx sent (Review Focus 1 held) | agent log 02:04:36Z |
| Fix `a4ed21d`: a native QOR transfer to the guardian is not a trigger. Second top-up 0.1 QOR with the fixed agent | Success, block 10588335, gasUsed 25000; agent log `ok (gas tank top-up to the guardian)`, no incident, no alert | `0x7eec8c6d06934ed25ebd9c48f8752a11faf2166ab469e5eb27c1ba6576c4103f` |
| **Rules** screen writes through `PUT /policy` from the dashboard origin | Agent log: `policy updated: 1 trusted` (add) → `0 trusted` (remove) → `maxOutbound 500000000000000000000` → `1000000000000000000000` | agent log 02:05:21Z-02:10:09Z |
| The diana explorer has no EVM tx page: `explore.qore.network/tx/0x7eec…` shows "Transaction not found: encoding/hex: invalid byte: U+0078 'x'" (its LCD call `/cosmos/tx/v1beta1/txs/0x…` answers 500), and the same hash without `0x` shows "tx not found" (404) | The dashboard shows EVM hashes as copyable text, checked by their receipts from the EVM RPC | browser check, 2026-11-23 02:13Z |
| `pnpm cli window close --expect 0xE871…` | OK, "owner window closed" | `3AAA928C69B2F17705BA2FF899A6074347B622E42B0EC85DAF9069ABF8D384AE` |

## Task 6E step 4: Turn off protection on diana (2026-11-24)

Fresh owner `0xCCD4384329e5783B7246480016dAf2D4fE8Cb20e` (`qor1en2rssefu4urkujxfqqpdkhj6nlgevswr37qaa`, run `20261124T125220Z`), vault
`0xd6dc8d45f7457e659729285a16ef553635261359`, guardian `0xFf82cAD6638a38d7009D0d5DfB757136B0C03850`. Branch `task-6e-turn-off`. An agent with
that run.env on `:8787`; the builder clicked the MetaMask txs on `127.0.0.1:5173/#/rules`.

| Claim | Result | Evidence |
|---|---|---|
| `fresh-owner` + `setup`: protected owner (window + link, `approve(vault, max)` × 3) | fund `8C95BFE3…`, register `E7F95344…`, deploy `0x5203f7a5…`, approvals `0x9649cb01…`, `0x603ffcae…`, `0x703c6bdc…` | window + link `D1651352FDB185F351DFB6AA59E033DF8CCD561E61B018BDF1F3BBC6879DF1C3` |
| **Revoke 3 allowances** from the Turn off protection card: `approve(vault, 0)` for fUSD, fETH, fBTC from MetaMask inside the scoped owner window (`window open` `7123AD60…`) | 3 × success from the owner (blocks 10668391 / 10668395 / 10668398); allowances read back 0, 0, 0 | `0xa1c0c87b1d83b66445438c3f967ddcc2defe4a00391a4da795d95bfa539fa740`, `0x67d9eb00aa71c52afa89f204b7974d6d82d2d020e83acdbf8f61a73ed94c80a0`, `0xdb828cb5cd70ef3da4785a9c6a4f91ca9f7289b53378949b8fd97014928c3b98` |
| The agent raises an alert, no rescue, for each `approve(vault, 0)` (Review Focus 7) | 3 incidents "the vault allowance was lowered to 0 (revoked)", 0 rescues each, Telegram alerts | `GET /incidents` 12:57:02Z-12:57:12Z |
| `pnpm cli unlink --expect 0xCCD4…`: `MsgRevokeAuthenticator` for the Guardian's ed25519 key, one hybrid tx | authenticator `f35d7d95…` read back `revoked: true`; a second `unlink` refused before signing ("already revoked") | `4E7871265C31168446437A51F28C6ECE269CB7ACD7A74FD5098B582429BE02E4` |
| **Chain fact 21:** re-linking a REVOKED key to the same account is accepted (`pnpm cli link`, 2 msgs) | the same key reads `revoked: false`, new `createdAtUnix`, new expiry; rule `0xd6dc…1359/0x839006f2 (denoms uqor)` | `D06BA5BDB7668AA30422E89E679B34C0BF19CB6B08F4086B06FAB5C0F6803746` |
| Unlink again (owner topped up 0.5 QOR first: `0F0625C9…`; a hybrid tx needs 0.225 QOR of fees) | revoked again | `12B951E7F062FF8CC564963101ADD6784ACF03972DC438A03BBE88BD12DEF862` |
| The card ticks each step from the chain or the agent | ✓ "No allowance left", ✓ "No live Guardian key", and after the agent was stopped ✓ "The agent does not answer" | browser check 13:0xZ |

## Task 6F: Protect onboarding on diana (2026-11-23)

Fresh owner `0xd823806154A2546184D23BE2cf775d14497adF1E` (`qor1mq3cqc255f2xrpxj803v7a6az3yh4hc768p2vn`, run `20261123T025547Z`), onboarded
from the dashboard's Protect screen (`127.0.0.1:5173/#/protect`) with MetaMask and the CLI commands it shows. Guardian
`0xFf82cAD6638a38d7009D0d5DfB757136B0C03850`. Branch `task-6f-protect` at `f495ba2`. The builder imported the fresh mnemonic into
MetaMask and clicked the txs.

| Claim | Result | Evidence |
|---|---|---|
| `pnpm cli fresh-owner --no-vault` (FRESH_FUND_UQOR=3000000): fund, register ML-DSA-87 key, mint 100 fUSD, no vault | fund `A45DC73C…`, register `DB8BF57E…`, deploy window `329B6E00…`, mint | `0xf868ff893db995695c9af6e66b4b9ee937fb9245b254a41fd8e0c82e6cf16753` |
| `pnpm cli window open --onboard --topup 0.1 --expect 0xd823…`: UNSCOPED owner window (no `allowedTargets`), 1800 blocks, 5 txs | OK, "1799 blocks, 5 txs left" | `E4CA473F9F16803544CEE411161ACDA8BFC941C9A56912F9B90F5F5AD167E8CB` |
| **Deploy vault from MetaMask** inside the unscoped window: `GuardianVault(owner = connected wallet, guardian)`, gas limit 950000; the screen read `owner()`/`guardian()` back before saving it | Success, block 10590803, gasUsed 725168, vault `0x4c53a244eb1747916b10e4fd669bbe6760e779a8` | `0x469bba2ae862da412de909ca8a3f3fdd8aa0d5bd34df7cf16a954743eb34f3c3` |
| **Approve** fUSD, fETH, fBTC to the vault (`maxUint256`, gas limit 100000 each) from MetaMask | 3 × success, gasUsed 50000 each, blocks 10590809 / 10590819 / 10590823 | `0x2731e678a791ebd2ec0a4e8f78681737c6af5ae6e6e07b0dfe7f96960646ccb3`, `0x864a39944bb4e24b20c589e23447891b68ab1719303fb7c4dec45f54d4f5d7ac`, `0x7badaa580ee980d254f2776b56fbd945d199cc01ff37d6ab4cf5648b29964d3a` |
| `pnpm cli link --expect 0xd823…` (run.env loaded, `VAULT_ADDRESS` exported): vault roles checked on chain before signing, 2 link msgs, no window msg | rule read back: `0x4c53…79a8/0x839006f2 (denoms uqor)` | `AAC92F42B956B5553B08A6426612FF79532245813FA1F2F75E1DD8AC7FF71128` |
| Agent started for this owner (run.env + `VAULT_ADDRESS`); `/config` names the new owner and vault; the Guardian step turned ✓ | `/health`: guardian window live, gas 4.0 QOR, not low | `GET /config`, `GET /health` 03:13Z |
| **Gas tank top-up** 0.1 QOR from MetaMask (5th and last tx of the onboarding window, which then showed "used up its txs") | Success, block 10590948, gasUsed 25000; gas tank 4.1 QOR | `0x1364b48306711ec92c5e387ab3a52501e5d29327bae7fb259db8f079b7b5c4bc` |
| Trusted list step closed with "Continue without" (`GET /policy`: 0 trusted), recovery address saved locally; all 6 steps ✓, Overview "No exposure right now" | builder screenshot 10:15 local | `GET /policy` 03:2xZ |
| Attack on the onboarded owner: scoped `window open` `A9EC2216…`, `pnpm cli attack`, `demo-check --wait 60` | drain 1 `0x695756c8…` (block 10591084) landed, drains 2-3 reverted; rescue 2 blocks later; (a) forged withdraw `BadSignature` `0x780c98bf…` reverted; (b) agent-key `transfer` refused `F67DF2EA…` | rescue `0x3c1a274902ff3fd9e207127f79f4020ae955ac8935630a7da35dc42d2303df3a`, incident `2e32c49c-2817-4eb2-95fc-0cc44a78f548` |
| Recovery: `sign-withdraw` 1 fUSD to the safe address + `withdraw` from the owner's window; final `demo-check` | withdraw success (to 0 → 1), **RESULT PASS**: 2 blocks (max 3), 90.00% kept, (a) PASS, (b) PASS | `0x73c1f69465ebfb68b30828a379df1beaffde6ec0e9fc3dedf213fccf02b29f25` |

## Task 6G: Fire drill on diana (2026-11-24)

Drill guardian `0x77e6311b681Ac3D4b6E0C3b13e53CF381692C115` (`qor1wlnrzxmgrtpafdhqcwcnu5708qtf9sg46d5xga`), a separate account from the
real guardian `0xFf82cAD6638a38d7009D0d5DfB757136B0C03850`. Branch `task-6g-drill` at `dcf7350`. The main agent ran with the root `.env`
(watching `0xE871748C0922745Ad94d065a388e95eC420A67EB`, vault `0x776913Abe058941d4c8ac097EE47E29F528f71e6`) and the drill was started from
the dashboard's Fire drill screen (`127.0.0.1:5173/#/drill`, "Run drill").

| Claim | Result | Evidence |
|---|---|---|
| `pnpm cli drill-guardian init`: new account, file `~/.config/qday/drill-guardian.env` (0600) written before any QOR moves, top-up to 2 QOR, ML-DSA-87 key registered classically | fund 2 QOR from the funder, then register | fund `9C41AE85BDA4467B5BE3DBC3EB80903C505CF1137778B0A36BF07AEC21DEF20A`, register `F5F9ECFDDED8B0946B4AD46B57564717A739425F64429B67A321B4CE6F4697FD` |
| `init` again: reuses the file; the register fee had left 1.775 QOR, so it tops up to the target | 0.225 QOR top-up, "already registered" | `E13BB05E8A4F411E6C0F6E8C3C6D86C22740400CDAC6361EAEEB8C0750D42AD6` |
| `init` a third time sends nothing | "balance 2 QOR is at or above the target 2 QOR: no top-up", "ML-DSA-87 key already registered" | CLI output 08:1xZ |
| **Run drill** from the dashboard: the agent spawned `demo.sh --drill`; stages streamed live over `/drill/events` | 7 stages ✓, 86 s from start to verdict | run `20261124T081242Z` |
| Throwaway owner `0x7DD65Fc8c7BF7999515F17F205fe5469c08BC061`: fund 1.5 QOR, register, deploy `GuardianVault(owner, drill guardian)` | vault `0x43e260d5209acaea491f8c8c8a50995d4f7b6966` | fund `E2A9ED79…`, register `E1A6B72E…`, deploy `0x2753fbde8085d769a7f3b1a5824d22a8d451256ac2b72acf56dfd116053cfd52` |
| The drill agent ran on `:8788` with the drill guardian, no alerts | log "guardian 0x77e6…C115 watching 0x7DD6…C061 … API on :8788; alerts: none" | `drill.log` in the run dir |
| Attack: drains 1-2 landed (blocks 10656479, 10656480), drain 3 reverted; rescue in block 10656481 | **RESULT PASS**: 2 blocks (max 3), 80.00% kept (vault 79 + recovered 1 of 100 fUSD), (a) forged withdraw `BadSignature` reverted, (b) agent-key `transfer` refused | rescue `0x12f053a8f9da582e8f008be690380fe21d1ee84787a8687cf1554de33d049f66`, incident `bc9d0837-0373-4cf5-a239-b5fec7a7d3bc` |
| Recovery withdraw of 1 fUSD to the safe address | success, gasUsed 500000 | `0xfa095ea53496d4444f1ba3ca0145180e73c985b287ec7dd411dc04733c4b8331` |
| `verdict.json` (mode `drill`) listed by `GET /drill/runs` and the Past runs table | PASS, blocks 2, kept 80.00% | `GET /drill/runs` 08:14Z |
| The real owner was not touched: the drill incident is not in `data/incidents.jsonl` (0 matches; `/incidents` still ends 2026-11-23), and the main agent opened no guardian window after its startup open (its window stayed scoped to the real vault) | main agent log: one `guardian window opened` at 08:12:30Z, none during the drill | startup open `AA49D05C3B5F984ABE148692FF7D7937C19A907C9E94C9587AD57E46B5024FE2` |
| Second drill from the screen after the final-review fixes (`bc2203d`: separate funder required, drill port and lock checks, `drill-guardian check` before fresh-owner) | `drill-guardian check` passed (1.5332 QOR); drain 1 landed (block 10657407), drains 2-3 reverted; **RESULT PASS**: 1 block, 90.00% kept, (a) and (b) PASS; no `drill.lock` left; still nothing in `data/incidents.jsonl` | run `20261124T083451Z`, vault `0xa42e899a88bae2b51f447f4d0022e1f96ea942c6`, rescue `0x97ccf223eebafc2d02615a7b6f6e799973f0be1634606a45847d90357aa1af46`, withdraw `0xeff9257393e17cb023edf26cb5e250e329a74f46d54502e7502f3d2391f230d1` |

## Task 7: approval phishing race on diana (2026-11-24)

`./demo.sh --phish` (branch `task-7-submission`): each run is a fresh owner (`fresh-owner` + `setup`), its own agent on `:8787` with
the guardian `0xFf82cAD6638a38d7009D0d5DfB757136B0C03850`, then `pnpm cli phish`. The drainer is the funder's EVM account
`0xa88DDcD13078eD0f78E00b5cEF8DfDEBaA7936a1` (not on the trusted list, checked through `GET /policy`), which opens its own window
scoped to fUSD. The owner signs `approve(drainer, max)` on its 100 fUSD; the drainer sends `transferFrom(owner, drainer, 100 fUSD)`
with a fixed gas limit (so a losing pull is still mined and recorded). Each run writes `phish.json` in its run dir.

| Run | Drainer delay | Approve (block) | Drainer `transferFrom` (block, status) | Guardian rescue (block) | Result |
|---|---|---|---|---|---|
| `20261124T131335Z` | 0 (at once) | `0xb6f954cb9276a0d22be87abb33726a60f8d57051adca0fdd0fdc9f4a255e1eba` (10669127) | `0x1b65a1a0844e471d14e8578221653068e0ef025e2c4bc490d7492cc1c6486aaf` (10669129, reverted) | `0xb31a57938ef497f642de3219f66569205fb7f8fcdcd9dbb49bc7914956191744` (10669129, ordered first) | **PASS**: 100% kept, drainer 0 |
| `20261124T131459Z` | 0 (at once) | `0x584fbd8d351a8b09ef59f792cecd6f832bb4eb0aea5ab1d0271dd13ab7d06faf` (10669188) | `0xd18ed6affb44e585a7cef7ab191cf4d0f73087e82e57294a8b700438045412ae` (10669189, success) | `0xc9d95144c5abcc8fcebd534ff03fd2c9d1f0b0086948e6fbab8ef51e8b548a51` (10669190, nothing left) | **FAIL**: drainer took 100 fUSD |
| `20261124T131915Z` | 2 blocks | `0x6ec177d48f075f5d1324b01f9333449ae8d2b90d2c691515de2e95e31d304f6e` (10669368) | `0x857836168785f4844475bfa6c087d64f3493916de9eb47b26913ec3e3102d9d7` (10669372, reverted) | `0x046c1c0fabe8e48f8e5a10837caa97e11d2cdd8d47542502cb652ee22e00c45c` (10669370) | **PASS**: 100% kept, drainer 0 |
| `20261124T132026Z` | 2 blocks | `0xb031b0c3156cbb9378be40fc0f3c36baf5b20a2f27adfb3d15f91a943a065cbb` (10669418) | `0xb31899976899294d92b2909c5d7ea0001ee2339c206e5d443925b16bef090796` (10669422, reverted) | `0xe5b811015a1bdb1550fcfe375350909e7ae113da4b988de54e2fdce26bfb8cd9` (10669420) | **PASS**: 100% kept, drainer 0 |
| `20261124T132950Z` (after the review fixes: `/config` and `/policy` prechecks, unmined-pull FAIL) | 2 blocks | `0xdc722b3d698d4afdd42f8a83e9341f117e01e65c0f33765decf2b7b2223e22a9` (10669816) | `0x09970fd335f1bd558ca8ca623a1d3b8865a87a8d68e84e7b7e99c3de0e90a81b` (10669820, reverted) | `0xefc3c5037612b5f4c410d7f85622a5dc68559e68bf67c8142539826643c50345` (10669817) | **PASS**: 100% kept, drainer 0 |

The rescue landed 2 blocks after the approval in 4 runs and 1 block in the last (~1.4 s blocks: 10669368 → 10669418 took 71 s). A drainer that fires
as soon as it sees the approval can land 1 block after it and win. In run `20261124T131335Z` the pull shared the rescue's block and
was ordered after it because the rescue tips 40 gwei (`apps/agent/src/rescue.ts`) and the demo drainer used viem's default tip: a
drainer that outbids that tip wins there too. With `--drainer-delay 2` the pull landed 4 blocks after the approval, 2 after the
rescue (THREAT_MODEL T13, Honest limits).

## Submission gap 1: agent link renewed for 30 days (2026-11-24)

Root owner `0xE871748C0922745Ad94d065a388e95eC420A67EB`, agent key `1cb28515…8a38`, which was due to expire 2026-11-27 08:01 UTC (7-day
TTL). `AGENT_TTL_SECONDS` raised to 30 days (branch `task-8-submission-gaps`). `link` does not renew a live key, so it was renewed
the way chain fact 21 proved.

| Claim | Result | Evidence |
|---|---|---|
| `pnpm cli unlink --expect 0xE871…` | key read back `revoked: true` | `9D90D5128F41827EDD5F8EC47A9F7B906854C1A557B9458C6B9082AD4549B03B` |
| `pnpm cli link --expect 0xE871…` with a 30-day expiry: diana accepts it | same key `revoked: false`, `createdAtUnix` 2026-11-24T13:51:34Z, `expiryUnix` **2026-12-24T13:51:33Z**; rule `0x7769…71e6/0x839006f2 (denoms uqor)` | `1D5FEE885111FA58FB57300637A35CED7265275F4CE6E48F33539E2B8B2B2934` |
| Dashboard Incidents for the root owner | 5 of 5 reports ✓; "The key is not revoked or expired: active until 2026-12-24T13:51:33.000Z" | browser check 13:52Z |

