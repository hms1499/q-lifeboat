# Dashboard redesign: "Lifeboat" visual system (Task 6I)

Status: builder asked for a professional, real-product UI (2026-11-24) and handed over the how. Low tier (dashboard
presentation only). Logic, data flow, tests and copy decisions from Task 6H stay; this changes how it looks and is laid out.

## Intent

A first-time viewer should feel they are looking at a security product they could trust with money, and read the one
thing that matters (am I safe, exposed, or rescued) in a second. The current UI is a clean engineering dashboard but reads
as a generic template: warm cream page, Inter + Space Grotesk, all-caps mono eyebrows, middot meta strings, identical
rounded cards, a single blue accent for everything.

## Subject and identity

Q-Lifeboat is a rescue service: when the hull (the ECDSA key) is breached, it moves cargo (tokens) into a lifeboat (the
vault) that only the owner's post-quantum key can open. The identity borrows from maritime safety, not crypto clichés:

- **International orange** is the colour of lifeboats and rescue gear. Here it is RESERVED for rescue and exposure: a
  rescue happened, the window is open, a drain was seen, "Rescue now". It never decorates.
- **Harbour navy** is the calm, trusted base: the app shell, primary buttons, headings.
- **Chart paper**: a cool blue-grey page, not cream.
- **Hull lettering**: one type family, Archivo, used at an expanded width for headings (like the lettering on a hull) and
  normal width for body.
- **The waterline** is the one memorable device: on Overview, the status board is split by a waterline. Above it, what
  is exposed on your account; below it, what is safe in your vault. Each token is a horizontal bar whose two parts show
  account vs vault. A rescue visibly moves the weight below the line.

## Tokens

Colour (CSS custom properties, `:root`):

| Token | Hex | Use |
|---|---|---|
| `--harbour` | `#0F2236` | app shell, headings, primary buttons, body text |
| `--harbour-2` | `#2A3D52` | secondary text on light |
| `--muted` | `#5A6878` | captions, table heads (AA on white: 5.6:1) |
| `--chart` | `#EEF2F5` | page background |
| `--hull` | `#FFFFFF` | panels |
| `--rope` | `#D6DEE6` | borders, dividers |
| `--well` | `#F5F7F9` | inset areas inside panels |
| `--rescue` | `#E8501A` | rescue fills, hazard stripe, bars (non-text) |
| `--rescue-ink` | `#B03A0B` | rescue text, `Rescue now` button bg with white text (5.6:1) |
| `--rescue-wash` | `#FDEEE6` | rescued/exposed panel tint |
| `--safe` | `#0B6B50` | verified ✓, "safe in vault", vault part of bars (text 6.4:1) |
| `--safe-wash` | `#E4F3EE` | verified badge bg |
| `--signal` | `#1F5FD0` | links and focus only |
| `--danger` | `#B42318` | failed checks, errors (distinct from rescue orange) |

Type (Google Fonts: `Archivo:wdth,wght@62..125,400..800` and `IBM Plex Mono:wght@400;500`):

- Headings: Archivo, `font-stretch: 118%`, weight 700, sentence case, tight tracking (-0.01em). Scale: page title 32/38,
  status headline 36/42 (28 on mobile), panel title 18/24.
- Body: Archivo 100% width, 15/24, weight 400; labels 13/18 weight 500 in `--muted`, sentence case (no all-caps, no
  letter-spacing).
- Numbers: Archivo with `font-variant-numeric: tabular-nums`.
- Mono (IBM Plex Mono 13px) ONLY for addresses, hashes and CLI commands, never for labels.

Shape and depth: panels radius 14px, inset wells 10px, chips 6px, the status board 20px. Borders (`--rope`) instead of
shadows; the only shadow is on the status board (`0 1px 0 var(--rope)` plus a 1px inner line). No gradients.

Motion: one moment only. When the status changes to rescued, the waterline bars animate the vault part growing
(transform scaleX, 600ms, ease-out), skipped under `prefers-reduced-motion`. Buttons get a 120ms background transition.
Nothing animates on page load.

## Layout: app shell

