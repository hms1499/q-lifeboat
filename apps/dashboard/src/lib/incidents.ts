import type { Incident } from "@qday/core";

/**
 * Incidents as the agent serves them: JSON, so every bigint is a decimal string. They are kept exactly as received,
 * because the signature covers those bytes; display helpers read them without rewriting anything.
 */

const time = (i: Incident) => {
  const t = Date.parse(i.detectedAt);
  return Number.isNaN(t) ? -Infinity : t;
};

/** Newest first by `detectedAt` (6C may append out of order). Returns a new array. */
export function sortIncidents(list: readonly Incident[]): Incident[] {
  return [...list].sort((a, b) => time(b) - time(a));
}

/** A trigger without `kind` predates Task 6B and is a transfer. Never writes `kind` back (the signature covers it). */
export function triggerKind(i: Incident): "transfer" | "approval" {
  return (i.trigger as { kind?: string } | undefined)?.kind === "approval" ? "approval" : "transfer";
}

/** "Rescue" when the agent tried to move funds, "Alert" when it only reported. */
export function incidentTag(i: Incident): "Rescue" | "Alert" {
  return Array.isArray(i.rescues) && i.rescues.length > 0 ? "Rescue" : "Alert";
}

/** Add a live (SSE) incident unless its id is already listed; result sorted. */
export function mergeIncident(list: readonly Incident[], incoming: Incident): Incident[] {
  if (list.some((i) => i.id === incoming.id)) return sortIncidents(list);
  return sortIncidents([...list, incoming]);
}

/** The /incidents body: keep the entries that are objects with a string id. */
export function parseIncidentList(body: unknown): Incident[] {
  if (!Array.isArray(body)) return [];
  return body.filter((i): i is Incident => !!i && typeof i === "object" && typeof (i as { id?: unknown }).id === "string");
}

/** A JSON decimal string (or bigint) as bigint; 0n when unreadable. For display only. */
export function big(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  return 0n;
}
