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
