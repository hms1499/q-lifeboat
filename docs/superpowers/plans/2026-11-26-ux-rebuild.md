# Hosted UX Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the hosted dashboard around the user's state (visitor → setup → protected app with Dashboard · Activity · Vault · Settings), as in the approved prototype.

**Architecture:** A pure `appStage` + `resolveRoute` decide the screen from the wallet and the hosted owner stage. New
screens reuse the tested logic: Start's reads and actions move into a `useSetup` hook, Attack's into `useAttack`,
BrowserWithdraw's withdraw into `withdrawFromVault`, Incidents' detail into `IncidentReport`. A `KeysProvider` owns the
single unlock dialog. Local mode keeps its current screens.

**Tech Stack:** React 18, Vite 5, vitest, the existing `styles.css` tokens (no framework).

**Spec:** `docs/superpowers/specs/2026-11-26-ux-rebuild-design.md` · prototype `.superpowers/brainstorm/86704-1795662054/content/ux-flow-v1.html`

## Global Constraints
- Branch `ux-rebuild`; one deploy at the end with the builder's go-ahead; push only with go-ahead.
- No change to contracts, agent, hosted API, signed payloads. Every existing safety check stays (recipient refusals,
  code-vs-chain key check, window scoping, nonce reads, start-over guard).
- Copy follows the prototype; no jargon (EVM window, hybrid, ML-DSA-87) outside "Technical details".
- Routes: `#/`, `#/home`, `#/setup`, `#/dashboard`, `#/activity`, `#/activity/<id>`, `#/vault`, `#/settings`; aliases
  overview→dashboard, incidents→activity, recover→vault, rules→settings, attack→dashboard, start→setup (hosted only).
- Every task ends green: `pnpm -F dashboard test`, `pnpm -F dashboard typecheck`, `VITE_HOSTED=1 pnpm -F dashboard build`.
- Browser check per screen task: hosted build previewed against Fly (a temporary `vite.fly.config.ts` as in earlier
  sessions, never committed), owner 3 (wallet copied from the Fly origin, deleted after) and a fresh visitor, 1280 + 390 px.

## Review Focus
- An owner whose hosted stage is `starter`/`provisioned` (setup half done) opening `#/`, `#/dashboard`: lands in Setup at the right phase. Task 1.
- A tab reload in phase 3 mid-run: resumes the next unconfirmed sub-step, never repeats a confirmed one (vault deploy). Task 4.
- Unlock dialog cancelled: the action does not run and no half state shows. Task 2.
- Vault withdraw to the owner's own account or the vault: refused with a reason before signing. Task 7.
- Hosted service unreachable (`/api` 5xx): Dashboard shows chain balances and a plain "Guardian not answering" line. Task 5.

---

### Task 1: State and routes

**Files:** Create `src/lib/appState.ts`, `src/lib/appState.test.ts`. Modify `src/App.tsx`, `src/lib/nav.ts` (+ test), `src/lib/home.ts` (+ test).
**Produces:** `type Stage = "visitor" | "onboarding" | "protected" | "local"`;
`appStage(i: { hasSeed: boolean | undefined; ownerStage: OwnerStage | "none" | undefined; localAgent: boolean; hostedBuild: boolean }): Stage | null` (null while unknown);
`type RouteId = "home" | "setup" | "dashboard" | "activity" | "vault" | "settings" | LocalScreen`;
`resolveRoute(screen: string, stage: Stage | null): RouteId | null`; `hostedNav(): { id: RouteId; label: string; href: string; icon: string }[]` (4 items).

- [x] Tests: `appStage` → visitor (no seed, hosted build), onboarding (seed + stage none/starter/provisioned), protected (seed + active),
      local (no seed + local agent + not hosted build), null (hasSeed undefined or seed with ownerStage undefined);
      retired → onboarding. `resolveRoute`: `""`→ home/setup/dashboard per stage; `dashboard` while onboarding → setup;
      `setup` while protected → dashboard; aliases (overview, incidents, recover, rules, attack, start) for hosted stages;
      `incidents` stays `incidents` for local; visitor on `vault` → home. `hostedNav()` ids = dashboard, activity, vault, settings.
