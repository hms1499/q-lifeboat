import type { Incident, OutboundTx, RescueRecord } from "@qday/core";
import { decide, type Policy } from "./rules";

export type GuardianDeps = {
  policy: Policy;
  /** Rescue everything; `trigger` is the transfer or approval that caused it (its token is rescued first). */
  rescue: (trigger: OutboundTx) => Promise<RescueRecord[]>;
  /** Summarize, sign and persist. `alert` marks an alert-only incident (no rescue attempted). */
  record: (facts: { trigger: OutboundTx; reason: string; rescues: RescueRecord[]; detectedAt: string; alert?: boolean }) => Promise<Incident>;
  publish: (incident: Incident) => void;
  log: (line: string) => void;
};

/**
 * Glue between watch, rules, rescue and report. Only `decide` can start a rescue (or raise an alert-only incident).
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

  /**
   * Alert only: record and publish, never rescue. It runs beside the single-flight state, never touching it, so an
   * alert can neither delay nor block a rescue in flight. A failure is logged, never thrown.
   */
  async function alert(tx: OutboundTx, reason: string, detectedAt: string) {
    try {
      const incident = await deps.record({ trigger: tx, reason, rescues: [], detectedAt, alert: true });
      deps.publish(incident);
      deps.log(`incident ${incident.id}: alert only, no rescue`);
    } catch (e) {
      deps.log(`incident pipeline error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function onTx(tx: OutboundTx): Promise<void> {
    const d = decide(tx, deps.policy);
    const verdict = d.rescue ? "RESCUE" : d.alert ? "ALERT" : "ok";
    deps.log(`outbound ${tx.kind} ${tx.hash} to ${tx.to} amount ${tx.amount}: ${verdict} (${d.reason})`);
    if (!d.rescue) {
      if (d.alert) await alert(tx, d.reason, new Date().toISOString());
      return;
    }
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
