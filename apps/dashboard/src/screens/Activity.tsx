import { useEffect } from "react";
import type { Hex } from "viem";
import { IncidentReport } from "../components/IncidentReport";
import { TxHash } from "../components/ui";
import { activityFeed } from "../lib/activity";
import { fetchPolicy } from "../lib/agent";
import { describeIncident } from "../lib/explain";
import { ago, fmtAmount, tokenSymbol } from "../lib/format";
import { usePoll } from "../lib/hooks";
import { incidentTag } from "../lib/incidents";
import { labelCounterparty } from "../lib/overview";
import { readActivity } from "../lib/ownerReads";
import { useSeenIncident } from "../hooks/useSeen";
import { useApp } from "../state";

/** One timeline of the Guardian's incidents and the account's outgoing transfers; an incident opens its signed report. */
export function Activity({ owner, selected }: { owner: Hex; selected?: string }) {
  const { config, incidents, incidentsError, verdictFor } = useApp();
  const cfg = config.cfg;
  const [, markSeen] = useSeenIncident(owner);
  const outgoing = usePoll(() => readActivity(cfg!), 15_000, cfg ? `${cfg.owner}/${Object.values(cfg.tokens).join()}` : null);
  const policy = usePoll(fetchPolicy, 30_000, config.agentOnline ? "activity-policy" : null);
  const open = selected ? incidents.find((i) => i.id === selected) : undefined;
  useEffect(() => {
    if (open) markSeen(open.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open?.id]);

  if (selected) {
    return (
      <>
        <a href="#/activity" className="act-back">
          ‹ All activity
        </a>
        {open ? <IncidentReport i={open} cfg={cfg} v={verdictFor(open)} /> : <p className="muted">{incidents.length ? "This report is not in your list." : "Loading the report…"}</p>}
      </>
    );
  }

  const feed = activityFeed(incidents, outgoing.data?.items, outgoing.data?.tip);
  return (
    <>
      <h1>Activity</h1>
      <p className="lead">Every rescue your Guardian made, with its signed report, and every transfer or approval from your account in the last ~45 minutes.</p>
      {incidentsError && !incidents.length ? <div className="banner warn">Your Guardian's reports could not be loaded: {incidentsError}</div> : null}
      {feed.length ? (
        <ul className="act-list">
          {feed.map((f) =>
            f.kind === "incident" ? (
              <li key={f.incident.id}>
                <a href={`#/activity/${f.incident.id}`} className="act-row">
                  <span className={`tag ${incidentTag(f.incident) === "Rescue" ? "orange" : ""}`}>{incidentTag(f.incident)}</span>
                  <span className="act-main">
                    <b>{describeIncident(f.incident, cfg).headline}</b>
                    <small>
                      {ago(f.incident.detectedAt)} · {verdictFor(f.incident) === undefined ? "checking the report" : verdictFor(f.incident)!.ok ? "report verified" : "report did not verify"}
                    </small>
                  </span>
                  <span className="act-go">›</span>
                </a>
              </li>
            ) : (
              <li key={`${f.item.hash}-${f.item.logIndex}`}>
                <div className="act-row">
                  <span className="tag">{f.item.kind === "approval" ? "Approval" : "Sent"}</span>
                  <span className="act-main">
                    <b>
                      {f.item.kind === "approval" ? "Approved" : "Sent"} {fmtAmount(f.item.amount)} {tokenSymbol(cfg, f.item.token)} {f.item.kind === "approval" ? "for" : "to"}{" "}
                      {cfg ? labelCounterparty(f.item.to, cfg, policy.data).label : f.item.to}
                    </b>
                    <small>
                      block {f.item.block.toString()} · <TxHash hash={f.item.hash} />
                    </small>
                  </span>
                </div>
              </li>
            ),
          )}
        </ul>
      ) : (
        <p className="dash-empty">{outgoing.loading && !outgoing.data ? "Reading your activity…" : "Nothing yet. Run the protection test from your dashboard to see a rescue here."}</p>
      )}
    </>
  );
}
