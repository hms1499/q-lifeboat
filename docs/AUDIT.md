# Audit

Two-stage QCAI audit (dashboard.qorechain.io → AI Audit, setting **Ethereum (EVM/Solidity)**),
following the workshop-2 flow. An AI audit does not replace a human audit before mainnet.

| Stage | Contract version | Date | Score / risk | Report |
|---|---|---|---|---|
| 1 | draft | _pending (Task 2)_ | | `docs/audit/stage1-*.md` |
| 2 | final | _pending (Task 7)_ | | `docs/audit/stage2-*.md` |

## Stage 1 findings and how each was handled

| # | Severity | Finding | Fix / test / explanation |
|---|---|---|---|
| | | _pending_ | |

## Post-quantum design (not scored by QCAI)
The QCAI quantum-readiness rating shows "Not scored" for Solidity. That is expected: the ML-DSA-87
check runs in the chain's `pqcVerify` precompile (`0x…0a01`), and key registration plus proof of
possession are read via `pqcKeyStatus` (`0x…0a02`). See `docs/THREAT_MODEL.md` (T2, T3).
