import type { Incident } from "@qday/core";
import { ATTACK_AMOUNT } from "./attack";

/** What the dashboard's status hero shows. An unseen incident stays until the owner opens or dismisses it. */
export function heroState(i: { unseen: Incident | null; agentOnline: boolean }): "incident" | "calm" | "offline" {
  if (i.unseen) return "incident";
  return i.agentOnline ? "calm" : "offline";
}

/** The protection test sends 10 fUSD; below 20 it mints 100 first in the same window, so the Guardian has something to rescue. */
export function testPlan(fusd: bigint | undefined): "loading" | "ready" | "mint-first" {
  if (fusd === undefined) return "loading";
  return fusd < ATTACK_AMOUNT * 2n ? "mint-first" : "ready";
}
