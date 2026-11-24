# Submission gaps: spec (2026-11-24)

Status: draft for the builder's approval. Scope: four gaps found by checking the event's published requirements against the
product on 2026-11-24. Feature freeze 2026-11-30, deadline 2026-12-02 23:59 UTC.

## Source: what the event asks for

Read on 2026-11-24 from build.qorechain.io (`/rules`, `/prizes`, `/faq`, `/start`, `/kits`, `/about`). The site says rules may
still change until the end of the event.

- **Checks (3-5 Dec):** public repo, licence GitHub detects (MIT or Apache-2.0), README crediting every kit and library, cover
  image (16:9, >= 1200x675), a video of up to 3 minutes (required), at least one `qor1…` testnet address, commits from 4 Nov,
  kits detected from dependency files (`package.json` …), features proven by txs from the listed `qor1` addresses on diana.
- **Jury rubric (6-15 Dec), same for every category:** works as described 25%, QoreChain tech usage (verified in the repo and on
  chain) 25%, post-quantum correctness and security 20%, originality 15%, clarity, UX and documentation 15%.
- **Post-Quantum AI Agents:** "the agent's own scoped EVM window, smart-account spending rules and **authenticated
  messaging**". The FAQ describes an agent acting within limits through its own linked key (`MsgExecuteEVM`, no EVM window) and
  says the owner's ML-DSA key must re-link it **at least every 30 days**.
- **QCAI audit (FAQ):** both reports **as PDF, each dated, in `docs/audit/`**, `docs/AUDIT.md` mapping each Stage 1 finding to
  fixed / regression test / false positive, one line in the README and in the form's "How it's made", the same setting both times.
- **Authenticated messaging** is not defined by the FAQ. The closest QoreChain feature is QoreSign's message signature:
  `"qorechain-msg-v1|" + chainId + "|" + data`, signed by the account's classical key (ADR-36) and its ML-DSA-87 key, checked
  with `verifyMessageWithChain` against the ML-DSA-87 key the account registered on chain.

## Where the product stands (2026-11-24)

| Requirement | State |
|---|---|
| Repo, MIT, README credits, commits, cover | Done (`hms1499/q-lifeboat`, GitHub detects MIT, `assets/cover-16x9.png`) |
| Video, form fields (`qor1` addresses, AI-native box, "How it's made") | Builder, at submission |
| Kits detected | `@qorechain/sdk`, `@qorechain/evm` only |
| Scoped EVM window of the agent | Done: the guardian's window targets the vault only, with tx, value and block limits |
| Spending rules | Done: `allowedEvmCalls=[vault.rescue]`, `allowedDenoms=["uqor"]`, per-tx, daily, expiry |
| Authenticated messaging | **Weak:** incident reports are signed with the agent's **ed25519** key (classical), checked against the on-chain authenticator list |
| Audit | Stage 1 + 2 done in Markdown; **no PDFs** |
| Agent key of the root owner | **Expires 2026-11-27 08:01 UTC** (`AGENT_TTL_SECONDS` = 7 days): every report shows ✗ "expired" from then, through checks and judging |

## Gap 1: the agent link must outlive judging (high tier: signs on diana)

**Problem.** `apps/cli/src/setup.ts` links the agent key for 7 days. The root owner's key (`1cb28515…`) expires 2026-11-27, so
from then the dashboard marks every report ✗ (`verify.ts` "The key is not revoked or expired"), and the Guardian's spending
rule binds no live key. Checks run 3-5 Dec and judging 6-15 Dec.

Also: `selectLinkMsgs` sends only the rules update when the key is still linked and live, so `pnpm cli link` on a live key does
**not** renew its expiry.

