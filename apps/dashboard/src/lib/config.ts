import type { Hex } from "viem";

/** The agent's GET /config. Taken as a hint only: `checkConfigOnChain` holds it against the vault. */
export type AgentConfig = {
  owner: Hex;
  vault: Hex;
  guardian: Hex;
  tokens: { fUSD: Hex; fETH: Hex; fBTC: Hex };
  evmChainId: 9800;
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function exact(o: Record<string, unknown>, keys: string[], where: string) {
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) throw new Error(`${where}: unexpected key(s) ${extra.join(", ")}`);
}

function addr(o: Record<string, unknown>, k: string, where: string): Hex {
  const v = o[k];
  if (typeof v !== "string" || !ADDRESS_RE.test(v)) throw new Error(`${where}.${k} must be a 0x address`);
  return v as Hex;
}

/** Validate the /config body strictly: 0x addresses only, diana's EVM chain id, nothing else. */
export function parseAgentConfig(json: unknown): AgentConfig {
  if (!isObject(json)) throw new Error("config must be an object");
  exact(json, ["owner", "vault", "guardian", "tokens", "evmChainId"], "config");
  if (!isObject(json.tokens)) throw new Error("config.tokens must be an object");
  exact(json.tokens, ["fUSD", "fETH", "fBTC"], "config.tokens");
  if (json.evmChainId !== 9800) throw new Error("config.evmChainId must be 9800 (diana)");
  return {
    owner: addr(json, "owner", "config"),
    vault: addr(json, "vault", "config"),
    guardian: addr(json, "guardian", "config"),
    tokens: { fUSD: addr(json.tokens, "fUSD", "config.tokens"), fETH: addr(json.tokens, "fETH", "config.tokens"), fBTC: addr(json.tokens, "fBTC", "config.tokens") },
    evmChainId: 9800,
  };
}

/** The config must name the vault's immutable owner and guardian, as the chain reports them. */
export function checkConfigOnChain(cfg: AgentConfig, onChain: { owner: string; guardian: string }): { ok: boolean; detail: string } {
  const bad: string[] = [];
  if (onChain.owner.toLowerCase() !== cfg.owner.toLowerCase()) bad.push(`vault.owner() is ${onChain.owner}, config says ${cfg.owner}`);
  if (onChain.guardian.toLowerCase() !== cfg.guardian.toLowerCase()) bad.push(`vault.guardian() is ${onChain.guardian}, config says ${cfg.guardian}`);
  return bad.length ? { ok: false, detail: bad.join("; ") } : { ok: true, detail: `vault ${cfg.vault} names this owner and guardian on chain` };
}

const CACHE_KEY = "qday.dashboard.config.v1";
type KV = { getItem(k: string): string | null; setItem(k: string, v: string): void };

/** The last good config, so Overview still renders while the agent is down. */
export function loadCachedConfig(storage: KV | undefined): AgentConfig | null {
  try {
    const raw = storage?.getItem(CACHE_KEY);
    return raw ? parseAgentConfig(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveCachedConfig(storage: KV | undefined, cfg: AgentConfig): void {
  try {
    storage?.setItem(CACHE_KEY, JSON.stringify(cfg));
  } catch {
    // private mode / quota: the cache is a convenience only
  }
}
