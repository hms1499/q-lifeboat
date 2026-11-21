import { vaultAbi, type Incident } from "@qday/core";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { EIP1193Provider, Hex } from "viem";
import { fetchConfig, fetchIncidents, subscribeIncidents } from "./lib/agent";
import { publicClient, readAuthenticators, readReceipt } from "./lib/chain";
import { checkConfigOnChain, loadCachedConfig, saveCachedConfig, type AgentConfig } from "./lib/config";
import { errorText } from "./lib/format";
import { usePoll } from "./lib/hooks";
import { mergeIncident, sortIncidents } from "./lib/incidents";
import { verifyReport, type VerifyResult } from "./lib/verify";

const CONFIG_POLL_MS = 10_000;
const REVERIFY_MS = 60_000;

const storage = (() => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
})();

export type ConfigState = {
  cfg: AgentConfig | null;
  /** "cache": the agent is unreachable and this is the last good config. */
  source: "agent" | "cache" | null;
  agentOnline: boolean;
  /** vault.owner() / vault.guardian() against the config; null until read. */
  check: { ok: boolean; detail: string } | null;
  checkError: string | null;
};

export type WalletState = { provider: EIP1193Provider; name: string; account: Hex } | null;

type AppData = {
  config: ConfigState;
  incidents: Incident[];
  incidentsError: string | null;
  verifications: Record<string, VerifyResult | undefined>;
  wallet: WalletState;
  setWallet: (w: WalletState) => void;
};

const Ctx = createContext<AppData | null>(null);

export function useApp(): AppData {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside AppProvider");
  return v;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [cfg, setCfg] = useState<AgentConfig | null>(() => loadCachedConfig(storage));
  const [source, setSource] = useState<ConfigState["source"]>(() => (cfg ? "cache" : null));
  const [agentOnline, setAgentOnline] = useState(false);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [incidentsError, setIncidentsError] = useState<string | null>(null);
  const [verifications, setVerifications] = useState<Record<string, VerifyResult | undefined>>({});
  const [wallet, setWallet] = useState<WalletState>(null);

  const refreshConfig = useCallback(async () => {
    try {
      const next = await fetchConfig();
      setAgentOnline(true);
      setSource("agent");
      setCfg((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      saveCachedConfig(storage, next);
    } catch {
      setAgentOnline(false);
      setSource((s) => (s === "agent" || s === "cache" ? "cache" : null));
    }
  }, []);

  const refreshIncidents = useCallback(async () => {
    try {
      setIncidents(sortIncidents(await fetchIncidents()));
      setIncidentsError(null);
    } catch (e) {
      setIncidentsError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void refreshConfig();
    void refreshIncidents();
    const t = setInterval(() => void refreshConfig(), CONFIG_POLL_MS);
    // The agent restarts with a fresh owner on every demo run: each SSE (re)connect refetches config and incidents.
    const stop = subscribeIncidents(
      (i) => setIncidents((list) => mergeIncident(list, i)),
      () => {
        void refreshConfig();
        void refreshIncidents();
      },
      () => setAgentOnline(false),
    );
    return () => {
      clearInterval(t);
      stop();
    };
  }, [refreshConfig, refreshIncidents]);

  // The config is the agent's word only: hold it against the vault's immutable owner and guardian.
  const checkPoll = usePoll(
    async () => {
      if (!cfg) throw new Error("no config");
      const [owner, guardian] = await Promise.all([
        publicClient.readContract({ address: cfg.vault, abi: vaultAbi, functionName: "owner" }),
        publicClient.readContract({ address: cfg.vault, abi: vaultAbi, functionName: "guardian" }),
      ]);
      return checkConfigOnChain(cfg, { owner, guardian });
    },
    15_000,
    cfg ? `${cfg.owner}/${cfg.vault}/${cfg.guardian}` : null,
  );
  const check = checkPoll.data ?? null;

  // Verify every report against the configured owner. Re-run on new incidents, a config change and once a minute
  // (a key may be revoked meanwhile).
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), REVERIFY_MS);
    return () => clearInterval(t);
  }, []);
  const verifyKey = cfg && check ? `${cfg.owner}/${cfg.vault}/${check.ok}/${tick}` : null;
  const lastKey = useRef<string | null>(null);
  useEffect(() => {
    if (!cfg || !check || !verifyKey) return;
    const fresh = lastKey.current !== verifyKey;
    const todo = incidents.filter((i) => fresh || !verifications[i.id]);
    if (!todo.length) return;
    lastKey.current = verifyKey;
    let live = true;
    let done = false;
    void (async () => {
      let authenticators: Awaited<ReturnType<typeof readAuthenticators>>;
      try {
        authenticators = await readAuthenticators(cfg.owner);
      } catch (e) {
        // Unknown is never read as "linked": every report fails the key checks until the read works.
        authenticators = [];
        console.warn(`authenticators read failed: ${errorText(e)}`);
      }
      const ctx = { authenticators, nowUnix: Math.floor(Date.now() / 1000), vault: cfg.vault, readReceipt, config: check };
      const results = await Promise.all(todo.map(async (i) => [i.id, await verifyReport(i, ctx)] as const));
      done = true;
      if (live) setVerifications((v) => ({ ...v, ...Object.fromEntries(results) }));
    })();
    return () => {
      live = false;
      // A batch cut short by a newer render is redone in full, so no report keeps a result from an older config.
      if (!done && lastKey.current === verifyKey) lastKey.current = null;
    };
    // `verifications` is read only to skip ids already done.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidents, verifyKey]);

  const config: ConfigState = { cfg, source, agentOnline, check, checkError: checkPoll.error };
  const value = useMemo(
    () => ({ config, incidents, incidentsError, verifications, wallet, setWallet }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cfg, source, agentOnline, check, checkPoll.error, incidents, incidentsError, verifications, wallet],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
