# Q-Lifeboat for end users: design

Date: 2026-11-25 · Status: draft for approval · Supersedes the MVP spec's non-goals "multiple owners" and "hosted
multi-owner agent" (`docs/specs/2026-11-19-qday-guardian-mvp.md` §3, §8). Everything else in the MVP spec still holds.

## 1. Intent

The hackathon judges a product people can use, not a scripted demo. Today a user must clone the repo, put mnemonics in
`.env`, run `pnpm cli …` with `--expect` flags and run `pnpm agent` on their own machine. A judge will not do that.

Goal: **a stranger with only a browser opens a public URL and, in about 10 minutes, without a terminal and without
QOR of their own, gets a protected account, watches the Guardian rescue their tokens, and withdraws them with their
post-quantum key.**

The first user we design for is **someone brand new to QoreChain** (for example a judge). Connecting an existing account
is a later path (§9).

## 2. Goals, non-goals, anti-goals

Goals
- One public URL. No clone, no terminal, no browser extension, no QOR of your own.
- The six-step journey in §4 works end to end on diana, repeatedly, for fresh users.
- The user's ML-DSA-87 key comes from a **recovery code independent of the classical key**, fixing the current model
  where both keys derive from one mnemonic (a leaked seed would also leak the vault's withdrawal key).
- The Guardian runs on a server, so protection does not stop when the user's laptop sleeps.
- No change to `GuardianVault.sol` (no new audit) and no change to the agent's on-chain rule (Hard rules).

Non-goals (this freeze)
- Existing accounts and external wallets (MetaMask, Keplr, Leap). See §9.
- Mainnet, real funds, tokens other than fUSD/fETH/fBTC/QOR.
- A multi-tenant rewrite of the agent. We run one unchanged agent process per owner.
- Mempool front-running, withdrawal timelock, rescue fees.

Anti-goals (a failure even if it works)
- A judge gets stuck for lack of QOR, or has to read a CLI command.
- A leaked **classical** key can switch protection off, edit the trusted list, or withdraw. Everything that weakens
  protection or moves funds out of the vault must need the ML-DSA key.
- The recovery code is stored next to the classical key in a way that makes "a leaked browser" equal "a leaked
  recovery code".
- The starter-pack faucet is drained by a script in an afternoon.

## 3. Constraints and facts this rests on

- `@qorechain/sdk@0.14.0` is pure JS (noble, cosmjs; no Node built-ins), so it runs in the browser.
  - `pqcKeyFromRecoveryCode(code, qor1Address)` derives the ML-DSA-87 keypair from a `QRC1-…` code bound to the address;
    `generatePqcRecoveryCode()` makes one. The SDK's own guidance: show it once, never store it next to the classical key.
  - `UnifiedAccount = { addresses, privateKey, publicKey, pqc }`, so an account built from a random secp256k1 key plus a
    recovery-code PQC keypair plugs into the existing `broadcastTx` / `EthNativeSigner` path unchanged.
- A brand-new account registers its ML-DSA-87 key with a classically signed `MsgRegisterPQCKeyV2` (chain fact 15;
  `apps/cli/src/fresh.ts` does it today).
- One linked ed25519 agent key per account (fact 14) and one live EVM window per account (fact 10), so each owner needs
  **its own guardian account and agent key**: one guardian cannot hold windows for two vaults at once.
- diana REST has no CORS (fact 18): the browser reads it through a same-origin proxy.
- A hybrid tx costs ~0.225 QOR (fact 21); the faucet is web-only, 1 claim / 24 h. Users cannot be expected to fund
  themselves.
- The agent is configured entirely by env (`apps/agent/src/config.ts`) and never reads the owner's mnemonic, so it can
  be spawned per owner as is.
- Funder: `FUNDER_MNEMONIC`, ~175 QOR today.
- Deadline: feature freeze 2026-11-30, submission 2026-12-02.

## 4. The user journey

```
<public URL> ─▶ [Get started]
 1. Create your account   in-browser wallet: random secp256k1 key, encrypted with a password you choose
 2. Recovery code         QRC1-… shown once; type back a few groups to confirm; it never leaves the page unencrypted
 3. Starter pack          the server sends QOR; you mint fUSD/fETH/fBTC (public mint)
 4. Turn on protection    register PQ key · create vault · approve tokens · link your Guardian · fund its gas tank
                          (one click each, progress read from the chain, as the Protect screen does today)
 5. Try an attack         "Send 10 fUSD to an unknown address" → the Guardian rescues the rest 1–2 blocks later;
                          the signed report appears with ✓ checks
 6. Withdraw              enter recovery code → ML-DSA signature in the browser → tokens to a safe address
```

- Step 5 is a real transfer the user signs. The Guardian cannot tell the owner from someone holding a leaked key; that
  is what the trusted list is for. This shows the real mechanism, not a simulation.
- The user can come back the next day: the encrypted key is in the browser, the vault and incidents come from the chain
  and the hosted Guardian.
- Today's Overview, Incidents, Recover and Rules screens stay, fed by the hosted Guardian. The Fire drill screen leaves
  the main navigation (step 5 replaces it).

## 5. Approaches considered

| | Approach | Trade-off |
|---|---|---|
| **1 (chosen)** | **In-app wallet**: the app generates the classical key and the recovery code, signs EVM txs with viem and hybrid txs with the SDK | No extension; fewest unknowns (ports code paths already proven on diana). Keys live in the browser: the classical key is the one the product already assumes can leak; the PQ key comes from a separate code |
| 2 | Keplr/Leap for the classical half (`@qorechain/wallet-adapter@0.6.0` layers ML-DSA onto a `SIGN_MODE_DIRECT` SignDoc) + MetaMask for EVM txs | Feels like "real wallets", but a new user installs two extensions and imports one seed into both so addresses match, the habit we want to end. Keplr on diana with `eth_secp256k1` is unproven |
| 3 | Keplr only, also for EVM | Keplr very likely has no EVM support for chain 9800 |

The builder chose approach 1 for the main flow and kept approach 2 as the later "existing account" path (§9).

## 6. Design

### 6.1 Keys in the browser

| Secret | Generated | Stored | Used for |
|---|---|---|---|
| Classical secp256k1 key | `crypto.getRandomValues` in the browser | encrypted (WebCrypto: PBKDF2-SHA256 ≥ 600k iterations → AES-GCM) under the user's password, in IndexedDB | EVM txs (vault deploy, approve, mint, the step-5 transfer, withdraw submit), the classical half of hybrid txs |
| Recovery code `QRC1-…` | `generatePqcRecoveryCode()` | **never persisted**. Typed when needed, the derived keypair kept in memory for the session, wiped on lock / tab close | the PQ half of hybrid txs (register, open/close window, link/unlink), withdrawal signatures, and authorising Guardian policy changes (§6.4) |

- The recovery code is the only way to withdraw. Losing it means the vault stays locked. Step 2 says so plainly and
  makes the user confirm.
- Export: the user can download the classical key (encrypted file) to restore on another browser; the recovery code is
  already on paper.
- No mnemonic exists anywhere in the user flow.

### 6.2 Hybrid and EVM txs from the browser

- A browser `UnifiedAccount` (classical key + `pqcKeyFromRecoveryCode`) goes through the same `broadcastTx` code
  (`packages/core/src/chain.ts`), with REST through the proxy. The CLI's message builders (`buildRegisterMsg`,
  `buildGuardianLinkMsgs`, `buildWindowParams`, `openEvmWindowMsg`, `closeEvmWindowMsg`, `buildWithdrawal…`) move to
  `packages/core` (or a new browser-safe package) so the CLI and the browser share one implementation and the TS ↔
  Solidity withdrawal vector stays green.
