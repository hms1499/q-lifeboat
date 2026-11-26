import type { ReactNode } from "react";
import type { Hex } from "viem";
import { APP_NAME } from "../brand";
import { fetchHealth } from "../lib/agent";
import { hostedNav, type RouteId } from "../lib/appState";
import { explorerAddress } from "../lib/chain";
import { shortAddr } from "../lib/format";
import { usePoll } from "../lib/hooks";
import { appStatus } from "../lib/status";
import { unseenIncident } from "../lib/seen";
import { useSeenIncident } from "../hooks/useSeen";
import { useApp } from "../state";
import { useKeys } from "./KeysProvider";
import { LifeboatMark, NavIcon } from "./ui";

/** The protected owner's app: sidebar on desktop, top bar + bottom tabs on phones. */
export function AppShell({ active, owner, paused, children }: { active: RouteId; owner: Hex; paused: boolean; children: ReactNode }) {
  const { config, incidents } = useApp();
  const { cfg, check, agentOnline, agentChecked } = config;
  const { unlocked, lock } = useKeys();
  const [seen] = useSeenIncident(owner);
  const unseen = unseenIncident(incidents, seen);
  const health = usePoll(fetchHealth, 15_000, agentOnline ? "shell-health" : null);
  const status = appStatus({
    unseen: !!unseen,
    hasCfg: !!cfg,
    checkFailed: !!check && !check.ok,
    agentOnline,
    agentChecked,
    healthOk: agentOnline ? health.data?.ok : undefined,
    paused,
  });
  const nav = hostedNav();
  const dot = (id: string) => (id === "activity" && unseen ? <span className="nav-dot" aria-label="new incident" /> : null);
  return (
    <div className="shell app-shell">
      <header className="sidebar">
        <div className="sb-top">
          <a href="#/dashboard" className="brand">
            <LifeboatMark />
            <span>{APP_NAME}</span>
          </a>
          <span className={`dot sb-dot ${status.dot}`} title={status.text} aria-hidden="true" />
          {unlocked ? (
            <button type="button" className="app-lock-mini" onClick={lock}>
              Lock
            </button>
          ) : null}
        </div>
        <nav className="nav app-nav" aria-label="Main">
          <ul>
            {nav.map((n) => (
              <li key={n.id}>
                <a href={n.href} aria-current={n.id === active ? "page" : undefined}>
                  <NavIcon name={n.id} />
                  {n.label}
                  {dot(n.id)}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="sb-foot app-foot">
          <div className="sb-status" role="status">
            <span className={`dot ${status.dot}`} aria-hidden="true" />
            {status.text}
          </div>
          <a className="mono" href={explorerAddress(owner)} target="_blank" rel="noreferrer noopener" title={`Your account ${owner}`}>
            {shortAddr(owner)}
          </a>
          {unlocked ? (
            <div className="app-lockrow">
              <span>Unlocked</span>
              <button type="button" onClick={lock}>
                Lock
              </button>
            </div>
          ) : (
            <div>Locked · unlocks when you sign</div>
          )}
          <div>diana testnet · test tokens</div>
        </div>
      </header>
      <div className="content">
        <main>{children}</main>
      </div>
      <nav className="tabbar" aria-label="Main">
        {nav.map((n) => (
          <a key={n.id} href={n.href} aria-current={n.id === active ? "page" : undefined}>
            <NavIcon name={n.id} />
            <span>{n.label}</span>
            {dot(n.id)}
          </a>
        ))}
      </nav>
    </div>
  );
}
