/** What a signing action needs from the session: the unlocked wallet (classical) or also the recovery-code key (pqc). */
export type KeyNeed = "classical" | "pqc";

/** Which fields the unlock dialog shows: only what the session lacks for this action. */
export function keysNeeded(s: { classical: boolean; pqc: boolean }, need: KeyNeed): { password: boolean; code: boolean } {
  return { password: !s.classical, code: need === "pqc" && !s.pqc };
}
