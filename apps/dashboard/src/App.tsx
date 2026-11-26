import { useEffect, useState } from "react";
import { APP_NAME } from "./brand";
import { LifeboatMark, NavIcon, ScreenBoundary } from "./components/ui";
import { agentBase, fetchHealth, HOSTED_BUILD } from "./lib/agent";
import { appSession } from "./lib/appWallet";
import { navGroups, navMode, type NavMode } from "./lib/nav";
import { guardianStatus } from "./lib/status";
import { loadSeed } from "./lib/keystore";
import { explorerAddress } from "./lib/chain";
import { shortAddr } from "./lib/format";
import { useHashRoute, usePoll } from "./lib/hooks";
import { Drill } from "./screens/Drill";
import { Incidents } from "./screens/Incidents";
import { Overview } from "./screens/Overview";
import { Protect } from "./screens/Protect";
import { Recover } from "./screens/Recover";
import { Rules } from "./screens/Rules";
import { Start } from "./screens/Start";
import { Attack } from "./screens/Attack";
import { Home } from "./screens/Home";
import { appStage, ownerStageFor, resolveRoute, type Stage } from "./lib/appState";
import { hosted } from "./lib/appWallet";
import { browserStorage } from "./lib/storage";
import type { OwnerStage } from "@qday/core";
import type { Hex } from "viem";
import { useApp } from "./state";
import { KeysProvider } from "./components/KeysProvider";
import { AppShell } from "./components/AppShell";
import { FocusShell } from "./components/FocusShell";

/** Which product this browser sees: a visitor, the hosted product, or the builder's local agent. */
function useNavMode(hasSeed: boolean | undefined): NavMode {
  const { cfg } = useApp().config;
  return navMode({ hasSeed, localAgent: !!cfg && agentBase().owner === null, hostedBuild: HOSTED_BUILD });
}

/** The Guardian's state for the shell: from /config reachability and /health (polled only while the agent answers). */
function useGuardianStatus(mode: NavMode): { dot: string; text: string } {
  const { config } = useApp();
  const { cfg, check, agentOnline } = config;
  const health = usePoll(fetchHealth, 10_000, agentOnline ? "shell-health" : null);
  return guardianStatus({ mode, hasCfg: !!cfg, checkFailed: !!check && !check.ok, agentOnline, healthOk: health.data?.ok });
}

/** Whether the in-app wallet is unlocked in this tab (follows every lock and unlock). */
function useUnlocked(): boolean {
  const [unlocked, setUnlocked] = useState(() => !!appSession.classical());
  useEffect(() => appSession.onChange(() => setUnlocked(!!appSession.classical())), []);
  return unlocked;
}

