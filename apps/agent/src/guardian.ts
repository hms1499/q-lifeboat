import type { Incident, OutboundTx, RescueRecord } from "@qday/core";
import { decide, type Policy } from "./rules";

export type GuardianDeps = {
  policy: Policy;
  rescue: () => Promise<RescueRecord[]>;
  /** Summarize, sign and persist. */
  record: (facts: { trigger: OutboundTx; reason: string; rescues: RescueRecord[] }) => Promise<Incident>;
  publish: (incident: Incident) => void;
  log: (line: string) => void;
};

/**
 * Glue between watch, rules, rescue and report. Only `decide` can start a rescue.
 * Single-flight: triggers arriving during a rescue queue one recheck, which is a no-op
 * (and records nothing) when nothing is left to move.
 */
export function createGuardian(deps: GuardianDeps) {
  let inFlight = false;
  let queued: { tx: OutboundTx; reason: string } | null = null;

  async function runOnce(tx: OutboundTx, reason: string, alwaysRecord: boolean) {
    let rescues: RescueRecord[] = [];
    let why = reason;
    try {
      rescues = await deps.rescue();
    } catch (e) {
      why = `${reason} (rescue error: ${e instanceof Error ? e.message : String(e)})`;
      deps.log(`rescue error: ${why}`);
    }
    if (!alwaysRecord && rescues.length === 0) return;
    const incident = await deps.record({ trigger: tx, reason: why, rescues });
    deps.publish(incident);
    deps.log(`incident ${incident.id}: ${rescues.filter((r) => r.success).length}/${rescues.length} rescued`);
  }

  async function onTx(tx: OutboundTx): Promise<void> {
    const d = decide(tx, deps.policy);
    deps.log(`outbound ${tx.hash} to ${tx.to} amount ${tx.amount}: ${d.rescue ? "RESCUE" : "ok"} (${d.reason})`);
    if (!d.rescue) return;
    if (inFlight) {
      queued = { tx, reason: d.reason };
      return;
    }
    inFlight = true;
    try {
      await runOnce(tx, d.reason, true);
      while (queued) {
        const next = queued;
        queued = null;
        await runOnce(next.tx, next.reason, false);
      }
    } finally {
      inFlight = false;
    }
  }

  return { onTx };
}
