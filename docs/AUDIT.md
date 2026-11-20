# Audit

Two-stage QCAI audit (dashboard.qorechain.io → AI Audit, setting **Ethereum (EVM/Solidity)**),
following the workshop-2 flow. An AI audit does not replace a human audit before mainnet.

| Stage | Contract version | Date | Score / risk | Report |
|---|---|---|---|---|
| 1 | v1 (`a069e98`) | 2026-11-20 | 85/100, MEDIUM, 4 findings | [`docs/audit/stage1-2026-11-20.md`](audit/stage1-2026-11-20.md) |
| 2 | final | _pending (Task 7)_ | | `docs/audit/stage2-*.md` |

## Stage 1 findings and how each was handled

| # | Severity | Finding | Fix / test / explanation |
|---|---|---|---|
| 1 | HIGH | Missing access control on `rescue` (line 59) | **Fixed.** Anyone could sweep the owner's approved tokens into the vault at any time (griefing: the owner then needs an ML-DSA withdrawal) and emit `Rescued` for any token. Theft was never possible: funds only move owner → vault. Now `if (msg.sender != owner) revert NotOwner()`. The Guardian agent still works because the authenticator lane executes `MsgExecuteEVM` from the owner's EVM address, proven on diana (agent rescue tx `52B81C08…`; a stranger gets `NotOwner`). Test: `test_rescueRevertsForNonOwner`; the other rescue tests call as the owner |
| 2 | MEDIUM | Nonce management (line 67) | **False positive, no change.** Line 67 is the `view` that builds the signed message. `withdraw` bumps the nonce (line 82 in v1) after the signature check and before any external call, and the message binds the nonce. Tests: `test_nonceIncrementsBeforeTransfer`, `test_signatureWorksOnce` (Review Focus 3) |
| 3 | LOW | "Unbounded loop" in external calls (lines 81, 87); use SafeERC20 | **Fixed (the substance).** There is no loop. The valid point was token return handling: a malformed return used to bubble up as an empty revert. `_succeeded` now follows OpenZeppelin SafeERC20 semantics without the dependency: empty return needs code at the token, otherwise ≥ 32 bytes whose first word is 1. Tests: `test_noReturnTokenWorksForRescueAndWithdraw`, `test_badReturnTokensRevertTransferFailedOnRescue`, `test_badReturnTokensRevertTransferFailedOnWithdraw` (false, 1-byte, word 2) |
| 4 | INFO | ERC20 interface usage (line 91) | No action, compliant |

v1 (`0x8A11587A08F509781c0ce190EeaD715e4d81b0A5`) is retired; v2 with these fixes is at
`0x17d867860a0A0Ff528dF655439ff59176b061B3C` (`docs/EVIDENCE.md`).

### QCAI #1 follow-up (Task 4D, 2026-11-20): `rescue` is owner-or-guardian

The owner-only fix relied on the authenticator lane calling `rescue` from the owner's address. On diana
that lane now refuses a token move from the account unless the token is listed in the key's spending
rule (tx `8508B568…`), and listing it lets the key call the token's `transfer` directly (tx `CADB1412…`).
So the agent rescues from its own account instead, and the vault (v3) takes an immutable `guardian` at
deploy: `if (msg.sender != owner && msg.sender != guardian) revert NotAuthorized()`, `ZeroGuardian` on a
zero guardian, no setters, `rescue`'s body unchanged (funds still only move owner → vault) and `withdraw`
unchanged. The finding's concern still holds: a stranger cannot sweep or emit `Rescued`. Tests:
`test_guardianCanRescue`, `test_rescuePullsAllowedBalance` (owner), `test_rescueRevertsForStranger`
(`NotAuthorized`), `test_constructorRejectsZeroGuardian`, `test_guardianCannotWithdrawWithoutSignature`,
`test_guardianGetterReturnsConstructorValue`. The shared withdrawal-message vector is unchanged (the
message has no guardian field). **Stage 2 must re-check the guardian path.**

## Post-quantum design (not scored by QCAI)
The QCAI quantum-readiness rating shows "Not scored" for Solidity. That is expected: the ML-DSA-87
check runs in the chain's `pqcVerify` precompile (`0x…0a01`), and key registration plus proof of
possession are read via `pqcKeyStatus` (`0x…0a02`). See `docs/THREAT_MODEL.md` (T2, T3).