- [x] Run → FAIL; implement; run → PASS. `App.tsx` reads `hosted.owner(owner)` (poll 15 s) for the stage and routes with
      `resolveRoute`; local stage keeps the legacy shell and screens untouched.
- [x] Commit `feat(dashboard): state-driven routes for the hosted product`.

### Task 2: Unlock once (KeysProvider + dialog)

**Files:** Create `src/lib/keys.ts`, `src/lib/keys.test.ts`, `src/components/UnlockDialog.tsx`, `src/components/KeysProvider.tsx`.
**Produces:** `keysNeeded(s: { classical: boolean; pqc: boolean }, need: "classical" | "pqc"): { password: boolean; code: boolean }`;
`useKeys(): { requireKeys(need: "classical" | "pqc"): Promise<boolean>; unlocked: boolean; lock(): void }` (resolves
false on cancel); `<KeysProvider owner={Hex | null}>`.

- [x] Tests: need pqc with nothing → both; need pqc with classical → code only; need classical with classical → neither;
      need pqc with pqc → neither.
- [x] Run → FAIL; implement the dialog (password field shown only when needed, recovery code field only when needed,
      paste allowed, errors inline: wrong password, code not this account's key), `appSession.onChange` drives `unlocked`.
- [x] Commit.

### Task 3: App shell, focus shell, incident "seen" store

**Files:** Create `src/components/AppShell.tsx`, `src/components/FocusShell.tsx`, `src/lib/seen.ts` (+ test). Modify `src/styles.css` (new `.app-*` rules from the prototype).
**Produces:** `loadSeenIncident(kv, owner): string | null`, `saveSeenIncident(kv, owner, id)`, `unseenIncident(list: Incident[], seenId: string | null): Incident | null` (newest rescue/alert not seen).

- [x] Tests for the seen store (per owner key, newest wins, null when all seen).
- [x] AppShell: sidebar (4 items, Activity dot when `unseenIncident`), footer (status line, account, "Locked · unlocks when you sign" /
      "Unlocked · Lock", "diana testnet · test tokens"); phones: top bar + bottom tab bar. FocusShell: brand, "Setting up
      protection", Exit (→ `#/home`). Browser check: tabs, dot, lock state, 390 px.
- [x] Commit.

### Task 4: Setup (3 phases)

**Files:** Create `src/lib/setup.ts` (+ test), `src/hooks/useSetup.ts`, `src/screens/Setup.tsx`. Modify `src/lib/session.ts` (`confirmPicks(code, n = 3)`) + test.
**Produces:** `phaseOf(step: JourneyStep): 1 | 2 | 3 | "done"`; `recoveryFile(code: string, account: Hex): string`;
`useSetup()` returning `{ owner, pos, phase, gate, uqor, run, createWallet(pw), confirmCode(typed), takeStarter(), turnOn(), autoRunning }`.

- [x] Tests: `phaseOf` (account, code → 1; starter → 2; register, guardian, vault, protect → 3; attack, withdraw, done → done);
      `recoveryFile` contains `QRC1-…` normalised, the account, and the line "Anyone with this code can withdraw everything in your vault. Keep this file private." (corrected in the final-review fix wave: the code alone withdraws);
      `confirmPicks(code, 2)` returns 2 distinct sorted groups in 1..14.
- [x] `useSetup`: Start's reads and actions moved as they are; `turnOn()` sets auto-run: while the step is register,
      guardian, vault or protect and nothing is busy, run that step's action; stop on the first error (shown, with Retry).
- [x] Setup screen per prototype: 3-phase bar; phase 1 password form, then code grid (4 cols / 2 on phones) with Copy
      (clipboard) and Download (`q-lifeboat-recovery-code.txt`), confirm 2 groups; phase 2 starter (balance, gate reason);
      phase 3 checklist of the 4 sub-steps (✓ from `pos`, spinner on the running one, hashes under each). Start-over stays.
- [x] Browser check: fresh visitor through phase 1 and into phase 2 (no starter request); owner 3 → lands on Dashboard.
- [x] Commit.

### Task 5: Dashboard + Test your protection

**Files:** Create `src/screens/Dashboard.tsx`, `src/components/TestProtection.tsx`, `src/hooks/useAttack.ts`, `src/lib/dashboard.ts` (+ test).
**Produces:** `heroState(i: { unseen: Incident | null; agentOnline: boolean }): "incident" | "calm" | "offline"`; `canTest(fusd: bigint | undefined): "ready" | "mint" | "loading"` (ready at ≥ 10 fUSD).

- [x] Tests for `heroState` and `canTest` (0 → mint, 10e18 → ready, undefined → loading).
- [x] Dashboard: hero (calm / incident with "Move tokens to a safe address" → `#/vault`, "See what happened" →
      `#/activity/<id>`, Dismiss → seen / offline line), tokens (account vs vault bars from `readAssets`), latest activity (3 rows),
      TestProtection, "Technical details" `<details>` holding the EVM window, Guardian health, permission and GasTank.
- [x] `useAttack` = Attack's logic moved; TestProtection: fUSD on account, "Mint 100 test fUSD" (owner window scoped to
      fUSD `mint`, `requireKeys("pqc")`), confirm dialog, then the live timeline; afterwards links to the report.
