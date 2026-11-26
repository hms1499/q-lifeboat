import type { Incident } from "@qday/core";

type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void } | undefined;
const key = (owner: string) => `qlifeboat.seen-incident.${owner.toLowerCase()}`;

/** The id of the last incident this owner opened or dismissed in this browser. */
export function loadSeenIncident(kv: KV, owner: string): string | null {
  try {
    return kv?.getItem(key(owner)) ?? null;
  } catch {
    return null;
  }
}

export function saveSeenIncident(kv: KV, owner: string, id: string): void {
  try {
    kv?.setItem(key(owner), id);
  } catch {
    // storage blocked: the incident shows again next visit
  }
}

/** The newest incident, unless it is the one already seen. */
export function unseenIncident(list: readonly Incident[], seenId: string | null): Incident | null {
  const newest = [...list].sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt))[0];
  return newest && newest.id !== seenId ? newest : null;
}