- EVM txs: viem `walletClient` with a local account, inside the owner's window. Windows are opened scoped (vault +
  tokens) except the one-time deploy window (unscoped, fact 10), which the app closes right after the deploy.
- The app keeps the window **closed by default** and opens a short, scoped one only for the txs it is about to send, then
  closes it. This is the README's "real defence" made automatic.

### 6.3 The hosted service

One Node service, one container, one public HTTPS origin. It serves:

| Path | What |
|---|---|
| `/` | the built dashboard (static) |
| `/qore-rest/*` | proxy to diana REST (same as the Vite proxy today) |
| `/api/onboard` | provisions a Guardian for an owner (below) |
| `/api/starter` | sends the starter QOR to a new owner |
| `/api/o/<owner>/*` | reverse proxy to that owner's agent (`/config`, `/health`, `/incidents`, `/events`, `/policy`) |

Provisioning a Guardian for an owner (`/api/onboard`):
1. Generate a guardian mnemonic and an agent ed25519 key for this owner. Store them server-side (file per owner, mode
   0600, outside the repo, like `~/.config/qday/runs/`).
2. Fund the guardian from the funder and register its ML-DSA-87 key (reuse `drillguardian.ts`'s fund + register steps).
3. Return `{ guardian, agentPubKey, linkSignature }` so the browser can deploy `GuardianVault(owner, guardian)` and link
   the agent key in its own hybrid tx (`signAuthenticatorLinkEd25519` on the server, the rule built by the shared
   `buildGuardianLinkMsgs`).
4. Once the vault exists and the link is on chain, spawn the unchanged agent with that owner's env (`OWNER_EVM_ADDRESS`,
   `VAULT_ADDRESS`, `GAS_MNEMONIC`, `AGENT_ED25519_SK`, `AGENT_PORT`, `INCIDENTS_FILE`, policy file, `POLL_MS`), bound
   to loopback; the gateway proxies to it. A supervisor restarts it on crash and restarts every owner's agent on boot.

