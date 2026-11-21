import type { Incident } from "@qday/core";
import { parseAgentConfig, type AgentConfig } from "./config";
import { parseIncidentList } from "./incidents";

/** The agent API (loopback). Override with VITE_AGENT_URL in apps/dashboard/.env.local. */
export const AGENT_URL = ((import.meta.env.VITE_AGENT_URL as string | undefined) || "http://127.0.0.1:8787").replace(/\/+$/, "");

/** GET /health as JSON: bigints arrive as decimal strings. */
export type Health = {
  ok: boolean;
  startedAt: string;
  lastBlock: string | null;
  lastBlockAt: string | null;
  window: { live: boolean; remainingBlocks: string; remainingTxs: string; remainingValue: string } | null;
  gas: { guardian: string; balance: string | null; threshold: string; low: boolean };
  alerts: { telegram: boolean; webhook: boolean };
};

export type TrustedEntry = { label: string; address: string; kind: "wallet" | "app" };
export type Policy = { trusted: TrustedEntry[]; maxOutbound: string };

async function getJson(path: string, timeoutMs = 5000): Promise<unknown> {
  const r = await fetch(`${AGENT_URL}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
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

/** Live incidents (SSE). `onOpen` fires on every (re)connect: the caller refetches what it may have missed. */
export function subscribeIncidents(onIncident: (i: Incident) => void, onOpen: () => void, onDown: () => void): () => void {
  const es = new EventSource(`${AGENT_URL}/events`);
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
