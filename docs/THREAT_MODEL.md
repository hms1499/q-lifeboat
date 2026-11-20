# Threat model

Draft. Updated as the design and testnet findings change.

## What is protected
Assets the owner holds **on the EVM lane** of QoreChain (QOR and ERC-20s such as fUSD/fETH/fBTC).

**Out of scope:** native-lane transactions. QoreChain already requires a hybrid secp256k1 +
ML-DSA-87 signature for them, so a leaked ECDSA key alone cannot move native funds.

## Actors and keys
| Key | Holder | Can do |
|---|---|---|
| Owner ECDSA (secp256k1) | owner, **assumed leaked** | Send EVM txs while the owner's EVM window is open, up to its budget |
| Owner ML-DSA-87 | owner, offline Guardian Signer | Open windows (hybrid), link/revoke the agent, sign vault withdrawals |
| Agent ed25519 | Guardian agent | Signs incident reports. Linked to the owner's account with `allowedEvmCalls=[vault.rescue]`, `allowedDenoms=["uqor"]`: the chain refuses its direct token calls (tx `7E9B629F…`). It no longer performs rescues |
| Guardian ECDSA + ML-DSA-87 (`GAS_MNEMONIC`) | Guardian agent | The vault's immutable `guardian`: calls `vault.rescue(token)` as plain EVM txs inside its own EVM window (vault as the only target), which it opens with its hybrid signature. Pays its own fees. Holds no owner funds |

## Threats

| # | Threat | Mitigation | Residual risk |
|---|---|---|---|
| T1 | Attacker with the leaked ECDSA key drains EVM assets | Scoped EVM window caps blocks, txs and value. The Guardian sweeps the remainder into the vault within ≤ 3 blocks | Spending rules do **not** bind the owner key (verified), so the **window budget is the only hard cap**. The first drain tx(s) before detection are lost |
| T2 | Attacker tries to withdraw from the vault | `withdraw` requires `pqcKeyStatus` registered + proven and a valid ML-DSA-87 signature over tag, chainId, vault, to, token, amount and nonce | None known. A quantum adversary would need to break ML-DSA-87 |
| T3 | Attacker replays an old withdrawal signature | Nonce is bound in the message and bumped before the transfer | |
| T4 | Agent keys are stolen or the agent is prompt-injected | **Guardian ECDSA key:** the vault lets it call `rescue` and nothing else, and `rescue` only moves the owner's approved tokens owner → vault. Its EVM window targets only the vault, and opening a new window needs its ML-DSA-87 key too. **Agent ed25519 key:** rule `allowedEvmCalls=["<vault>/<rescue selector>"]`, `allowedDenoms=["uqor"]` with no `erc20/` denom, so a direct `token.transfer` is refused (tx `7E9B629F…`) and a call through the vault cannot move tokens from the account either (tx `8508B568…`). The LLM has no say in actions | An attacker with the guardian ECDSA key can trigger needless rescues (funds still end up in the owner's vault) and burn the guardian's window budget and QOR. With the ed25519 key it can spend at most the uqor limits (1 QOR per tx, 3 QOR per day) of the owner's account on calls the rule allows. **Finding (Task 4C):** listing a token as `erc20/<addr>` in a spending rule lets the linked key call that token's `transfer`/`approve` directly, whatever `allowedEvmCalls` says; `denomLimits` only caps the amount (tx `CADB1412…`). That is why the agent no longer rescues through the authenticator lane |
| T5 | Attacker revokes the vault's allowance (`approve(vault, 0)`) before the rescue | Race. The Guardian reacts per block | Real risk, shown honestly in the demo |
| T6 | Attacker exhausts the window's tx budget to block the rescue | Not possible with the owner's key: the rescue txs run in the **guardian's own** window, which the owner's ECDSA key cannot use, open or close. The agent re-opens it when it runs low (checked every 30 s and before a rescue) | The guardian must stay funded with QOR for window fees and gas |
| T7 | False positive: Guardian sweeps on a legitimate owner transfer | Allowlist of known recipients. Funds only move into the owner's own vault | Owner pays fees and needs one ML-DSA withdrawal to undo |
| T8 | Forged incident report on the dashboard | Reports are signed by the agent key. The dashboard checks the key is a currently linked, non-revoked authenticator on-chain | |
| T9 | Owner's registered PQC key uses a weaker algorithm than ML-DSA-87 | `GuardianVault` ignores `algorithmId` from `pqcKeyStatus`, like the workshop vault, and trusts the chain registry | Holds only if diana registers ML-DSA-87 keys alone. The demo owner's key was checked on diana (2026-11-20): `algorithmId` 1 = ML-DSA-87, 2592-byte pubkey (`docs/EVIDENCE.md`). If the chain adds another algorithm, a new vault must check the id |
| T10 | Spoofed `Rescued` events or griefing: a third party calls `rescue` to sweep the owner's approved tokens into the vault, or emits `Rescued` for a token it controls | `rescue` is callable only by the owner or the immutable `guardian` set at deploy (`NotAuthorized` otherwise; no setters). The agent reads `Rescued` logs emitted by the vault in its own rescue receipt, and agent and dashboard count only the fUSD/fETH/fBTC allowlist | Whoever holds the owner's or the guardian's ECDSA key can still call `rescue(anyToken)`: harmless, it only moves the owner's funds into the vault, but events must stay filtered (Tasks 4 and 6). A leaked guardian key cannot be rotated: redeploy the vault with a new guardian |

## Assumptions
- The owner's ML-DSA-87 key (mnemonic) is **not** compromised. It is the root of recovery.
- Testnet only. QoreSeal / confidentiality is out of scope: addresses, amounts and timing are public.
