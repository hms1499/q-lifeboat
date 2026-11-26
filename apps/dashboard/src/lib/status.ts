import type { NavMode } from "./nav";

export type StatusInput = {
  mode: NavMode;
  /** The agent served (or the browser cached) a config for this owner. */
  hasCfg: boolean;
  /** The config does not match the vault on chain. */
  checkFailed: boolean;
  agentOnline: boolean;
  /** GET /health `ok`; undefined before the first answer. */
  healthOk: boolean | undefined;
};

/** The Guardian's state line in the sidebar. A browser that never set one up is not "offline". */
export function guardianStatus(i: StatusInput): { dot: string; text: string } {
  if (i.hasCfg && i.checkFailed) return { dot: "bad", text: "Vault check failed" };
  if (i.mode === "visitor") return { dot: "off", text: "Not set up yet" };
  if (!i.hasCfg && i.mode === "hosted") return { dot: "off", text: "Setup not finished" };
  if (!i.hasCfg || !i.agentOnline) return { dot: "off", text: "Guardian offline" };
  if (i.healthOk === false) return { dot: "degraded", text: "Guardian degraded" };
  return { dot: "", text: "Guardian online" };
}

/**
 * The Guardian's state line in the protected owner's shell. Same signals and order as `guardianStatus` (the vault check
 * first, then reachability, then /health), plus an unseen incident, a Guardian the service paused, and "checking"
 * before the first /config answer.
 */
export function appStatus(i: {
  unseen: boolean;
  hasCfg: boolean;
  checkFailed: boolean;
  agentOnline: boolean;
  agentChecked: boolean;
  healthOk: boolean | undefined;
  paused: boolean;
}): { dot: string; text: string } {
  const g = guardianStatus({ mode: "hosted", hasCfg: i.hasCfg, checkFailed: i.checkFailed, agentOnline: i.agentOnline, healthOk: i.healthOk });
  if (g.dot === "bad") return g;
  if (i.unseen) return { dot: "degraded", text: "Rescue happened" };
  if (g.dot === "off") {
    if (i.paused) return { dot: "off", text: "Guardian paused" };
    return { dot: "off", text: i.agentChecked ? "Guardian not answering" : "Checking your Guardian…" };
  }
  if (g.dot === "degraded") return g;
  return { dot: "", text: "Guardian watching" };
}
