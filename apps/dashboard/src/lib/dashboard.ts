import type { Incident } from "@qday/core";
import { ATTACK_AMOUNT } from "./attack";

export type Hero = "incident" | "check" | "paused" | "loading" | "offline" | "degraded" | "calm";

/**
 * What the dashboard's status hero shows. An unseen incident stays until the owner opens or dismisses it. "calm" (the
 * Guardian is watching) only when nothing argues against it: the vault check passed or is pending, the service has not
 * retired the Guardian, the agent answers and its last /health was not a failure.
 */
export function heroState(i: {
  unseen: Incident | null;
  agentOnline: boolean;
  /** The first /config read has settled (answer or failure). */
  agentChecked: boolean;
  /** The config does not match the vault's immutable owner and guardian on chain. */
  checkFailed: boolean;
  /** GET /health `ok`; undefined before the first answer. */
  healthOk: boolean | undefined;
  /** The service retired this owner's Guardian after 7 idle days. */
  paused: boolean;
}): Hero {
  if (i.unseen) return "incident";
  if (i.checkFailed) return "check";
  if (i.paused && !i.agentOnline) return "paused";
  if (!i.agentOnline) return i.agentChecked ? "offline" : "loading";
  if (i.healthOk === false) return "degraded";
  return "calm";
}

/** The protection test sends 10 fUSD; below 20 it mints 100 first in the same window, so the Guardian has something to rescue. */
export function testPlan(fusd: bigint | undefined): "loading" | "ready" | "mint-first" {
  if (fusd === undefined) return "loading";
  return fusd < ATTACK_AMOUNT * 2n ? "mint-first" : "ready";
}
