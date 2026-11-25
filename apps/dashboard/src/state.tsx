import { vaultAbi, type Incident } from "@qday/core";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { EIP1193Provider, Hex } from "viem";
import { agentBase, NO_AGENT, fetchConfig, fetchIncidents, onAgentBaseChange, subscribeIncidents } from "./lib/agent";
import { publicClient, readAuthenticators, readReceipt, verifyGuardianSig } from "./lib/chain";
import { checkConfigOnChain, loadCachedConfig, saveCachedConfig, type AgentConfig } from "./lib/config";
import { errorText } from "./lib/format";
import { usePoll } from "./lib/hooks";
import { mergeIncident, sortIncidents } from "./lib/incidents";
import { verifyReport, type VerifyResult } from "./lib/verify";
import { bodyKey, configKey, needsVerification, shownVerification, type StoredVerification } from "./lib/verifyPolicy";

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
  /** The verdict for this exact report (id + sig) under the current config; undefined = pending (never a stale ✓). */
  verdictFor: (i: Incident) => VerifyResult | undefined;
  wallet: WalletState;
  setWallet: (w: WalletState) => void;
};

const Ctx = createContext<AppData | null>(null);

export function useApp(): AppData {
  const v = useContext(Ctx);
  if (!v) throw new Error("useApp outside AppProvider");
  return v;
}

/** The cached config, only when it is for the owner the current agent base serves (any owner in local mode). */
function cachedFor(owner: string | null): AgentConfig | null {
  if (agentBase().url === NO_AGENT) return null; // no Guardian here: never show a config cached for another one
  const c = loadCachedConfig(storage);
  return c && (owner === null || c.owner.toLowerCase() === owner) ? c : null;
}

export function AppProvider({ children }: { children: ReactNode }) {
  // Bumped when the agent base changes (the in-app wallet's hosted gateway): config, incidents and SSE start over.
  const [baseVersion, setBaseVersion] = useState(0);
  useEffect(
    () =>
      onAgentBaseChange((b) => {
        const c = cachedFor(b.owner);
        setCfg(c);
        setSource(c ? "cache" : null);
        setAgentOnline(false);
        setIncidents([]);
        setIncidentsError(null);
        setStore({});
        setBaseVersion((v) => v + 1);
      }),
    [],
  );
  const [cfg, setCfg] = useState<AgentConfig | null>(() => cachedFor(agentBase().owner));
  const [source, setSource] = useState<ConfigState["source"]>(() => (cfg ? "cache" : null));
  const [agentOnline, setAgentOnline] = useState(false);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [incidentsError, setIncidentsError] = useState<string | null>(null);
  const [store, setStore] = useState<Record<string, StoredVerification | undefined>>({});
  const [wallet, setWallet] = useState<WalletState>(null);

  const refreshConfig = useCallback(async () => {
    const b = agentBase();
    try {
      const expected = b.owner;
      const next = await fetchConfig();
      if (agentBase() !== b) return; // the base changed meanwhile: this answer is for another owner
      // The gateway serves one owner: a config for any other is refused, never shown as this account's.
      if (expected && next.owner.toLowerCase() !== expected) throw new Error(`the agent serves ${next.owner}, not ${expected}`);
      setAgentOnline(true);
      setSource("agent");
      setCfg((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      saveCachedConfig(storage, next);
    } catch {
      if (agentBase() !== b) return;
      setAgentOnline(false);
      setSource((s) => (s === "agent" || s === "cache" ? "cache" : null));
    }
  }, []);

  const refreshIncidents = useCallback(async () => {
    const b = agentBase();
    try {
      const list = await fetchIncidents();
      if (agentBase() !== b) return; // stale: another owner's base
      setIncidents(sortIncidents(list));
      setIncidentsError(null);
    } catch (e) {
      if (agentBase() === b) setIncidentsError(errorText(e));
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
  }, [refreshConfig, refreshIncidents, baseVersion]);

  // The config is the agent's word only: hold it against the vault's immutable owner and guardian. Each verdict is
  // tagged with the config it was read for, so a verdict for the previous config is never used for a new one.
  const cfgId = cfg ? `${cfg.owner}/${cfg.vault}/${cfg.guardian}`.toLowerCase() : null;
  const checkPoll = usePoll(
    async () => {
      if (!cfg) throw new Error("no config");
      const [owner, guardian] = await Promise.all([
        publicClient.readContract({ address: cfg.vault, abi: vaultAbi, functionName: "owner" }),
        publicClient.readContract({ address: cfg.vault, abi: vaultAbi, functionName: "guardian" }),
      ]);
      return { cfgId: `${cfg.owner}/${cfg.vault}/${cfg.guardian}`.toLowerCase(), ...checkConfigOnChain(cfg, { owner, guardian }) };
    },
    15_000,
    cfgId,
  );
  const check = checkPoll.data && checkPoll.data.cfgId === cfgId ? { ok: checkPoll.data.ok, detail: checkPoll.data.detail } : null;

  // Verify every report against the configured owner: a new report, a new body under a known id, a config change, and
  // once a minute (a key may be revoked meanwhile). Results are keyed by id but carry the body's sig and the config
  // key; verifyPolicy decides what may be shown, so nothing is shown as ✓ for another body or config.
  const [round, setRound] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setRound((n) => n + 1), REVERIFY_MS);
    return () => clearInterval(t);
  }, []);
  const key = configKey(cfg, check);
  const inFlight = useRef(new Set<string>());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!cfg || !check || key === null) return;
    const todo = incidents.filter((i) => needsVerification(i, store[i.id], key, round) && !inFlight.current.has(`${i.id}/${bodyKey(i)}/${key}/${round}`));
    if (!todo.length) return;
    const tags = todo.map((i) => `${i.id}/${bodyKey(i)}/${key}/${round}`);
    tags.forEach((t) => inFlight.current.add(t));
    const vault = cfg.vault;
    const owner = cfg.owner;
    const guardian = cfg.guardian;
    const cfgCheck = check;
    void (async () => {
      let authenticators: Awaited<ReturnType<typeof readAuthenticators>>;
      try {
        authenticators = await readAuthenticators(owner);
      } catch (e) {
        // Unknown is never read as "linked": every report fails the key checks until the read works.
        authenticators = [];
        console.warn(`authenticators read failed: ${errorText(e)}`);
      }
      const ctx = { authenticators, nowUnix: Math.floor(Date.now() / 1000), vault, readReceipt, config: cfgCheck, guardian, verifyGuardianSig };
      const results = await Promise.all(
        todo.map(async (i) => [i.id, { body: bodyKey(i), configKey: key, round, result: await verifyReport(i, ctx) }] as const),
      );
      tags.forEach((t) => inFlight.current.delete(t));
      // Stored whatever happened meanwhile: each entry names its body and config, and is shown only if both still match.
      if (mounted.current) {
        setStore((st) => {
          const next = { ...st };
          for (const [id, v] of results) if (!next[id] || next[id]!.round <= v.round) next[id] = v;
          return next;
        });
      }
    })();
    // `store` is read only to skip work already done.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidents, key, round]);

  const verdictFor = useCallback((i: Incident) => shownVerification(i, store[i.id], key), [store, key]);

  const config: ConfigState = { cfg, source, agentOnline, check, checkError: checkPoll.error };
  const value = useMemo(
    () => ({ config, incidents, incidentsError, verdictFor, wallet, setWallet }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cfg, source, agentOnline, key, check?.detail, checkPoll.error, incidents, incidentsError, verdictFor, wallet],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
