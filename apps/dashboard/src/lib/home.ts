/** The Task 12 browser-run rescues on diana (docs/EVIDENCE.md, 2026-11-26): leak block, rescue block, first rescue tx. */
export const PROOF = [
  { owner: "0xd23f…313a", leakBlock: 10_762_125, rescueBlock: 10_762_127, kept: "90 %", rescueTx: "0xb17e94e9…ac37" },
  { owner: "0x7f4f…8d99", leakBlock: 10_762_743, rescueBlock: 10_762_745, kept: "90 %", rescueTx: "0x3cf95093…6f03" },
  { owner: "0x337a…56b6", leakBlock: 10_762_878, rescueBlock: 10_762_880, kept: "90 %", rescueTx: "0x1000ba5e…d45a" },
] as const;

const REPO = "https://github.com/hms1499/q-lifeboat";
/** The public repo and the documents the homepage points to (main branch). */
export const LINKS = {
  github: REPO,
  threatModel: `${REPO}/blob/main/docs/THREAT_MODEL.md`,
  audit: `${REPO}/blob/main/docs/AUDIT.md`,
  evidence: `${REPO}/blob/main/docs/EVIDENCE.md`,
} as const;