The request must carry a signature by the owner's **registered ML-DSA key** over `(owner, purpose, nonce, expiry)`,
checked against the key on chain. That ties each Guardian to an account that really completed steps 1–3.

### 6.4 Who may change protection

The agent's `PUT /policy` is loopback-only today. Through the gateway, a policy write must carry an **ML-DSA signature
by the owner's registered key** (QoreSign or raw `pqcSign` over the canonical policy JSON + nonce), verified by the
gateway against the chain before it forwards to the agent over loopback. Same for "stop my Guardian". A leaked classical
key cannot add a trusted address or switch the Guardian off.

Turning protection off on chain (revoke allowances, unlink) stays as today: the allowance revoke is an EVM tx (classical
key, inside a window that needs the PQ key to open), the unlink is hybrid.

### 6.5 Starter pack and abuse limits

- Per new owner: ~2.5 QOR to the owner (one top-up allowed, §6.8) and ~0.5 QOR to its guardian, plus ~0.225 QOR per
  owner session for the guardian's on-demand window (§6.7). About 3–3.5 QOR per user over the judging period, so the
  current funder covers roughly 40–50 users; ask the QoreChain team for more testnet QOR if more come.
- Limits: one starter pack per owner address; a per-IP limit (e.g. 3 per day); a global daily cap; the service stops
  handing out QOR below a funder floor (e.g. 20 QOR) and the UI says "come back later / use the faucet".
- Tokens are minted by the owner (public `mint` on the test tokens), not sent by the funder.

### 6.6 Load on diana's RPC

Each agent polls every `POLL_MS` (300 ms default). Hosted, use ~1000 ms and cap concurrent agents (e.g. 40). An agent
whose owner's window is closed could poll slower, since a leaked classical key moves nothing without a window: left to the
builder as an optimisation.

### 6.7 Guardian lifecycle: windows on demand (decided 2026-11-25)

Today the agent keeps its own EVM window open around the clock (`apps/agent/src/window.ts`: 14,400 blocks ≈ 5.6 h,
reopened near expiry, 0.225 QOR per hybrid tx), so an idle Guardian costs ~1 QOR per day. Judging runs to ~2026-12-15;
at 60 users the funder would last ~3 days. The builder chose **windows on demand**:

- A rescue is only ever needed while the **owner's** window is open: without one, a leaked classical key moves nothing
  (fact 17), and only the owner's ML-DSA key can open one. So the Guardian holds its window only while the owner's is open.
- **Arm before open.** Before the app opens an owner window, it calls `/api/o/<owner>/arm` (ML-DSA-signed, §6.4). The
  agent opens its own vault-scoped window sized to cover the owner's window (blocks + margin), waits until it is live, and
  only then does the app open the owner's window. So the Guardian is ready from the first block of the owner's window.
- **Fallback.** The agent also reads the owner's window state each few polls; if it finds an owner window open with no
  Guardian window (opened outside the app), it opens one at once and raises an alert in the app.
- The agent no longer renews its window on a timer. Cost scales with use: ~0.225 QOR per owner session.
- **Retirement.** A Guardian idle for 7 days (no owner window, no incident) is stopped, its guardian's QOR swept back to
  the funder, and its secrets kept so it can be re-armed on the owner's next visit (re-funded if needed).