- [x] Browser check (owner 3: incident hero, dismiss, calm; mint button shown at 0 fUSD; no tx sent). Commit.

### Task 6: Activity

**Files:** Create `src/screens/Activity.tsx`, `src/components/IncidentReport.tsx` (Incidents' `Detail` moved), `src/lib/activity.ts` (+ test).
**Produces:** `activityFeed(incidents: Incident[], outgoing: OutboundRow[]): FeedItem[]` (newest first; an outgoing tx that triggered an incident appears once, as the incident).

- [x] Tests for `activityFeed` ordering and de-duplication. Opening an incident marks it seen. Browser check. Commit.

### Task 7: Vault (3-step withdraw)

**Files:** Create `src/screens/Vault.tsx`, `src/lib/vaultForm.ts` (+ test), `src/lib/vaultWithdraw.ts` (BrowserWithdraw's withdraw moved).
**Produces:** `checkWithdraw(i: { amount: string; balance: bigint | undefined; to: string; owner: Hex; vault: Hex }): { amount?: string; to?: string }`.

- [x] Tests: empty/zero/non-decimal/over balance amounts; bad address, zero address, owner (case-insensitive), vault.
- [x] Steps What (token chips with balances, Max) → Where → Review → Sign (`requireKeys("pqc")`) → success (tx hash, new balances).
- [x] Browser check up to Review (no signature). Commit.

### Task 8: Settings

**Files:** Create `src/screens/Settings.tsx`. Reuse `TrustedEditor`, the threshold form from Rules, `requireKeys("pqc")` before a policy write.
- [x] Sections: Trusted wallets and apps, Largest trusted transfer, Alerts (coming soon), Wallet (account, lock). Browser check. Commit.

### Task 9: Remove dead hosted code, docs

- [x] Delete `screens/Start.tsx`, `screens/Attack.tsx`, `components/BrowserWithdraw.tsx` and their CSS once nothing imports them
      (grep); keep local-mode screens. `docs/THREAT_MODEL.md` row for copy/download of the recovery code; README "Try it in
      your browser" steps; AI_USAGE row; CLAUDE.md note on the routes. Green commands. Commit.

### Task 10: End to end on diana, review, deploy

- [x] After 2026-11-27 02:00Z (starter cap): fresh browser on the preview against Fly: setup → test → withdraw; record hashes in EVIDENCE. (Ran 2026-11-26 on the live URL: the deploy had reset the per-IP cap.)
- [x] Whole-branch review; fixes. Ask the builder; merge, `fly deploy`, live check.
