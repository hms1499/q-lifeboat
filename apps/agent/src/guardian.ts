import type { Incident, OutboundTx, RescueRecord } from "@qday/core";
import type { AlertEvent } from "./notify";
import { decide, type Policy } from "./rules";

type Facts = { trigger: OutboundTx; reason: string; rescues: RescueRecord[]; detectedAt: string; alert?: boolean };

export type GuardianDeps = {
  /** Read on every trigger, so an edited policy file changes the next decision without a restart. */
  policy: () => Policy;
  /** Rescue everything; `trigger` is the transfer or approval that caused it (its token is rescued first). */
  rescue: (trigger: OutboundTx) => Promise<RescueRecord[]>;
  /** Summarize, sign and persist. `alert` marks an alert-only incident (no rescue attempted). */
  record: (facts: Facts) => Promise<Incident>;
  publish: (incident: Incident) => void;
  /** Tell the owner (Telegram, webhook). Fire and forget: never awaited, a throw or rejection is only logged. */
  notify?: (e: AlertEvent) => void | Promise<unknown>;
  log: (line: string) => void;
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Glue between watch, rules, rescue and report. Only `decide` can start a rescue (or raise an alert-only incident).
 * Single-flight: triggers arriving during a rescue queue one recheck, which is a no-op
 * (and records nothing) when nothing is left to move.
 *
 * Review Focus 8: only `rescue()` runs on the single-flight path. Reporting (record -> LLM summary -> publish) and
 * notifying start once a rescue resolves and are never awaited, so a slow LLM or a hung notifier can neither delay
 * nor block the next queued rescue.
 */
export function createGuardian(deps: GuardianDeps) {
  let inFlight = false;
  let queued: { tx: OutboundTx; reason: string; detectedAt: string } | null = null;

  /** Record and publish in the background. A failure is logged, never thrown. */
  function report(facts: Facts, done: (incident: Incident) => string): void {
    void (async () => {
      const incident = await deps.record(facts);
      deps.publish(incident);
      deps.log(done(incident));
    })().catch((e) => deps.log(`incident pipeline error: ${errorText(e)}`));
  }

  /** Notify in the background. A notifier that throws synchronously or rejects is logged, never propagated. */
  function notify(e: AlertEvent): void {
    if (!deps.notify) return;
    try {
      void Promise.resolve(deps.notify(e)).catch((err) => deps.log(`notify error: ${errorText(err)}`));
    } catch (err) {
      deps.log(`notify error: ${errorText(err)}`);
    }
  }

  async function runOnce(tx: OutboundTx, reason: string, detectedAt: string, alwaysRecord: boolean) {
    let rescues: RescueRecord[] = [];
    let why = reason;
    let error: string | undefined;
    try {
      rescues = await deps.rescue(tx);
    } catch (e) {
      error = errorText(e);
      why = `${reason} (rescue error: ${error})`;
      deps.log(`rescue error: ${why}`);
    }
    if (!alwaysRecord && rescues.length === 0) return;
    report({ trigger: tx, reason: why, rescues, detectedAt }, (i) => `incident ${i.id}: ${rescues.filter((r) => r.success).length}/${rescues.length} rescued`);
    notify({ type: "rescue", trigger: tx, reason: why, rescues, detectedAt, ...(error === undefined ? {} : { error }) });
  }

  /** A failing run is logged and never leaves state behind. */
  async function guarded(tx: OutboundTx, reason: string, detectedAt: string, alwaysRecord: boolean) {
    try {
      await runOnce(tx, reason, detectedAt, alwaysRecord);
    } catch (e) {
      deps.log(`incident pipeline error: ${errorText(e)}`);
    }
  }

  /**
   * Alert only: record, publish and notify, never rescue. It runs beside the single-flight state, never touching it,
   * so an alert can neither delay nor block a rescue in flight.
   */
  function alert(tx: OutboundTx, reason: string, detectedAt: string): void {
    report({ trigger: tx, reason, rescues: [], detectedAt, alert: true }, (i) => `incident ${i.id}: alert only, no rescue`);
    notify({ type: "alert", trigger: tx, reason, detectedAt });
  }

  async function onTx(tx: OutboundTx): Promise<void> {
    const d = decide(tx, deps.policy());
    const verdict = d.rescue ? "RESCUE" : d.alert ? "ALERT" : "ok";
    deps.log(`outbound ${tx.kind} ${tx.hash} to ${tx.to} amount ${tx.amount}: ${verdict} (${d.reason})`);
    if (!d.rescue) {
      if (d.alert) alert(tx, d.reason, new Date().toISOString());
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
