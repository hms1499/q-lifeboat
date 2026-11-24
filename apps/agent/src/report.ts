import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { bigintReplacer } from "@qday/core/chain";
import { canonicalJson, signIncident, type GuardianCoSigner, type Incident, type IncidentBody, type OutboundTx, type RescueRecord } from "@qday/core";

/**
 * What happened, before the summary is written. `alert`: decide() raised an alert-only incident, so no rescue was
 * attempted (it only shapes the summary; the incident body does not carry it).
 */
export type Facts = { trigger: OutboundTx; reason: string; rescues: RescueRecord[]; detectedAt?: string; alert?: boolean };

export type LlmReply = { text: string; stopReason: string | null };
/** One LLM call. It may only produce text; nothing it returns is ever acted on. */
export type Llm = (system: string, user: string) => Promise<LlmReply>;

const SYSTEM =
  "Write a 2-3 sentence plain-English incident summary from the JSON the user sends. " +
  "You do not decide actions; the rescue has already happened or not (an alert-only incident attempts none). " +
  "State only what the JSON says.";

/** Deterministic fallback summary. */
export function templateSummary(f: Facts): string {
  const t = f.trigger;
  const event =
    t.kind === "approval"
      ? `Approval of ${t.amount} (token ${t.token}) to spender ${t.to} in tx ${t.hash}`
      : `Outbound transfer of ${t.amount} (token ${t.token}) to ${t.to} in tx ${t.hash}`;
  if (f.alert) {
    return `${event} raised an alert: ${f.reason}. No rescue was attempted: the rules flag this event for the owner, but moving funds would not undo it.`;
  }
  const ok = f.rescues.filter((r) => r.success).length;
  const outcome =
    f.rescues.length === 0
      ? "No tokens needed rescuing."
      : `Rescued ${ok} of ${f.rescues.length} token balance(s) into the vault.`;
  return `${event} triggered a rescue: ${f.reason}. ${outcome}`;
}

/**
 * The only data the LLM sees: an explicit pick of the facts. Whatever else a caller put on the object (the agent's
 * secret key, an API key) is never sent.
 */
export function llmFacts(f: Facts): Facts {
  return { trigger: f.trigger, reason: f.reason, rescues: f.rescues, detectedAt: f.detectedAt, alert: f.alert };
}

/**
 * Summary written by the LLM when available, the template otherwise (no LLM, error, refusal or empty
 * text). The cause of a fallback goes to `log`; the API key is never part of it.
 */
export async function summarize(
  f: Facts,
  llm?: Llm,
  log: (line: string) => void = () => {},
): Promise<{ text: string; source: "llm" | "template" }> {
  const fallback = () => ({ text: templateSummary(f), source: "template" as const });
  if (!llm) return fallback();
  try {
    const r = await llm(SYSTEM, canonicalJson(llmFacts(f)));
    const text = r.text.trim();
    if (r.stopReason === "refusal") {
      log("summary: LLM refusal, using template");
      return fallback();
    }
    if (!text) {
      log("summary: LLM returned empty text, using template");
      return fallback();
    }
    return { text, source: "llm" };
  } catch (e) {
    const what = e instanceof Error ? `${e.name}: ${e.message}` : "unknown error";
    log(`summary: LLM call failed (${what}), using template`);
    return fallback();
  }
}

/** The Claude-backed LLM call. */
export function anthropicLlm(apiKey: string): Llm {
  const client = new Anthropic({ apiKey });
  return async (system, user) => {
    const res = await client.messages.create(
      {
        model: "claude-haiku-5-5",
        max_tokens: 2048,
        output_config: { effort: "low" },
        system,
        messages: [{ role: "user", content: user }],
      },
      { timeout: 15_000, maxRetries: 1 },
    );
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    return { text, stopReason: res.stop_reason };
  };
}

export function buildIncident(i: Facts & { summary: string; summarySource: "llm" | "template" }): IncidentBody {
  return {
    id: randomUUID(),
    detectedAt: i.detectedAt ?? new Date().toISOString(),
    trigger: i.trigger,
    reason: i.reason,
    rescues: i.rescues,
    summary: i.summary,
    summarySource: i.summarySource,
  };
}

/** Append one JSON line (bigint as decimal string). Creates the directory if needed. */
export function appendIncident(file: string, incident: Incident): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(incident, bigintReplacer) + "\n");
}

/** Read stored incidents. Bigint fields come back as decimal strings; the signature still verifies. */
export function readIncidents(file: string, log: (line: string) => void = () => {}): Incident[] {
  if (!existsSync(file)) return [];
  const out: Incident[] = [];
  for (const [n, line] of readFileSync(file, "utf8").split("\n").entries()) {
    if (!line) continue;
    try {
      out.push(JSON.parse(line) as Incident);
    } catch {
      log(`incidents: skipping malformed line ${n + 1} in ${file}`); // e.g. a write cut short by a crash
    }
  }
  return out;
}

/** Summarize, build, sign and persist an incident. */
export async function signAndRecord(
  input: Facts & { sk: Uint8Array; llm?: Llm; log?: (line: string) => void; coSigner?: GuardianCoSigner },
  file: string,
): Promise<Incident> {
  const { sk, llm, log, coSigner, ...facts } = input; // secrets and helpers never travel with the facts
  const { text, source } = await summarize(facts, llm, log);
  // A co-signer failure is logged and the report still goes out (it runs after the rescue, Review Focus 8).
  const cs = coSigner && log && !coSigner.onError ? { ...coSigner, onError: (e: unknown) => log(`report co-sign failed: ${e instanceof Error ? e.message : String(e)}`) } : coSigner;
  const signed = signIncident(buildIncident({ ...facts, summary: text, summarySource: source }), sk, cs);
  appendIncident(file, signed);
  return signed;
}
