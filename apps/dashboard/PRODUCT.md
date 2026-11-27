# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: someone brand new to QoreChain, typically a hackathon judge, who has only a browser. No extension, no
terminal and no QOR of their own. In about 10 minutes they want to get a protected account, watch the Guardian rescue
their tokens, and withdraw those tokens with their post-quantum key.

Secondary: a developer who self-hosts the agent and runs the local-mode dashboard (Overview, Incidents, Recover,
Protect, Rules, Fire drill) against their own `.env` and CLI.

## Product Purpose

Q-Lifeboat is a post-quantum lifeboat for EVM tokens on QoreChain. If the classical (ECDSA) key behind an account
leaks, an autonomous Guardian moves the remaining tokens into a vault that only the owner's ML-DSA-87 key can open. The
leak could come from a quantum attacker after Q-Day, or today from malware, a phishing site or a leaked seed.

Success means a stranger finishes the journey on the public URL without getting stuck: setup, test attack, signed
report with every check ✓, then withdrawal. The fastest recorded run took 2 min 32 s (docs/EVIDENCE.md, Task 12).

## Positioning

- **Only the ML-DSA-87 key opens the vault.** Even if every agent key is stolen, tokens can only move from the owner
  into the owner's own vault. Getting them out needs the owner's post-quantum key, which comes from a recovery code
  independent of the classical key. The chain and the contract enforce this, not the agent's own code.
- **Honest about its limits.** The product says plainly what it does not stop: a one-shot drain inside an open window,
  and a drainer as fast as the Guardian in the approval race. Its real defence is a window that stays closed by
  default.

## Operating Context

- The hosted service at https://q-lifeboat.fly.dev runs on one Fly.io machine. It serves at most 4 accounts at once
  and gives out 3 starter packs per IP per day. When it is full, onboarding is paused.
- Hosted journey:
  - Home.
  - Setup in three phases: wallet and recovery code `QRC1-…`, starter pack of 2.5 QOR, turn on protection.
  - After setup: Dashboard (Test your protection), Activity (signed reports), Vault (withdraw), Settings (trusted
    wallets and apps, the largest trusted transfer).
- The password and recovery code are asked for once per session, and only when an action needs to sign.
- The chain is the testnet `qorechain-diana`, with blocks of about 1.4 s. A rescue lands 1–2 blocks after the
  attack.
- Testnet only. Test tokens (fUSD, fETH, fBTC, QOR) have no value.

## Capabilities and Constraints

- The decision to rescue is plain code (`apps/agent/src/rules.ts`). An LLM only writes the incident summary.
- Reports are signed twice: ed25519 by the agent key, plus a QoreSign co-signature with secp256k1 and ML-DSA-87. The
  dashboard checks them in the browser against the chain.
- Every setup step turns ✓ only when the chain or the service confirms it. The user can close the tab and come back.
- Signing actions open one shared key dialog. Unlock forms are never embedded in a page.
- The recovery code is shown once and never stored.
- `GuardianVault.sol` and the agent's on-chain rule are frozen: no changes without a new audit.
- Deadlines: feature freeze 2026-11-30, submission 2026-12-02 23:59 UTC.

## Brand Commitments

- Name: **Q-Lifeboat** (`src/brand.ts`). Mark: the `LifeboatMark` component and `public/favicon.svg`.
- Voice: calm, like a safety service. No quantum FUD, no false urgency, no scare tactics.

## Evidence on Hand

- Real testnet transactions with their hashes: `docs/EVIDENCE.md`. They include the three fresh browser runs on the
  public URL (2026-11-26).
- Threat model: `docs/THREAT_MODEL.md` (T21–T27 for the hosted service). QCAI audit findings: `docs/AUDIT.md`.
- Cover art: `assets/cover-16x9.png` (source `assets/cover.html`).
- There are no real users, testimonials, customers or human audit. The contract had two AI audit passes (QCAI) only.
  Never imply otherwise.

## Product Principles

1. **Show the real mechanism, not a simulation.** The test attack is a real transfer, and each ✓ comes from the chain.
2. **Every claim is verifiable.** Prefer evidence the user can check over statements they must trust.
3. **Never leave a newcomer stuck.** No step may need QOR they don't have, or a CLI command.
4. **Weakening protection or moving funds out needs the post-quantum key.** A leaked classical key must never be
   enough.
5. **State limits plainly and calmly.**

## Accessibility & Inclusion

WCAG 2.2 AA: contrast, full keyboard operation, visible focus.
