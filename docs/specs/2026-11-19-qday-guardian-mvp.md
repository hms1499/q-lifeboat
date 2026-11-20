# Q-Day Guardian: MVP Spec

Hackathon: QoreChain Build Before Q-Day · Category: **Post-Quantum AI Agents** (+ Best AI-Native)
Testnet: `qorechain-diana` (EVM chain ID 9800) · Team: solo · Deadline: 2026-12-02 23:59 UTC (feature freeze: 2026-11-30)

## 1. One-line description

An **owner** with assets on the EVM lane lets a **Guardian agent** watch the account. When the ECDSA
key leaks and an attacker starts draining, the agent **sweeps what is left into `GuardianVault`**,
which only opens with the owner's ML-DSA-87 signature.

> Honest scope: native-lane transactions on QoreChain already require a hybrid signature. A leaked
> ECDSA key only does damage inside an **open EVM window** and to assets on the EVM lane. The
> Guardian covers exactly that gap.

## 2. Must-haves (3)

1. **`GuardianVault.sol`** (Foundry)
   - `rescue(token)`: pulls all of the owner's fUSD/fETH/fBTC into the vault through a pre-approved
     allowance. `deposit()` takes QOR.
   - `withdraw(to, token, amount, mldsaSig)`: checks `pqcKeyStatus` (0x…a02: registered and proven),
     then `pqcVerify` (0x…a01). The message binds tag, chainId, vault address, to, token, amount and nonce.
   - `rescue` may be called by the owner or by an immutable `guardian` (the agent's own EVM account),
     fixed at deploy. Funds only ever move owner → vault, whoever calls.
   - No setters. `owner` and `guardian` are immutable. Two-stage QCAI audit.
2. **Guardian agent** (Node/TS)
   - Rescues from its own **guardian EVM account** (`GAS_MNEMONIC`): plain `vault.rescue(token)` txs inside
     the guardian's own EVM window, scoped to the vault only and opened with the guardian's hybrid
     (secp256k1 + ML-DSA-87) signature. (Changed 2026-11-20: on diana the authenticator lane now refuses
     a token move from the owner's account unless the token is listed in the key's spending rule, and
     listing it lets the key `transfer` the token directly; see `docs/EVIDENCE.md` "Task 4".)
   - An ed25519 key linked to the owner's account in one hybrid tx: permission `evm`,
     `allowedEvmCalls = [GuardianVault.rescue]`, `allowedDenoms = ["uqor"]`, with per-tx, daily and expiry
     limits. It signs the incident reports and proves that the chain refuses a direct token call (demo 4(b)).
   - Watches the owner's EVM address every block. Detection rule: an outbound tx to an address not on
     the allowlist, or above a threshold. On a match it calls `vault.rescue(token)` for fUSD/fETH/fBTC.
     `deposit()` QOR is not swept by the agent: QOR on the EVM lane stays the owner's (window budget cap).
   - The LLM writes the incident report. The report is signed with the agent key (authenticated
     messaging) so the dashboard can verify it.
3. **Dashboard** (React + `@qorechain/react`)
   - Setup: open the scoped window, approve the vault, link the agent.
   - Live: window budget, agent rules, `pq status`, incident timeline with signature checks.
   - Recover: load a signature from the **Guardian Signer**, a local page or CLI that signs ML-DSA with
     `pqcSign`. This is needed because QoreX refuses `signArbitrary`.

## 3. Non-goals

- Mainnet, real funds, protecting the native lane (the chain already does that).
- ML-based anomaly detection. Fixed rules only. The LLM only explains incidents and **never decides
  to move funds**.
- The agent closing the window or revoking keys: those messages can't be delegated.
- Multiple owners, multiple agents, multisig, tokens other than QOR/fUSD/fETH/fBTC.
- QoreSeal/ML-KEM, Cross-VM, mobile app, Telegram or email notifications.

## 4. End-to-end demo (≤ 3 minutes)

1. **Setup:** the owner holds 100 fUSD + 10 QOR on the EVM lane, opens a scoped window, approves the
   vault and links the Guardian in one hybrid tx. The dashboard shows the rules.
2. **Attack:** `attacker.ts` uses the leaked ECDSA key to move fUSD out.
3. **Rescue:** within ≤ 3 blocks the agent calls `rescue()` and the remainder lands in the vault. The
   dashboard shows a signed, verified incident report.
4. **The attacker tries again and fails:**
   - (a) `vault.withdraw` with a forged signature reverts.
   - (b) Forcing the agent to send elsewhere is refused by the chain (abstractaccount permission error).
5. **Recovery:** the Guardian Signer signs with ML-DSA and the vault pays out to a new safe address.
   `qore pq status` shows the evidence.

## 5. Required QoreChain features

| Feature | Used for |
|---|---|
| Hybrid signature (secp256k1 + ML-DSA-87) | Agent link tx, opening the owner's window and the guardian's window |
| Scoped EVM window (`allowed_targets`, block/tx/value budget) | Caps the damage when the owner's ECDSA leaks; the guardian's window targets only the vault |
| Authenticator lane + spending rules (`perTxLimit`, `dailyLimit`, expiry, `allowedEvmCalls`, `allowedDenoms=["uqor"]`) | The agent's ed25519 key: signs incident reports; the chain refuses its direct token calls (demo 4(b)). Rescues no longer go through this lane |
| `pqcVerify` + `pqcKeyStatus` precompiles | `GuardianVault.withdraw` |
| Signed messages | Authenticated incident reports (agent ed25519 key, checked against the on-chain authenticator list) |
| MCP / `qore-cli pq status` | Evidence of each tx's protection level |
| Two-stage QCAI audit | `docs/audit/`, `docs/AUDIT.md` |

## 6. Success criteria (MVP "done")

- [ ] `forge test` passes: rescue, withdraw with a valid signature, bad signature, replay, key not
      proven, wrong token/amount.
- [ ] Vault deployed on diana, address in the README.
- [ ] `demo.sh` passes **3 runs in a row** from fresh accounts: detection-to-rescue ≤ 3 blocks,
      ≥ 80% of value kept.
- [ ] A tx hash or error code proving the chain refuses an agent call outside the target.
- [ ] Audit Stage 1 and Stage 2 with a findings table.
- [ ] Submission checklist complete: public MIT repo, README credits workshop-2 and the kits, 16:9
      image, video ≤ 3 minutes, qor1 addresses, `AI_USAGE.md`.

## 7. Task 0 spike results (2026-11-19, diana). Log: `spike/spike-run-1.log`

| # | Question | Result | Evidence (tx) |
|---|---|---|---|
| 1 | Can `allowedEvmCalls` restrict to contract + selector? | ✅ Yes. `A.pull` OK. `A.ping` (same contract, other function) and `B.ping` refused: "authenticator not permitted for this action" | `D17AD5F7…`, `85CA4813…`, `D5DAAD0A…` |
| 2 | Do token `transferFrom`s inside the contract count against the limits? | ✅ No. Pulled 1000 tokens with perTx 1 QOR. Limits only apply to QOR and listed `erc20/<addr>` denoms | `D5DAAD0A…` |
| 3 | Does the agent lane need the owner's EVM window? | ✅ No. The agent executed successfully with the window closed, so an attacker **cannot** block the rescue by burning `maxTxs` | `9ADDC240…` |
| 4 | Do spending rules bind the owner's own ECDSA EVM txs? | ❌ No. The owner sent 2 QOR with perTx 1 QOR and it succeeded. The attacker is capped only by the **window budget** | `0x282a67c7…` |
| 5 | Gas of `withdraw` with `pqcVerify` (workshop vault) | Reported `gasUsed` = 500000 with a 1M limit. Deploys also report exactly 50% of the limit. The chain appears to charge at least 50% of the gas limit, so set tight limits | `0x3783c450…` |

Design consequences: keep the main design. `rescue()` only moves funds into the vault. The rule is
`allowedEvmCalls=["<vault>/<rescue selector>"]`, `allowedDenoms=["uqor"]`, and `dailyLimit` doesn't
need raising. The threat model must state that the window budget is the only cap on the attacker,
and that the owner can close the window at any time while the Guardian keeps working.

## 7b. Original assumptions (checked above)

1. Format of `allowedEvmCalls`: contract address only, or with a selector? Does the agent's
   `MsgExecuteEVM` need the owner's window open?
2. Does an ERC-20 `transferFrom` (msg.value = 0) count against the per-tx/daily limit (given the
   "measured EVM spending policy")? If so, set daily ≥ total protected assets.
3. The attacker can also call `approve(vault, 0)` to block the rescue. Record this in the threat model
   and let the demo show the race.
