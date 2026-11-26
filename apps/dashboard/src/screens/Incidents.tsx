import type { Incident } from "@qday/core";
import { useEffect, useState } from "react";
import type { Hex } from "viem";
import { CheckRow, TxHash } from "../components/ui";
import { readReceipt } from "../lib/chain";
import type { AgentConfig } from "../lib/config";
import { ago, fmtAmount, fmtInt, shortAddr, shortHash, tokenSymbol, when } from "../lib/format";
import { describeIncident } from "../lib/explain";
import { big, incidentTag, triggerKind } from "../lib/incidents";
import { useOwnedIncidents } from "../lib/useOwned";
import type { VerifyResult } from "../lib/verify";
import { useApp } from "../state";
import { IncidentReport, subtitle } from "../components/IncidentReport";

export function Incidents({ selected }: { selected?: string }) {
  const { incidents, incidentsError, verdictFor, config } = useApp();
  const { own, others, isChecking } = useOwnedIncidents();
  const cfg = config.cfg;
  // A report opened by link may belong to another account: show it, and the list stays the owner's.
  const current = incidents.find((i) => i.id === selected) ?? own[0] ?? others[0];

  const card = (i: Incident) => {
    const tag = incidentTag(i);
    const v = verdictFor(i);
    return (
      <a
        key={i.id}
        className={`inc-item ${tag === "Rescue" ? "rescue" : "alert"}`}
        href={`#/incidents/${encodeURIComponent(i.id)}`}
        aria-current={i === current ? "true" : undefined}
      >
        <span className="t">{describeIncident(i, cfg).headline}</span>
        <span className="s">{subtitle(i, cfg)}</span>
        <span className="m">
          <span className={tag === "Rescue" ? "kind-rescue" : undefined}>{tag}</span>
          <span title={i.detectedAt}>{ago(i.detectedAt)}</span>
          {v ? (
            v.ok ? (
              <span className="ok">
                <span aria-hidden="true">✓</span> Verified
              </span>
            ) : (
              <span className="bad">
                <span aria-hidden="true">✗</span> Not verified
              </span>
            )
          ) : (
            <span>Checking…</span>
          )}
        </span>
        {isChecking(i) ? <span className="inc-owner">Checking owner…</span> : null}
      </a>
    );
  };

  return (
    <>
      <h1>Incidents</h1>
      <p className="lead">Every rescue and alert the Guardian raised, with a report it signed. Fixed rules decide; AI only writes the summary.</p>
      {incidentsError && !incidents.length ? <div className="banner warn">Could not load incidents from the agent: {incidentsError}</div> : null}
      {!incidents.length && !incidentsError ? <div className="empty">No incidents yet. New ones appear here live.</div> : null}
      {incidents.length ? (
        <div className="inc-layout">
          <section aria-label="Incident list" className="inc-list">
            {own.length ? own.map(card) : <div className="empty">No incidents for your account yet.</div>}
            {others.length ? (
              <details className="others">
                <summary>Other accounts ({others.length})</summary>
                <p className="note">Reports this agent wrote for other accounts (e.g. demo runs). They don't verify against your vault.</p>
                {others.map(card)}
              </details>
            ) : null}
          </section>
          {current ? <IncidentReport key={current.id} i={current} cfg={cfg} v={verdictFor(current)} /> : null}
        </div>
      ) : null}
    </>
  );
}