- This is an agent change (high risk tier): full review, and an on-chain check that a step-5 rescue still lands ≤ 3 blocks
  after the transfer.

### 6.8 Calls made while writing this up (check these)

- **Starter pack for the owner ~2.5 QOR, one top-up allowed.** The app batches hybrid messages (window + link in one tx,
  as `setup` does) and sizes each owner window to exactly the txs it is about to send, so a used-up window shows closed
  (fact 20) without a separate close tx.
- **The dashboard has one mode: hosted + in-app wallet.** The MetaMask flow and the local `pnpm agent` on :8787 leave the
  UI. The CLI, `./demo.sh` and their tests stay as they are (they are the evidence trail).
- **Alerts in hosted mode are in-app only** (the existing incidents stream). Hosted agents do not get the builder's
  Telegram/webhook env, or every stranger's incidents would land in the builder's chat. Per-owner Telegram is later (§9).
- **At capacity or at the funder floor**, the landing page says onboarding is paused before the user starts, never midway.
  The gateway exposes a small status endpoint for this.
- The hosted gateway never proxies `/drill*`.

## 7. Threat model changes (to add to `docs/THREAT_MODEL.md`)

- **Hosted service compromise.** It holds every guardian mnemonic, every agent ed25519 key and the funder mnemonic. An
  attacker gets: rescue calls (owner → vault only, harmless), fake signed reports (the dashboard's on-chain checks still
  bind the report signer to the linked key, so a compromise of those keys is a real forgery: state it), stopping the
  Guardians (protection off), and the funder's test QOR. Not: anyone's vault funds, which need each owner's recovery code.
- **Browser compromise.** Gets the encrypted classical key (and the password if keylogged): the T1 leaked-key case, which
  the Guardian exists for. Gets the recovery code only while it is unlocked in memory, the residual risk.
- **Starter-pack abuse.** Bounded by §6.5.
- **Service downtime.** Nothing watches; "Rescue now" in the app remains the manual fallback.

## 8. What the builder decides

- Hosting provider and domain (one container with a persistent disk for per-owner secrets and incidents).
- Module boundaries: what moves from `apps/cli` into a browser-safe shared package.
- Supervisor mechanics, ports, log layout.
- Password policy and lock timeout.
- Exact rate-limit numbers within §6.5.

## 9. Later (not this freeze)

- Existing accounts: Keplr/Leap via `@qorechain/wallet-adapter` for hybrid txs + MetaMask for EVM, or importing a
  classical key into the in-app wallet. Needs a re-registration path for accounts whose PQ key came from a mnemonic.
- Several Guardians per owner, a withdrawal timelock, a rescue fee, mempool watching.

## 10. Success criteria

- [ ] Three fresh browsers (no extension, no QOR) complete steps 1–6 on the public URL, each in ≤ 15 minutes, with no
      terminal. Every on-chain step has a diana tx hash in `docs/EVIDENCE.md`.
- [ ] Step 5's rescue lands ≤ 3 blocks after the transfer, ≥ 80 % of the value kept (same bar as `demo.sh`).
- [ ] A policy write signed with the classical key only, or with another account's ML-DSA key, is refused.
- [ ] The withdrawal TS ↔ Solidity vector and all existing test suites stay green; `GuardianVault.sol` is unchanged.
- [ ] A restart of the hosted service resumes every owner's Guardian without user action.
- [ ] An idle Guardian sends no tx for 24 h (no window renewals); arming opens its window before the owner's.

## 11. Order of work and what to cut

Spike first (half a day, throwaway in `spike/`): from a browser page, build an account from a random key + recovery
code, register its PQ key, open a window, link an agent key, all on diana. If this fails, stop and come back to the
builder before anything else is built.

Then, by 2026-11-30: hosted service (provision, starter pack, per-owner agents, gateway) → in-app wallet + steps 1–4 →
steps 5–6 → policy auth → deploy and the three-browser E2E.

If time runs short, cut in this order: policy editing from the UI (ship a default trusted list, read-only) → the
returning-user unlock and key export → Guardian retirement (§6.7, run it by hand instead). Never cut: windows on demand
(§6.7, without it the funder runs dry during judging), and never cut: the recovery-code split, steps 1–6, the
ML-DSA gate on anything that weakens protection.
