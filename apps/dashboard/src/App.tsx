import { APP_NAME } from "./brand";
import { ScreenBoundary, ShieldIcon } from "./components/ui";
import { explorerAddress } from "./lib/chain";
import { shortAddr } from "./lib/format";
import { useHashRoute } from "./lib/hooks";
import { Incidents } from "./screens/Incidents";
import { Overview } from "./screens/Overview";
import { Recover } from "./screens/Recover";
import { useApp } from "./state";

const NAV = [
  { id: "overview", label: "Overview", href: "#/" },
  { id: "incidents", label: "Incidents", href: "#/incidents" },
  { id: "recover", label: "Recover", href: "#/recover" },
] as const;
/** Task 6E-6G screens: shown, not yet linked. */
const SOON = ["Rules", "Fire drill", "Protect"];

function TopBar({ active }: { active: string }) {
  const { config, wallet } = useApp();
  const { cfg, check, agentOnline, source } = config;
  const ownerDot = !cfg ? "off" : check && !check.ok ? "bad" : agentOnline ? "" : "off";
  const walletDiffers = !!wallet && !!cfg && wallet.account.toLowerCase() !== cfg.owner.toLowerCase();
  return (
    <header className="topbar">
      <a href="#/" className="brand">
        <ShieldIcon />
        <span>{APP_NAME}</span>
      </a>
      <nav className="nav" aria-label="Main">
        {NAV.map((n) => (
          <a key={n.id} href={n.href} aria-current={n.id === active ? "page" : undefined}>
            {n.label}
          </a>
        ))}
        {SOON.map((label) => (
          <span key={label} aria-disabled="true" title="Coming in a later task">
            {label} <span className="soon">soon</span>
          </span>
        ))}
      </nav>
      <div className="pills">
        <span className="pill">diana testnet</span>
        {source === "cache" || (!agentOnline && cfg) ? <span className="pill warn">agent offline</span> : null}
        {cfg ? (
          <a className="pill outline" href={explorerAddress(cfg.owner)} target="_blank" rel="noreferrer noopener" title={`Watched owner ${cfg.owner}`}>
            <span className={`dot ${ownerDot}`} aria-hidden="true" />
            {shortAddr(cfg.owner)}
          </a>
        ) : null}
        {walletDiffers ? (
          <span className="pill warn" title={`The connected wallet ${wallet!.account} is not the watched owner ${cfg!.owner}`}>
            wallet {shortAddr(wallet!.account)} ≠ owner
          </span>
        ) : null}
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
  const active = screen === "incidents" ? "incidents" : screen === "recover" ? "recover" : "overview";
  return (
    <>
      <TopBar active={active} />
      <main>
        <Banners />
        <ScreenBoundary resetKey={`${active}/${id ?? ""}`}>
          {active === "incidents" ? <Incidents selected={id} /> : active === "recover" ? <Recover /> : <Overview />}
        </ScreenBoundary>
      </main>
    </>
  );
}
