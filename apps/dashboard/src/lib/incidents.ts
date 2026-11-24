import { canonicalJson, type Incident } from "@qday/core";

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

/**
 * Add a live (SSE) incident; a replay of the same report (every field, co-signature included) is ignored, a new body under a known id replaces the old one
 * (its verdict is then pending until it is verified: see verifyPolicy). Result sorted.
 */
export function mergeIncident(list: readonly Incident[], incoming: Incident): Incident[] {
  const at = list.findIndex((i) => i.id === incoming.id);
  if (at < 0) return sortIncidents([...list, incoming]);
  if (canonicalJson(list[at]) === canonicalJson(incoming)) return sortIncidents(list); // the same report, co-signature included
  return sortIncidents(list.map((i, n) => (n === at ? incoming : i)));
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isAddr = (v: unknown) => isStr(v) && /^0x[0-9a-fA-F]{40}$/.test(v);
const isDec = (v: unknown) => isStr(v) && /^\d{1,78}$/.test(v);

/**
 * The fields the screens and verify.ts read, with the types they assume (bigints arrive as decimal strings). Only a
 * shape check: whether the content is TRUE is verify.ts's job.
 */
export function isIncidentShape(x: unknown): x is Incident {
  if (!isObj(x)) return false;
  if (!isStr(x.id) || !isStr(x.detectedAt) || !isStr(x.reason) || !isStr(x.summary) || !isStr(x.summarySource)) return false;
  if (!isStr(x.agentPubkey) || !isStr(x.sig)) return false;
  const t = x.trigger;
  if (!isObj(t) || !isStr(t.hash) || !isDec(t.block) || !isAddr(t.token) || !isAddr(t.to) || !isDec(t.amount)) return false;
  if (t.kind !== undefined && t.kind !== "transfer" && t.kind !== "approval") return false;
  if (!Array.isArray(x.rescues)) return false;
  return x.rescues.every(
    (r) => isObj(r) && isAddr(r.token) && isStr(r.hash) && isDec(r.amount) && typeof r.success === "boolean" && (r.error === undefined || isStr(r.error)),
  );
}

/** The /incidents body (or one SSE frame): malformed entries are dropped (and counted) so they cannot crash a screen. */
export function parseIncidentList(body: unknown, onDropped?: (n: number) => void): Incident[] {
  if (!Array.isArray(body)) return [];
  const ok = body.filter(isIncidentShape);
  if (ok.length < body.length) onDropped?.(body.length - ok.length);
  return ok;
}

/** A JSON decimal string (or bigint) as bigint; 0n when unreadable. For display only. */
export function big(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  return 0n;
}

/**
 * Split by who sent the trigger tx, as read from the chain (`senders`, keyed by lowercase trigger hash). The agent's
 * file also holds reports for other demo owners and has no owner field, so ownership never comes from the agent.
 * A sender not read yet (null / missing) is "checking": kept visible, never dropped. Order preserved.
 */
export function partitionByOwner(
  list: readonly Incident[],
  senders: Record<string, string | null | undefined>,
  owner: string,
): { mine: Incident[]; others: Incident[]; checking: Incident[] } {
  const out = { mine: [] as Incident[], others: [] as Incident[], checking: [] as Incident[] };
  const me = owner.toLowerCase();
  for (const i of list) {
    const from = senders[String(i.trigger?.hash ?? "").toLowerCase()];
    if (typeof from !== "string") out.checking.push(i);
    else if (from.toLowerCase() === me) out.mine.push(i);
    else out.others.push(i);
  }
  return out;
}
