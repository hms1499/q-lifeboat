# Homepage design (approved 2026-11-26)

## Intent
The public instance (https://q-lifeboat.fly.dev) opens on a single card. A visitor (a hackathon judge or a testnet user)
should understand in one screen what Q-Lifeboat does, see that it really works, and start setup. The builder asked for
research into similar products first and approved mockup A
(`.superpowers/brainstorm/86704-1795662054/content/homepage-v1.html`, not committed).

Research (homepages read 2026-11-26): Revoke.cash (outcome headline, 3 numbered steps, product screenshot, blunt FAQ),
Harpie docs (closest mechanism: front-run a theft into a non-custodial vault; trust from stated limits), Wallet Guard
("cannot move your assets"), Safe ("Audited to be sure": audits, bug bounty, GitHub), Blockaid (B2B, no plain
mechanism: avoided), QRL (post-quantum jargon to a lay reader: avoided).

## Goals
- Outcome headline, one-line mechanism, "Get protected", "See a real rescue".
- Verifiable proof instead of big numbers: the three Task 12 rescues on diana (blocks, 2-block delay, 90 % kept, hashes).
- Watch / Rescue / Recover with a diagram; "What your Guardian can't do"; links to code, threat model, audit, evidence.
- Straight FAQ, including what it can't do (key already stolen, same-block drainers, lost browser).
- Phone width with no horizontal scroll.

## Non-goals / anti-goals
- No invented numbers, logos or testimonials. No claim a tx can be opened on the diana explorer (chain fact 19).
- No second site or deploy. No change to how a browser with a wallet lands (Overview).

## Approaches
- **A (picked): a `Home` screen inside the dashboard**, full width without the sidebar, at `#/` for a browser with no
  wallet and at `#/home` always. One deploy, the app's own tokens and logo, live `/api/status`.
- B: a separate marketing site (another domain and deploy, four days before the freeze).
- C: grow the Start card (still beside the sidebar; reads as an app screen).

## Decided
- Copy and section order as in mockup A. The onboarding gate (`landingStart`) shows under the hero CTA when onboarding
  is paused. The hero fine print adds "N Guardians on watch now" from `/api/status` when it answers.
- Start no longer shows its own landing card when onboarding is open: "Get protected" goes straight to step 1.
- In-page links scroll with buttons (the app routes on `#/…`, so `#how` would be read as a route).
- Proof rows and doc links are static data in `lib/home.ts`, taken from `docs/EVIDENCE.md`; GitHub links point at
  `hms1499/q-lifeboat` `main`.

## Left to the builder
CSS structure (a `.home` namespace in `styles.css`), the diagram as inline SVG, tests for the route choice and the proof data.
