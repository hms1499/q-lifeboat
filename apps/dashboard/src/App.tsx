import { useEffect, useState } from "react";
import { APP_NAME } from "./brand";
import { LifeboatMark, NavIcon, ScreenBoundary } from "./components/ui";
import { fetchHealth } from "./lib/agent";
import { explorerAddress } from "./lib/chain";
import { shortAddr } from "./lib/format";
import { useHashRoute, usePoll } from "./lib/hooks";
import { Drill } from "./screens/Drill";
import { Incidents } from "./screens/Incidents";
import { Overview } from "./screens/Overview";
import { Protect } from "./screens/Protect";
import { Recover } from "./screens/Recover";
import { Rules } from "./screens/Rules";
import { useApp } from "./state";

const NAV_GROUPS = [
  {
    label: "Monitor",
    items: [
      { id: "overview", label: "Overview", href: "#/" },
      { id: "incidents", label: "Incidents", href: "#/incidents" },
      { id: "recover", label: "Recover", href: "#/recover" },
    ],
  },
  {
    label: "Set up",
    items: [
      { id: "protect", label: "Protect", href: "#/protect" },
      { id: "rules", label: "Rules", href: "#/rules" },
      { id: "drill", label: "Fire drill", href: "#/drill" },
    ],
  },
] as const;

/** The Guardian's state for the shell: from /config reachability and /health (polled only while the agent answers). */
function useGuardianStatus(): { dot: string; text: string } {
  const { config } = useApp();
  const { cfg, check, agentOnline } = config;
  const health = usePoll(fetchHealth, 10_000, agentOnline ? "shell-health" : null);
  if (cfg && check && !check.ok) return { dot: "bad", text: "Vault check failed" };
  if (!cfg || !agentOnline) return { dot: "off", text: "Guardian offline" };
  if (health.data && !health.data.ok) return { dot: "degraded", text: "Guardian degraded" };
  return { dot: "", text: "Guardian online" };
}

function Sidebar({ active }: { active: string }) {
  const { config, wallet } = useApp();
  const { cfg, source, agentOnline } = config;
  const status = useGuardianStatus();
  const [open, setOpen] = useState(false);
  const walletDiffers = !!wallet && !!cfg && wallet.account.toLowerCase() !== cfg.owner.toLowerCase();

  // The mobile menu closes after navigating, and on Escape.
  useEffect(() => setOpen(false), [active]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className={`sidebar${open ? " open" : ""}`}>
      <div className="sb-top">
        <a href="#/" className="brand">
          <LifeboatMark />
          <span>{APP_NAME}</span>
        </a>
        <span className={`dot sb-dot ${status.dot}`} title={status.text} aria-hidden="true" />
        <button type="button" className="menu-btn" aria-expanded={open} aria-controls="sb-panel" onClick={() => setOpen(!open)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
          </svg>
          Menu
        </button>
      </div>
      <div className="sb-panel" id="sb-panel">
        <nav className="nav" aria-label="Main">
          {NAV_GROUPS.map((g) => (
            <div key={g.label} className="nav-group">
              <span className="nav-label" id={`nav-${g.label.replace(/\s+/g, "-").toLowerCase()}`}>
                {g.label}
              </span>
              <ul aria-labelledby={`nav-${g.label.replace(/\s+/g, "-").toLowerCase()}`}>
                {g.items.map((n) => (
                  <li key={n.id}>
                    <a href={n.href} aria-current={n.id === active ? "page" : undefined}>
                      <NavIcon name={n.id} />
                      {n.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <div className="sb-foot">
          <div className="sb-status" role="status">
            <span className={`dot ${status.dot}`} aria-hidden="true" />
            {status.text}
          </div>
          {source === "cache" && !agentOnline ? <div>Showing the last saved config</div> : null}
          {cfg ? (
            <a className="mono" href={explorerAddress(cfg.owner)} target="_blank" rel="noreferrer noopener" title={`Watched owner ${cfg.owner}`}>
              <span className="sr-only">Watched account </span>
              {shortAddr(cfg.owner)}
            </a>
          ) : null}
          {walletDiffers ? (
            <div className="sb-warn" title={`The connected wallet ${wallet!.account} is not the watched owner ${cfg!.owner}`}>
              Connected wallet <span className="mono">{shortAddr(wallet!.account)}</span> is not the owner
            </div>
          ) : null}
          <div>diana testnet</div>
        </div>
      </div>
    </header>
  );
}

function Banners() {
  const { config } = useApp();
  const { cfg, check, agentOnline, source } = config;
  return (
    <>
      {cfg && check && !check.ok ? (
        <div className="banner bad" role="alert">
          <strong>Config does not match the vault on chain.</strong> {check.detail}. Every report is marked ✗ until the agent serves the vault's own
          owner and guardian.
        </div>
      ) : null}
      {!cfg ? (
        <div className="banner warn" role="status">
          <strong>Agent offline and no saved config.</strong> Start it from the repo root with <span className="mono">pnpm agent</span>; this page
          reads <span className="mono">GET /config</span> to find your vault.
        </div>
      ) : !agentOnline && source === "cache" ? (
        <div className="banner warn" role="status">
          <strong>Agent offline.</strong> Showing the last config it served. Chain reads below are live; incidents and health are not.
        </div>
      ) : null}
    </>
  );
}

export function App() {
  const [screen = "", id] = useHashRoute();
  const active = screen === "incidents" || screen === "recover" || screen === "rules" || screen === "protect" || screen === "drill" ? screen : "overview";
  return (
    <div className="shell">
      <Sidebar active={active} />
      <div className="content">
        <main>
          <Banners />
          <ScreenBoundary resetKey={`${active}/${id ?? ""}`}>
            {active === "incidents" ? <Incidents selected={id} /> : active === "recover" ? <Recover /> : active === "rules" ? <Rules /> : active === "protect" ? <Protect /> : active === "drill" ? <Drill /> : <Overview />}
          </ScreenBoundary>
        </main>
      </div>
    </div>
  );
}
