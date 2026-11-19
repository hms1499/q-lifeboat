# AI usage

This project is built AI-native: one human builder working with **Claude Code** (Claude Opus 5.5) as
pair programmer, researcher and reviewer. This log records what the AI did, what the human decided,
and how AI output was checked. It is updated at the end of every task.

## Rules we hold ourselves to
- The human picks scope and approves every design decision. AI proposals are marked as proposals.
- Nothing the AI claims about the chain is trusted until it is shown on testnet (`docs/EVIDENCE.md`).
- At runtime, the product's LLM only writes incident summaries. It never decides to move funds.

## Log

| Date | Task | What AI did | Human decision / verification |
|---|---|---|---|
| 2026-11-19 | Research | Read the event site (rules, prizes, FAQ, start), the kits list, the workshop-2 docs and the `@qorechain/sdk` typings. Summarised the categories and constraints | Builder chose PQ AI Agents |
| 2026-11-19 | Ideation | Proposed 5 ideas per category with the biggest risk and a fake/demo strategy for each | Builder picked "Q-Day Guardian" |
| 2026-11-19 | Spec + plan | Found from SDK typings that `allowedEvmCalls` supports `target/selector`. Wrote the MVP spec and an 8-task plan with test names | Builder approved both |
| 2026-11-19 | Task 0 spike | Wrote throwaway probe contracts and scripts, ran them on diana, and recorded results | Builder funded the accounts. All 5 findings backed by tx hashes in `docs/EVIDENCE.md` |
