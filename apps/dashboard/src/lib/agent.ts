import type { Incident } from "@qday/core";
import { parseAgentConfig, type AgentConfig } from "./config";
import { parseIncidentList } from "./incidents";

/** The local agent API (loopback). Override with VITE_AGENT_URL in apps/dashboard/.env.local. */
export const AGENT_URL = ((import.meta.env.VITE_AGENT_URL as string | undefined) || "http://127.0.0.1:8787").replace(/\/+$/, "");

/**
 * Where agent reads go: the local agent (local mode), or the hosted gateway `/api/o/<owner>` for the in-app wallet's
 * owner. `owner` is the account that base serves (null = whatever the local agent says), so a config cached for
 * another owner is never shown as this one's.
 */
export type AgentBase = { url: string; owner: string | null };
let base: AgentBase = { url: AGENT_URL, owner: null };
const listeners = new Set<(b: AgentBase) => void>();

export const agentBase = (): AgentBase => base;

export function setAgentBase(url: string, owner: string | null): void {
  const next = { url: url.replace(/\/+$/, ""), owner: owner ? owner.toLowerCase() : null };
  if (next.url === base.url && next.owner === base.owner) return;
  base = next;
  for (const l of [...listeners]) l(base);
}

export function resetAgentBase(): void {
  setAgentBase(AGENT_URL, null);
}

/** Called on every change of base; returns the unsubscribe. */
export function onAgentBaseChange(l: (b: AgentBase) => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}

/** The hosted gateway base for `owner` on this origin. */
export const hostedAgentUrl = (owner: string) => `${window.location.origin}/api/o/${owner.toLowerCase()}`;

/** GET /health as JSON: bigints arrive as decimal strings. */
export type Health = {
  ok: boolean;
  startedAt: string;
  lastBlock: string | null;
  lastBlockAt: string | null;
  window: { live: boolean; remainingBlocks: string; remainingTxs: string; remainingValue: string } | null;
  gas: { guardian: string; balance: string | null; threshold: string; low: boolean };
  alerts: { telegram: boolean; webhook: boolean };
  /** False for an on-demand (hosted) Guardian while the owner's window is closed; absent from older agents. */
  windowRequired?: boolean;
};

export type TrustedEntry = { label: string; address: string; kind: "wallet" | "app" };
export type Policy = { trusted: TrustedEntry[]; maxOutbound: string };

async function getJson(path: string, timeoutMs = 5000): Promise<unknown> {
  const r = await fetch(`${base.url}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`agent ${path}: HTTP ${r.status}`);
  return r.json();
}

export const fetchConfig = async (): Promise<AgentConfig> => parseAgentConfig(await getJson("/config"));
const warnDropped = (n: number) => console.warn(`dropped ${n} malformed incident(s) from the agent`);
export const fetchIncidents = async (): Promise<Incident[]> => parseIncidentList(await getJson("/incidents"), warnDropped);
export const fetchHealth = async (): Promise<Health> => (await getJson("/health")) as Health;

export async function fetchPolicy(): Promise<Policy> {
  const p = (await getJson("/policy")) as Policy;
  if (!p || !Array.isArray(p.trusted)) throw new Error("agent /policy: unexpected body");
  return p;
}

/**
 * PUT /policy with the whole edited policy (signed with `sign` for the hosted gateway). The agent is the authority (`parsePolicy`); its refusal, e.g. "origin not
 * allowed", is thrown verbatim. Returns the policy the agent saved.
 */
export async function putPolicy(policy: Policy, sign?: (p: Policy) => unknown, timeoutMs = 5000): Promise<Policy> {
  // The hosted gateway forwards a policy write only with the owner's ML-DSA signature over it (purpose "policy").
  const payload = sign ? sign(policy) : policy;
  const r = await fetch(`${base.url}/policy`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body: unknown = null;
  try {
    body = await r.json();
  } catch {
    // a non-JSON body: the status says enough
  }
  const o = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : null;
  if (!r.ok) throw new Error(typeof o?.error === "string" ? o.error : `HTTP ${r.status}`);
  if (!o || !Array.isArray(o.trusted) || typeof o.maxOutbound !== "string") throw new Error("agent PUT /policy: unexpected body");
  return o as unknown as Policy;
}

/** Live incidents (SSE). `onOpen` fires on every (re)connect: the caller refetches what it may have missed. */
export function subscribeIncidents(onIncident: (i: Incident) => void, onOpen: () => void, onDown: () => void): () => void {
  const es = new EventSource(`${base.url}/events`);
  es.addEventListener("open", onOpen);
  es.addEventListener("error", onDown);
  es.addEventListener("incident", (ev) => {
    try {
      const [i] = parseIncidentList([JSON.parse((ev as MessageEvent<string>).data)], warnDropped);
      if (i) onIncident(i);
    } catch {
      // a malformed frame is dropped; the next /incidents fetch has the truth
    }
  });
  return () => es.close();
}
