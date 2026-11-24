import { canonicalJson, type Incident } from "@qday/core";
import type { AgentConfig } from "./config";
import type { VerifyResult } from "./verify";

/**
 * When a verdict may be shown, and when a report must be verified (again). A verdict belongs to one exact report as
 * received (`bodyKey`: the id alone can come back with another body after a refetch, and the sig alone does not cover the
 * guardian's co-signature) under one config (owner, vault, guardian and the config-vs-chain verdict). Anything else is
 * pending: never a ✓ carried over from another body, co-signature or config.
 */

export type StoredVerification = { body: string; configKey: string; round: number; result: VerifyResult };

/** The whole report as received, canonical (keys sorted): every field, `sig` and `guardianSig` included. */
export const bodyKey = (i: Incident): string => canonicalJson(i);

/** null while there is no config or its chain check has not answered: nothing is verified or shown then. */
export function configKey(cfg: Pick<AgentConfig, "owner" | "vault" | "guardian"> | null, check: { ok: boolean } | null): string | null {
  if (!cfg || !check) return null;
  return `${cfg.owner}/${cfg.vault}/${cfg.guardian}/${check.ok}`.toLowerCase();
}

/** The verdict to display for this exact report under the current config, or undefined (pending). */
export function shownVerification(i: Incident, stored: StoredVerification | undefined, key: string | null): VerifyResult | undefined {
  if (key === null || !stored) return undefined;
  if (stored.body !== bodyKey(i) || stored.configKey !== key) return undefined;
  return stored.result;
}

/** True when this report has no verdict for its body, the current config, or the current re-check round. */
export function needsVerification(i: Incident, stored: StoredVerification | undefined, key: string | null, round: number): boolean {
  if (key === null) return false;
  return !stored || stored.body !== bodyKey(i) || stored.configKey !== key || stored.round < round;
}