function Sidebar({ active, hasSeed, mode }: { active: string; hasSeed: boolean | undefined; mode: NavMode }) {
  const { config, wallet } = useApp();
  const { cfg, source, agentOnline } = config;
  const groups = navGroups(mode);
  const status = useGuardianStatus(mode);
  const unlocked = useUnlocked();
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
          {groups.map((g) => (
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
          {hasSeed && !unlocked ? <div>Wallet locked</div> : null}
          {hasSeed && unlocked ? (
            <button
              type="button"
              className="btn small"
              title="Forget the unlocked keys in this tab (the encrypted wallet stays in this browser)"
              onClick={() => {
                appSession.lock();
                window.location.reload();
              }}
            >
              Lock wallet
            </button>
          ) : null}
          <div>diana testnet</div>
        </div>
      </div>
    </header>
  );
}

function Banners({ mode }: { mode: NavMode }) {
  const { config } = useApp();
  const { cfg, check, agentOnline, source } = config;
  if (mode !== "local") {
    // The public product: never point a browser user at the repo or the agent's API.
    if (!cfg) {
      return (
        <div className="banner warn" role="status">
          <strong>Your Guardian is not set up yet.</strong> Finish the steps on <a href="#/start">Get protected</a>.
        </div>
      );
    }
    if (!agentOnline) {
      return (
        <div className="banner warn" role="status">
          <strong>Your Guardian is not answering right now.</strong> Balances below are read live from the chain; incidents and health
          come back when it does.
        </div>
      );
    }
  }
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

/** The in-app wallet's address in this browser: null without one, undefined while checking. Read again whenever the
 * session changes, so a wallet created in Setup is seen at once. */
function useStoredOwner(): Hex | null | undefined {
  const [owner, setOwner] = useState<Hex | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const read = () =>
      void loadSeed()
        .then((s) => live && setOwner(s ? (s.evm as Hex) : null))
        .catch(() => live && setOwner(null));
    read();
    const off = appSession.onChange(read);
    return () => {
      live = false;
      off();
    };
  }, []);
  return owner;
}

const stageKey = (owner: string) => `qlifeboat.stage.${owner.toLowerCase()}`;

/** The browser's stage (visitor, onboarding, protected, local); null while loading. */
function useStage(owner: Hex | null | undefined): Stage | null {
  const { cfg } = useApp().config;
  const st = usePoll(() => hosted.owner(owner!), 15_000, owner ?? null);
  const kv = browserStorage();
  const cached = owner ? ((kv?.getItem(stageKey(owner)) as OwnerStage | "none" | null) ?? null) : null;
  const live = st.data?.stage;
  useEffect(() => {
    if (owner && live) kv?.setItem(stageKey(owner), live);
  }, [owner, live, kv]);
  return appStage({
    hasSeed: owner === undefined ? undefined : !!owner,
    ownerStage: owner ? ownerStageFor(live, st.error, cached) : undefined,
    localAgent: !!cfg && agentBase().owner === null,
    hostedBuild: HOSTED_BUILD,
  });
}

/** What a visitor sees on a screen that needs a wallet. */
function NoWallet() {
  return (
    <section className="card" style={{ maxWidth: 640 }}>
      <h1 style={{ fontSize: 28 }}>No wallet in this browser yet</h1>
      <p className="lead" style={{ marginTop: 8 }}>
        This page shows your Guardian, your vault and what it rescued. Set up protection first: it takes a few minutes and runs on the diana
        testnet with free test tokens.
      </p>
      <div className="actions">
        <a className="btn primary" href="#/start">
          Get protected
        </a>
      </div>
    </section>
  );
}

export function App() {
  const owner = useStoredOwner();
  return (
    <KeysProvider owner={owner ?? null}>
      <Routes owner={owner} />
    </KeysProvider>
  );
}

function Routes({ owner }: { owner: Hex | null | undefined }) {
  const [screen = "", id] = useHashRoute();
  const hasSeed = owner === undefined ? undefined : !!owner;
  const mode = useNavMode(hasSeed);
  const stage = useStage(owner);
  const active = resolveRoute(screen, stage);
  // The homepage is full width: no sidebar, no banners.
  if (active === "home") return <Home />;
  // Setup runs in focus mode: no app navigation.
  if (active === "setup") {
    return (
      <FocusShell>
        <ScreenBoundary resetKey="setup">
          <Start />
        </ScreenBoundary>
      </FocusShell>
    );
  }
  if (stage === "protected" && owner && active) {
    return (
      <AppShell active={active} owner={owner}>
        <Banners mode={mode} />
        <ScreenBoundary resetKey={`${active}/${id ?? ""}`}>
          {active === "activity" ? <Incidents selected={id} /> : active === "vault" ? <Recover /> : active === "settings" ? <Rules /> : <Overview />}
        </ScreenBoundary>
      </AppShell>
    );
  }
  // Local mode (the builder's agent) keeps the legacy shell and screens.
  const legacy = active === "dashboard" ? "overview" : active === "activity" ? "incidents" : active === "vault" ? "recover" : active === "settings" ? "rules" : active;
  return (
    <div className="shell">
      <Sidebar active={legacy ?? ""} hasSeed={hasSeed} mode={mode} />
      <div className="content">
        <main>
          {legacy === null ? null : <Banners mode={mode} />}
          <ScreenBoundary resetKey={`${active}/${id ?? ""}`}>
            {legacy === null ? null : legacy === "incidents" ? (
              <Incidents selected={id} />
            ) : legacy === "recover" ? (
              <Recover />
            ) : legacy === "rules" ? (
              <Rules />
            ) : legacy === "protect" ? (
              <Protect />
            ) : legacy === "drill" ? (
              <Drill />
            ) : (
              <Overview />
            )}
          </ScreenBoundary>
        </main>
      </div>
    </div>
  );
}
