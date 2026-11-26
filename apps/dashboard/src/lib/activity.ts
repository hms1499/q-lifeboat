import type { Incident } from "@qday/core";
import type { Activity } from "./ownerReads";

const BLOCK_MS = 1_400;

export type FeedItem = { kind: "incident"; at: number; incident: Incident } | { kind: "outgoing"; at: number; item: Activity };

/**
 * One timeline: the Guardian's incidents and the account's outgoing transfers and approvals, newest first. A transfer
 * that triggered an incident shows once, as that incident. Blocks are timed from the tip at the 1.4 s block time.
 */
export function activityFeed(incidents: readonly Incident[], outgoing: readonly Activity[] | undefined, tip: bigint | undefined, now = Date.now()): FeedItem[] {
  const triggers = new Set(incidents.map((i) => String(i.trigger?.hash ?? "").toLowerCase()));
  const items: FeedItem[] = incidents.map((incident) => ({ kind: "incident" as const, at: Date.parse(incident.detectedAt), incident }));
  if (outgoing && tip !== undefined) {
    for (const item of outgoing) {
      if (triggers.has(item.hash.toLowerCase())) continue;
      items.push({ kind: "outgoing", at: now - Number(tip - item.block) * BLOCK_MS, item });
    }
  }
  return items.sort((a, b) => b.at - a.at);
}