**Change.**
- `AGENT_TTL_SECONDS` = 30 days (the FAQ's re-link interval). Test first: `buildGuardianLinkMsgs` sets `expiryUnix = now + 30 d`.
- If diana refuses an expiry that far out, fall back to the largest it accepts, and record the limit as a chain fact.
- Renew the root owner's link **once the change is merged**, through the path chain fact 21 proved: `pnpm cli unlink --expect
  0xE871…`, then `pnpm cli link --expect 0xE871…`. Done on 2026-11-25, that gives expiry about 2026-12-25, past judging (15 Dec).
- The dashboard already flags an expiring key on Protect. No change there.

**Verify.**
- `pnpm -F cli test` (new test red first).
- On diana: the two tx hashes. `pnpm cli status` shows the key `revoked: false` with `expiryUnix` >= 2026-12-20.
- The dashboard's Incidents screen shows the root owner's reports ✓ again.
- Record in `docs/EVIDENCE.md`. Add a CLAUDE.md session note: re-link before 2026-12-25 if the project page must stay green
  longer.

**Note.** While the key is unlinked (between the two txs, seconds), the Guardian's spending rule binds no key. Rescues are not
affected: they run from the guardian account (chain fact 7).

## Gap 2: audit reports as dated PDFs (builder + docs, low tier)

**Change.**
- The builder exports both QCAI reports from dashboard.qorechain.io as PDF:
  - Stage 1: 2026-11-20, v1 `a069e98`.
  - Stage 2: 2026-11-24, v3 `4dc7600`.
- They go in as `docs/audit/stage1-2026-11-20.pdf` and `docs/audit/stage2-2026-11-24.pdf`, next to the Markdown copies (kept,
  since they are readable on GitHub).
- If the dashboard no longer offers Stage 1 as a PDF, keep the Markdown and say so in `AUDIT.md`. Never re-run Stage 1 on the
  new code to make a PDF: Stage 1 must be the audit of v1.
- `AUDIT.md` table links each PDF. Add the Stage 2 score once the builder reads it off the dashboard (the copied text had none).
- Write the one-line "How it's made" text for the form (in the reply, not the repo).

**Verify.** Both PDFs open and show their date and contract. The links in `AUDIT.md` resolve on GitHub.

## Gap 3: post-quantum authenticated incident reports (high tier: agent signing, report format, verification)

**Goal.** Every incident report is also signed by the **vault's guardian account** with QoreSign's hybrid message signature
(secp256k1 + ML-DSA-87). The dashboard verifies it in the browser with `verifyMessageWithChain`:

- against the ML-DSA-87 key the guardian registered on chain;
- with the signer bound to `vault.guardian()`, read on chain (immutable).

This makes the report's authentication post-quantum. It uses the QoreChain feature the category names, and adds the
`@qorechain/qoresign` kit (Apache-2.0, credit it in the README) to the detected kits.

**Why the guardian account, not a new key.** The agent already holds `GAS_MNEMONIC`: it opens the guardian's windows with hybrid
txs, so that account has an ML-DSA-87 key registered on chain. The vault pins it as `guardian`, so "signed by the vault's
guardian" needs no extra trust in the agent's `/config`. No new secret, no new chain tx.

**Format** (`packages/core/src/incident.ts`).
- New optional field `guardianSig: MessageSignature` (QoreSign's type: `signatureType`, `classical {keyType, publicKey,
  signature}`, `pq {algorithmId, signature}`), plus `guardian: "qor1…"`.
- The QoreSign `data` is the same bytes the ed25519 key signs (`incidentSigningBytes`, domain `QDAY-GUARDIAN-INCIDENT-V1\n` +
  canonical JSON). The `sig` and `guardianSig` fields are excluded from them.
- QoreSign prefixes its own domain (`qorechain-msg-v1|qorechain-diana|`), so the two signatures can never be swapped for each
  other or for a tx.
- The ed25519 signature stays: it is what binds the report to the agent key linked on the owner's account, and old reports only
  have it.

**Agent** (`apps/agent/src/report.ts`, `index.ts`).
- Sign with `signMessage({chainId: "qorechain-diana", signer: guardian qor1, data, classicalKey: eth_secp256k1 from the
  guardian's private key, pqKey: the guardian's ML-DSA-87 secret key})`.
- **Rescue first** (Review Focus 8): co-signing runs in the existing after-rescue report path. If it throws, the report is
  published with `sig` only and the error is logged. It never delays or blocks a rescue or the alert.
- The drill agent signs with the drill guardian, which is its vault's guardian. Same code.

**Dashboard** (`apps/dashboard/src/lib/verify.ts`, Incidents screen).
- New check, "Signed by the vault's guardian with its post-quantum key":
  - **pass** when `verifyMessageWithChain({rest: <the /qore-rest proxy>, chainId, signer, data, signature, requirePq: true})`
    succeeds and `signer` is the `qor1` form of `vault.guardian()`;
  - **fail** on any mismatch, a bad signature, a missing `pq` part, or no registered key;
  - **n/a** ("signed before post-quantum co-signing") for a report with no `guardianSig`.
- **n/a does not fail the report.** The existing ed25519 checks still apply in full, so dropping `guardianSig` from a forged
  report gains nothing.
- Show `possessionProven` in the check detail.
- The REST read goes through the same-origin `/qore-rest` proxy (chain fact 18), passed as `rest` plus a `fetch` that resolves
  it.

**Spike before building (THROWAWAY, `spike/`, 1-2 h).** Answer each with evidence, before writing the plan:
1. QoreSign's classical key type for our accounts. The SDK derives the `m/44'/60'` key, so `eth_secp256k1`. Does
   `classicalKeyTypeFor` / the ADR-36 check map it to the guardian's `qor1` (`qor1l7pv44nr3gudwqyap4wlkat3x6cvqwzsvtm0pt`)?
2. Does a signature made with the SDK's ML-DSA-87 secret key for the guardian (`deriveUnifiedAccount(GAS_MNEMONIC).pqc`) verify
   with `verifyMessageWithChain` against the key registered on diana? Does `possessionProven` come back true?
3. Does `@qorechain/qoresign/network` run in the Vite browser bundle (it depends on `@qorechain/pqc`)? What does it add to the
   bundle? Does `fetch` through `/qore-rest` work?
4. Does `verifyMessageWithChain` reject a flipped byte in `data`, and a signature by another registered account?

If (1) or (2) fails, stop and report. The fallback is to sign with `pqSign` from `@qorechain/sdk` over the same QoreSign
sign-bytes, and verify the ML-DSA-87 part in the browser against `fetchPqcStatus`. That still makes the report post-quantum, but
it is not the QoreSign kit, so the kit is not detected.

**Tests (red first).**
- `core`:
  - the signing bytes exclude `sig` and `guardianSig`;
  - adding `guardianSig` does not change the ed25519 bytes;
  - a shared fixture: one report with both signatures.
- `agent`:
  - the report carries `guardian` + `guardianSig` that verify with QoreSign's offline `verifyMessage` and the guardian's public
    key;
  - a co-signing failure still publishes the report with `sig` and logs;
  - co-signing runs after `rescue()`, never on the single-flight path (extend the Review Focus 8 test).
- `dashboard` (injected verifier):
  - pass;
  - fail on a signer that is not `vault.guardian()`;
  - fail on a tampered body;
  - fail on a classical-only signature;
  - n/a without `guardianSig`;
  - the overall verdict stays ✓ for an old report that passes every ed25519 check.

**Verify on diana.**
- `./demo.sh` (or `--phish`) with the new agent produces a report whose new check is ✓ in the dashboard.
- Flip one byte of a stored report's `summary`: the check turns ✗.
- Record the run id and incident id in EVIDENCE.
- Update THREAT_MODEL T8 (forged report), README "QoreChain features used", and the kit credits.

**Review.** Fresh-context review against Review Focus 5 (a valid signature from a key that is not the right one shows ✗) and 8
(rescue never waits on reporting).

## Gap 4: README for judges (docs, low tier)

**Change.** A "For judges" section near the top of the README:

1. **Five-minute check without running anything:**
   - the vault and its immutable `owner()` / `guardian()`;
   - one rescue tx and its receipt;
   - the refused agent-key `transfer` (`7E9B629F…`);
   - a refused forged withdraw;
   - the `MsgOpenEVMWindow` of the guardian;
   - the link with the spending rule;
   - links into EVIDENCE for each.
2. **The category's requirements, mapped:** a table of requirement → where it is in the code → the diana tx that proves it. Rows:
   - the agent's own scoped EVM window;
   - spending rules;
   - authenticated messaging (Gap 3);
   - limits on tx, value, duration and target;
   - `pqcVerify` / `pqcKeyStatus` in the vault.
3. **Why rescues are not `MsgExecuteEVM` through the linked key:** chain facts 2 and 12, with their txs. A token move from the
   account through the lane needs the token listed as `erc20/…`, and listing it lets the key `transfer` that token directly.
   That breaks the hard rule that the agent can only move funds to safety. So the agent rescues from its own account, which the
   vault pins as `guardian`, and the linked key keeps the spending rule and signs reports.
4. **`qor1` addresses to list on the project page:**
   - owner `qor1apchfrqfyf694k2dqedr3r54a3pq5eltmjxxpv`;
   - guardian `qor1l7pv44nr3gudwqyap4wlkat3x6cvqwzsvtm0pt`;
   - funder `qor14zxae5fs0rks778qpdwwlr0aaw48jd4pk5dupt`;
   - the vault's `qor1` form.

   Say which feature each one's txs prove: window open, link, deploy of the `pqcVerify` contract, `MsgExecuteEVM`.

**Verify.**
- Every hash and address in the section is copied from `docs/EVIDENCE.md` or read on chain, never typed.
- Every link resolves on GitHub.

## Order and timing

| When | Gap | Who |
|---|---|---|
| 2026-11-24/25 | 1: TTL 30 days (code + test), then unlink + link the root owner | Claude, the txs signed by the CLI from the root `.env` |
| 2026-11-25 | 3: spike, then the builder approves the plan or the fallback | Claude, then the builder |
| 2026-11-25 → 11-28 | 3: build, verify on diana, review | Claude |
| 2026-11-28/29 | 4: README for judges (after 3, so it can cite it) | Claude |
| Any time before 12-02 | 2: export the PDFs | Builder, then Claude updates `AUDIT.md` |
| 2026-11-30 | Feature freeze: Gap 3 cut if not verified on diana by then (README keeps describing the ed25519 reports) | |

## Out of scope

- Rescuing through the linked key (`MsgExecuteEVM`): unsafe, see Gap 4 point 3.
- A hosted dashboard: the agent's API is loopback-only by design (Review Focus 6). The video and the judges' section cover it.
- The Q-Day Survivor award: drill registration closed on 17 Nov, before this project started.
- Changing the contract: Stage 2 needed no change. Any change now would also need a new Stage 2.
