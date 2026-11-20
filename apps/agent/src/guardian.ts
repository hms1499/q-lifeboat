import type { Incident, OutboundTx, RescueRecord } from "@qday/core";
import { decide, type Policy } from "./rules";

export type GuardianDeps = {
  policy: Policy;
  /** Rescue everything; `trigger` is the transfer that caused it (its token is rescued first). */
  rescue: (trigger: OutboundTx) => Promise<RescueRecord[]>;
  /** Summarize, sign and persist. */
  record: (facts: { trigger: OutboundTx; reason: string; rescues: RescueRecord[]; detectedAt: string }) => Promise<Incident>;
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
  let queued: { tx: OutboundTx; reason: string; detectedAt: string } | null = null;

  async function runOnce(tx: OutboundTx, reason: string, detectedAt: string, alwaysRecord: boolean) {
    let rescues: RescueRecord[] = [];
    let why = reason;
    try {
      rescues = await deps.rescue(tx);
    } catch (e) {
      why = `${reason} (rescue error: ${e instanceof Error ? e.message : String(e)})`;
      deps.log(`rescue error: ${why}`);
    }
    if (!alwaysRecord && rescues.length === 0) return;
    const incident = await deps.record({ trigger: tx, reason: why, rescues, detectedAt });
    deps.publish(incident);
    deps.log(`incident ${incident.id}: ${rescues.filter((r) => r.success).length}/${rescues.length} rescued`);
  }

  /** A failing run (e.g. record() throws) is logged and never leaves state behind. */
  async function guarded(tx: OutboundTx, reason: string, detectedAt: string, alwaysRecord: boolean) {
    try {
      await runOnce(tx, reason, detectedAt, alwaysRecord);
    } catch (e) {
      deps.log(`incident pipeline error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function onTx(tx: OutboundTx): Promise<void> {
    const d = decide(tx, deps.policy);
    deps.log(`outbound ${tx.hash} to ${tx.to} amount ${tx.amount}: ${d.rescue ? "RESCUE" : "ok"} (${d.reason})`);
    if (!d.rescue) return;
    const detectedAt = new Date().toISOString();
    deps.log(`timing: trigger ${tx.hash} block ${tx.block} detected ${detectedAt}`);
    if (inFlight) {
      queued = { tx, reason: d.reason, detectedAt };
      return;
    }
    inFlight = true;
    try {
      await guarded(tx, d.reason, detectedAt, true);
      // Each queued trigger is consumed exactly once, even when a run fails.
      while (queued) {
        const next: { tx: OutboundTx; reason: string; detectedAt: string } = queued;
        queued = null;
        await guarded(next.tx, next.reason, next.detectedAt, false);
      }
    } finally {
      inFlight = false;
    }
  }

  return { onTx };
}