```
┌────────────┬──────────────────────────────────────────────┐
│ ⛑ Lifeboat │  Overview                       How it works  │
│            │  ┌──────────────────────────────────────────┐ │
│ Overview   │  │ No exposure right now      EVM window     │ │
│ Incidents  │  │ Your window is closed…     Closed         │ │
│ Recover    │  │ ─ ─ ─ ─ ─ ─ waterline ─ ─ ─ ─ ─ ─ ─ ─ ─ │ │
│            │  │ fUSD   ▏0     ███████████████ 99 in vault │ │
│ Set up     │  │ fETH   ▏0     ███████████████ 97          │ │
│ Protect    │  └──────────────────────────────────────────┘ │
│ Rules      │  ┌ Outgoing activity ───────┐ ┌ Guardian ───┐ │
│ Fire drill │  │                          │ │ Online      │ │
│            │  └──────────────────────────┘ └─────────────┘ │
│ ● Online   │                                               │
│ 0xE871…67EB│                                               │
│ diana      │                                               │
└────────────┴──────────────────────────────────────────────┘
```

- Sidebar 248px, `--harbour` background, white text. Brand at top (shield-lifebuoy mark + "Q-Lifeboat"). Nav in two
  groups: "Monitor" (Overview, Incidents, Recover) and "Set up" (Protect, Rules, Fire drill); group labels are small
  sentence-case text, not caps. Active item: white text with a 3px `--rescue` bar on its left edge (the only orange in
  the shell). Footer: agent status dot + "Guardian online/degraded/offline", watched account (mono, short), network
  "diana testnet". Banners from App stay at the top of the content column.
- Content column: max-width 1160px, left aligned, 32px padding. Page header row: title (h1) on the left, page-level
  secondary action on the right (Overview: "How it works").
- Below 960px the sidebar becomes a top bar: brand + status dot + a "Menu" button that opens the nav as a sheet
  (`<details>` or a button-controlled panel, keyboard accessible). No horizontal scrolling at 375px.

## Screens

- **Overview.** The explainer (Task 6H) keeps its content but becomes a slim panel above the board with the three steps
  in one row (Watch, Rescue, Recover as real sequence numbers 1-3 are fine: it is a sequence). The status board replaces
  the hero + Protected assets card: headline and body on the left, the EVM window box on the right, then the waterline
  and one row per token (fUSD, fETH, fBTC; QOR shown last as "not swept, window budget only" in muted text, no bar). Board
  tint by state: calm = hull white with a navy waterline; window open = a 6px `--rescue` hazard stripe along the top edge
  and orange window box; rescued = `--rescue-wash` tint, orange headline marker; unverified = danger outline. "Rescue
  now" sits on the board (rescue-ink button) when tokens remain on the account. Then a two-column grid: Outgoing
  activity (wide) and a right column with Guardian health, Gas tank, Trusted list.
- **Incidents.** Two-pane master/detail stays. List items become compact rows (no individual card borders): a 3px left
  edge in `--rescue` for rescues and `--harbour-2` for alerts, headline, relative time and ✓/✗ with text. Detail: the
  headline as h2, then the four stats as a single row with dividers (not four boxes), the agent summary and timeline,
  then "Why you can trust this report" with `--safe` ✓ marks (not blue).
- **Fire drill.** Stages as a horizontal progress track on wide screens (vertical on mobile) with the current stage in
  orange and done stages in navy; verdict as a large result block ("PASS" becomes "Passed", with blocks and kept %).
- **Protect, Recover, Rules.** Inherit the system: steps list becomes a vertical stepper with a connecting line; command
  boxes use the mono face on `--harbour` background; forms use 44px inputs with `--rope` borders and navy focus. No
  layout changes beyond what the shared classes give.

## Copy rules

Sentence case everywhere; no all-caps eyebrows; no "A · B · C" meta strings (use separate elements or commas); no "→"
in buttons; tags read as words ("Rescue", "Alert", "Verified", "Not verified").

## Non-goals

No dark mode (one theme, done well). No new runtime dependency (no UI kit, no icon package: inline SVG for the 6 or so
icons). No change to data, verification, signing or test logic. Existing tests stay green.

## Left to the builder

Exact spacing values within an 4/8px scale, the SVG icon shapes, the mobile menu mechanics, and which inline `style={{}}`
in screens to move into classes (move only what the new look needs).
