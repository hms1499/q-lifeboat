# Hosted product UX rebuild (2026-11-26)

## Intent
Rebuild the hosted product (https://q-lifeboat.fly.dev) around the user's state, as in the approved prototype
`.superpowers/brainstorm/86704-1795662054/content/ux-flow-v1.html` (not committed). Audience: **testnet users trying
the product**, not judges. Chosen: rewrite all hosted screens, ship in one deploy, speed over schedule (approach B).

Source: a Playwright UX audit of the live app on 2026-11-26 (screenshots in `.playwright-mcp/ux2/`): one nav for every
state, empty screens mid-onboarding, a two-stage unlock on every page, a dead-end attack with 0 fUSD, a misaligned
withdraw form, jargon in the main call to action, a rescue that drops off Overview after 2,000 blocks.

## Goals
1. **State-driven app.** `visitor` (no wallet) → homepage. `onboarding` (wallet, not active) → setup in focus mode (no
   app nav). `protected` (hosted stage `active`) → the app. `#/` always lands on the right one.
2. **Navigation for a protected owner:** Dashboard · Activity · Vault · Settings. Desktop: sidebar. Phone: bottom tab bar.
   Activity shows a dot while an unseen incident exists.
3. **Setup in 3 phases:** (1) wallet + recovery code, (2) starter QOR, (3) "Turn on protection": one click runs register →
   Guardian → vault (deploy + mint) → approvals + link + activate, with a live checklist; resumable after a closed tab.
4. **Recovery code made convenient:** 4-column grid (2 on phones), **Copy** and **Download .txt** (code, account, a privacy
   warning), confirm by typing 2 groups (paste allowed).
5. **Unlock once per session:** one dialog asks for the password and/or the recovery code only when an action needs to sign;
   the sidebar shows "Locked · unlocks when you sign" or "Unlocked · Lock". No unlock forms embedded in pages.
6. **Dashboard:** status hero (calm: "Your Guardian is watching"; incident: orange, the story, "Move tokens to a safe
   address" + "See what happened", kept until the owner dismisses it), tokens (account vs vault), latest activity,
   "Test your protection" card, "Technical details" folded (EVM window, Guardian health, permission, gas + top-up).
7. **Test your protection:** shows fUSD on the account; with < 10 fUSD offers "Mint 100 test fUSD" (owner window + mint);
   a confirm dialog explains the self-attack; then the live rescue timeline (existing attack logic).
8. **Activity:** one timeline of incidents and outgoing transfers/approvals; an incident opens its signed report
   (stats, timeline, checks, download).
9. **Vault:** withdraw in 3 steps: what (token chips with balances, amount, Max) → where (address; refuses the leaked
   account and the vault) → review → sign (unlock dialog if needed) → success with tx hash.
10. **Settings:** trusted wallets and apps, largest trusted transfer, alerts ("coming soon" on the public instance), wallet
    (account, lock). Turning protection off stays local-mode only (no hosted backend for it today).

## Non-goals
- No change to contracts, agent rules, hosted API or what is signed. No new backend endpoints.
- Local mode (the builder's agent, MetaMask Protect, Fire drill) keeps today's screens, reachable only in local mode.
- No CSS framework; the hand-written stylesheet and tokens stay. No dark mode.

## Anti-goals
- A screen with no content for the user's state; a button that cannot succeed (attack with 0 fUSD).
- Jargon in a primary action or headline (EVM window, hybrid signature, ML-DSA-87) outside "Technical details".
- Losing a safety check the current flows have (recipient refusals, code-vs-chain key check, window scoping, nonce reads).

## Constraints
- Reuse the tested logic: `lib/onboard`, `lib/session`, `lib/appWallet` (`ownerTx`, `hosted`), `lib/attack`, `lib/verify`,
  `lib/withdrawal`/`BrowserWithdraw` logic, `lib/overview`, `TrustedEditor`'s policy editor. Screens are new; logic moves, not rewritten.
- TDD for every new pure function (state resolution, route aliases, phase mapping, incident "seen" store, withdraw
  validation, recovery-code file text). 1280 px and 390 px with no horizontal scroll.
- Routes: `#/`, `#/setup`, `#/dashboard`, `#/activity[/<id>]`, `#/vault`, `#/settings`, `#/home`. Old links keep working:
  overview→dashboard, incidents→activity, recover→vault, rules→settings, attack→dashboard, start→setup.
- One deploy at the end, with the builder's go-ahead. An end-to-end run on diana before it (fresh owner: setup → test →
  withdraw) needs a starter pack: the per-IP cap (3/day) on the builder's IP frees up 2026-11-27 ~02:00Z.

## Approaches
- A. Incremental, five deployable waves. Rejected by the builder: speed over safety.
- **B (picked). Rebuild all hosted screens on a branch, one deploy.**

## Security note
Copy/Download puts the recovery code in the clipboard or a file. With the browser's encrypted wallet and password, it
signs withdrawals. `docs/THREAT_MODEL.md` gets a row; the file and the screen say so.

## Left to the builder
File layout under `src/screens/` and `src/components/`, which legacy screens/CSS become dead and are deleted, copy details
within the prototype's wording.
