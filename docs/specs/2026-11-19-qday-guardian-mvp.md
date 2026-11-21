# Q-Day Guardian: MVP Spec

Hackathon: QoreChain Build Before Q-Day · Category: **Post-Quantum AI Agents** (+ Best AI-Native)
Testnet: `qorechain-diana` (EVM chain ID 9800) · Team: solo · Deadline: 2026-12-02 23:59 UTC (feature freeze: 2026-11-30)

## 1. One-line description

An AI agent on testnet `qorechain-diana` that, when an owner's ECDSA key leaks during an open EVM
window, sweeps their ERC-20 tokens into a vault that only opens with the owner's ML-DSA-87 key.

Read precisely (updated 2026-11-21):
- **What is swept:** the ERC-20s the owner approved to the vault (fUSD/fETH/fBTC). QOR on the EVM
  lane is not swept; the window's budget caps what a leaked key can spend of it.
- **What is detected:** not the leak itself but its symptom, an outbound transfer to an address
  that is not on the owner's trusted list (or above a threshold), and only while an EVM window is open.
- **What the AI does:** fixed rules in `apps/agent/src/rules.ts` decide every rescue. The LLM only
  writes the signed incident summary and never decides to move funds.

> Honest scope: native-lane transactions on QoreChain already require a hybrid signature. A leaked
> ECDSA key only does damage inside an **open EVM window** and to assets on the EVM lane. The
> Guardian covers exactly that gap.

## 1b. Problem, users and the role of QOR (added 2026-11-21)

**Problem.** To use EVM dApps on QoreChain an owner opens an EVM window, and inside it a tx needs
only the ECDSA signature. Whoever holds that key (quantum break at Q-Day, but today also malware,
phishing or a leaked seed) can drain the owner's ERC-20s until the window closes. Blocks on diana
take ~1.4 s, so a human notices too late. The Guardian is the airbag for that exposure: it reacts
within a block or two and parks what is left behind the owner's post-quantum key.

**Users.** People who use EVM dApps on QoreChain and hold ERC-20s there, and bots or hot wallets
that keep a window open for long. The longer the window stays open, the more the Guardian is worth.
It does not replace closing the window; it covers the time the window has to be open.

**Role of QOR.**
| Role | Detail |
|---|---|
| Gas tank | The owner pre-funds the guardian account with QOR. It pays rescue gas and the guardian's window fees. The dashboard shows the balance and the agent alerts when it runs low. A flat fee per rescued token (the Harpie model) is the business model, set to 0 in the MVP |
| Fees | Owner txs: vault deploy, setup (hybrid), approvals, withdraw |
| Protected asset | `deposit()` / `withdraw(token = address(0))` hold QOR behind ML-DSA. The agent does not sweep QOR: the window budget caps it |
| Agent key limit | The ed25519 key's spending rule is in `uqor` (1 QOR per tx, 3 QOR per day) |

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
   - Watches the owner's EVM address every block. Detection rules: an outbound transfer to an address
     that is not a trusted wallet or app, or above a threshold; and (added 2026-11-21) an `Approval`
     from the owner to a spender that is not trusted, with a non-zero value, which catches approve and
     permit phishing before the tokens move. On a match it calls `vault.rescue(token)` for
     fUSD/fETH/fBTC. `deposit()` QOR is not swept by the agent: QOR on the EVM lane stays the owner's
     (window budget cap).
   - The trusted list holds wallets **and apps** (swap routers, lending pools, bridges), because a dApp
     call moves tokens to a contract. It lives in a local policy file the agent reloads; the dashboard
     edits it through the agent's API, bound to 127.0.0.1 only (see Review Focus).
   - The LLM writes the incident report. The report is signed with the agent key (authenticated
     messaging) so the dashboard can verify it.
   - Alerts (added 2026-11-21): Telegram and/or a webhook on every rescue and when the gas tank runs
     low. Alerts go out after the rescue and can never delay or block it. `GET /health` reports the last
     block seen, the guardian window's budget and the gas tank balance.
