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
| Agent ed25519 | Guardian agent | Only `GuardianVault.rescue(token)` on behalf of the owner (chain-enforced) |
| Gas wallet | Guardian agent | Pays fees for the agent's requests. Holds no owner funds |

## Threats

| # | Threat | Mitigation | Residual risk |
|---|---|---|---|
| T1 | Attacker with the leaked ECDSA key drains EVM assets | Scoped EVM window caps blocks, txs and value. The Guardian sweeps the remainder into the vault within ≤ 3 blocks | Spending rules do **not** bind the owner key (verified), so the **window budget is the only hard cap**. The first drain tx(s) before detection are lost |
| T2 | Attacker tries to withdraw from the vault | `withdraw` requires `pqcKeyStatus` registered + proven and a valid ML-DSA-87 signature over tag, chainId, vault, to, token, amount and nonce | None known. A quantum adversary would need to break ML-DSA-87 |
| T3 | Attacker replays an old withdrawal signature | Nonce is bound in the message and bumped before the transfer | |
| T4 | Agent key is stolen or the agent is prompt-injected | Chain rule `allowedEvmCalls=["<vault>/<rescue selector>"]`, no `erc20/*` denoms. The agent can only push the owner's funds into the owner's vault. The LLM has no say in actions | An attacker could trigger needless rescues (funds still end up safe) |
| T5 | Attacker revokes the vault's allowance (`approve(vault, 0)`) before the rescue | Race. The Guardian reacts per block | Real risk, shown honestly in the demo |
| T6 | Attacker exhausts the window's tx budget to block the rescue | Not possible: the authenticator lane works with the owner's window **closed** (verified) | |
| T7 | False positive: Guardian sweeps on a legitimate owner transfer | Allowlist of known recipients. Funds only move into the owner's own vault | Owner pays fees and needs one ML-DSA withdrawal to undo |
| T8 | Forged incident report on the dashboard | Reports are signed by the agent key. The dashboard checks the key is a currently linked, non-revoked authenticator on-chain | |
| T9 | Owner's registered PQC key uses a weaker algorithm than ML-DSA-87 | `GuardianVault` ignores `algorithmId` from `pqcKeyStatus`, like the workshop vault, and trusts the chain registry | Holds only if diana registers ML-DSA-87 keys alone. The demo owner's key was checked on diana (2026-11-20): `algorithmId` 1 = ML-DSA-87, 2592-byte pubkey (`docs/EVIDENCE.md`). If the chain adds another algorithm, a new vault must check the id |
| T10 | Spoofed `Rescued` events or griefing: a third party calls `rescue` to sweep the owner's approved tokens into the vault, or emits `Rescued` for a token it controls | Since QCAI Stage 1, `rescue` is owner-only (`NotOwner`); the agent passes because the authenticator lane calls from the owner's address (proven on diana). Agent and dashboard still count only `Rescued` events for the fUSD/fETH/fBTC allowlist | Whoever holds the owner's ECDSA key (including an attacker) can still call `rescue(anyToken)`: harmless, it only moves funds into the vault, but events must stay filtered (Tasks 4 and 6) |

## Assumptions
- The owner's ML-DSA-87 key (mnemonic) is **not** compromised. It is the root of recovery.
- Testnet only. QoreSeal / confidentiality is out of scope: addresses, amounts and timing are public.
