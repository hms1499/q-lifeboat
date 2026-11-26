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