3. **Dashboard** (React + `@qorechain/react`). Product screens, not a demo script (direction A,
   2026-11-21). Mockup: https://claude.ai/artifact/J2uWP23zGnQYdxNQ2HHCfW (private)
   - **Overview:** exposure first (window open or closed, blocks and txs left, "Close EVM window now"),
     protected assets, Guardian health, gas tank, outgoing activity, trusted list. "Rescue now" lets the
     owner call `vault.rescue` from QoreX when the agent is down (the vault already allows the owner).
   - **Incidents:** signed reports, each checked against the chain (✓ or ✗), AI summary marked as such.
   - **Recover:** load `withdrawal.json` from the **Guardian Signer** (local CLI that signs ML-DSA with
     `pqcSign`, because QoreX refuses `signArbitrary`), check it, submit through QoreX.
   - **Rules:** trusted wallets and apps, the transfer threshold, alert channels, the Guardian's
     on-chain permission (read only).
   - **Protect:** self-serve onboarding: connect QoreX, create the vault, approve tokens, trusted
     list, recovery address and alerts, link the Guardian and fund the gas tank. Depends on the QoreX
     signing spike (plan Task 6A); without it this screen shows the CLI commands instead.
   - **Fire drill:** runs the end-to-end attack on a throwaway account (`fresh-owner`, `attack`,
     `demo-check`) to prove the Guardian works without risking the owner's funds.

## 3. Non-goals

- Mainnet, real funds, protecting the native lane (the chain already does that).
- ML-based anomaly detection. Fixed rules only. The LLM only explains incidents and **never decides
  to move funds**.
- The agent closing the window or revoking keys: those messages can't be delegated.
- Multiple owners, multiple agents, multisig, tokens other than QOR/fUSD/fETH/fBTC.
- QoreSeal/ML-KEM, Cross-VM, mobile app, email or SMS notifications (Telegram and webhook alerts
  moved into scope on 2026-11-21).
- Not in the MVP (roadmap, see section 8): mempool front-running, several guardians, a withdrawal
  timelock with cancel, a non-zero rescue fee, a hosted multi-owner agent.

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

## 8. Product direction A and prior art (2026-11-21)

The project read too much like a scripted demo. Direction A keeps the scope (one owner, one agent,
the same contract) and turns the surface into a product. The additions come from products that solve
the same problem:

| Prior art | What it does | What we take |
|---|---|---|
| Harpie (EVM wallet firewall) | Owner picks tokens, trusted apps and addresses, and a withdrawal address. On a transfer to an unapproved address it front-runs into a non-custodial vault. Fee per recovered asset | Trusted **apps**, not only wallets; recovery address at setup; per-rescue fee as the business model |
| Circuit | Pre-signed txs to a fixed backup wallet; the owner can trigger them by hand if automation fails | "Rescue now" button for the owner |
| Flashbots whitehat / MetaMask sweeper-bot guide | Never fund a compromised wallet with gas | Already true: the guardian pays gas and the vault pulls by allowance |
| Hypernative Guardian on Safe, Forta Firewall | Pre-execution screening; removing the guard needs a 24 h timelock | Protect the protection: `approve(vault, 0)` is the cheapest way to switch us off (T5) |
| Argent, Safe RecoveryHub | Recovery delays with cancel; email/SMS/push on every security event | Alerts are table stakes |
| Bitcoin vaults (BIP-345) + watchtowers | Pre-committed recovery path; run several watchtowers so one outage does not matter | One agent is a single point of failure: `/health` now, several guardians later |
| Project Eleven yellowpages, Ethereum quantum-emergency proposal | Link classical keys to post-quantum keys; recover after a mass break | The vault is a post-quantum holding place; a mass break means many owners at once |

**MVP priorities (plan Task 6):** P1 trusted apps, `Approval` trigger, "Rescue now", Telegram/webhook
alerts; P2 gas tank and `/health`. **Roadmap:** mempool front-running if diana's EVM RPC exposes
pending txs (would also close T5), several guardians, a withdrawal timelock with cancel, a non-zero
rescue fee, a hosted multi-owner agent whose policy writes need an ML-DSA signature.
