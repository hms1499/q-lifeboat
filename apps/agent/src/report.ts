import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { bigintReplacer, canonicalJson, signIncident, type Incident, type IncidentBody, type OutboundTx, type RescueRecord } from "@qday/core";

/** What happened, before the summary is written. */
export type Facts = { trigger: OutboundTx; reason: string; rescues: RescueRecord[] };

export type LlmReply = { text: string; stopReason: string | null };
/** One LLM call. It may only produce text; nothing it returns is ever acted on. */
export type Llm = (system: string, user: string) => Promise<LlmReply>;

const SYSTEM =
  "Write a 2-3 sentence plain-English incident summary from the JSON the user sends. " +
  "You do not decide actions; the rescue has already happened or not. State only what the JSON says.";

/** Deterministic fallback summary. */
export function templateSummary(f: Facts): string {
  const ok = f.rescues.filter((r) => r.success).length;
  const outcome =
    f.rescues.length === 0
      ? "No tokens needed rescuing."
      : `Rescued ${ok} of ${f.rescues.length} token balance(s) into the vault.`;
  return `Outbound transfer of ${f.trigger.amount} (token ${f.trigger.token}) to ${f.trigger.to} in tx ${f.trigger.hash} triggered a rescue: ${f.reason}. ${outcome}`;
}

/** Summary written by the LLM when available, the template otherwise (no LLM, error, refusal or empty text). */
export async function summarize(f: Facts, llm?: Llm): Promise<string> {
  if (!llm) return templateSummary(f);
  try {
    const r = await llm(SYSTEM, canonicalJson(f));
    const text = r.text.trim();
    if (r.stopReason === "refusal" || !text) return templateSummary(f);
    return text;
  } catch {
    return templateSummary(f);
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

export function buildIncident(i: Facts & { summary: string }): IncidentBody {
  return {
    id: randomUUID(),
    detectedAt: new Date().toISOString(),
    trigger: i.trigger,
    reason: i.reason,
    rescues: i.rescues,
    summary: i.summary,
  };
}

/** Append one JSON line (bigint as decimal string). Creates the directory if needed. */
export function appendIncident(file: string, incident: Incident): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(incident, bigintReplacer) + "\n");
}

/** Read stored incidents. Bigint fields come back as decimal strings; the signature still verifies. */
export function readIncidents(file: string): Incident[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Incident);
}

/** Summarize, build, sign and persist an incident. */
export async function signAndRecord(
  input: Facts & { sk: Uint8Array; llm?: Llm },
  file: string,
): Promise<Incident> {
  const summary = await summarize(input, input.llm);
  const signed = signIncident(buildIncident({ ...input, summary }), input.sk);
  appendIncident(file, signed);
  return signed;
}
