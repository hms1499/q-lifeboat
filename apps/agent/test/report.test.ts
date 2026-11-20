import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyIncident, type OutboundTx } from "@qday/core";
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { appendIncident, buildIncident, readIncidents, signAndRecord, summarize, templateSummary, type Facts } from "../src/report";

const SK = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const trigger: OutboundTx = {
  hash: "0xabc0000000000000000000000000000000000000000000000000000000000001",
  block: 10n,
  token: "0x0000000000000000000000000000000000000000",
  to: "0x9999999999999999999999999999999999999999",
  amount: 5n,
};
const facts: Facts = {
  trigger,
  reason: "recipient not in allowlist",
  rescues: [{ token: "0x00000000000000000000000000000000000000a1", hash: "TX", amount: 7n, expected: 7n, success: true }],
};

describe("summarize", () => {
  it("uses the template when there is no LLM", async () => {
    expect(await summarize(facts)).toEqual({ text: templateSummary(facts), source: "template" });
  });

  it("test_summaryFallbackWhenLLMFails", async () => {
    const llm = vi.fn().mockRejectedValue(new Error("network down"));
    const log = vi.fn();
    expect(await summarize(facts, llm, log)).toEqual({ text: templateSummary(facts), source: "template" });
    expect(llm).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("network down"));
  });

  it("falls back on refusal and on empty text", async () => {
    const log = vi.fn();
    expect((await summarize(facts, async () => ({ text: "refused", stopReason: "refusal" }), log)).source).toBe("template");
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("refusal"));
    expect((await summarize(facts, async () => ({ text: "   ", stopReason: "end_turn" }), log)).text).toBe(templateSummary(facts));
    expect(log).toHaveBeenLastCalledWith(expect.stringContaining("empty"));
  });

  it("returns the trimmed LLM text on success and passes canonical facts, not secrets", async () => {
    const llm = vi.fn(async () => ({ text: "  Funds were rescued.  ", stopReason: "end_turn" }));
    expect(await summarize(facts, llm)).toEqual({ text: "Funds were rescued.", source: "llm" });
    const [system, user] = llm.mock.calls[0] as unknown as [string, string];
    expect(system).toMatch(/do not decide/i);
    expect(JSON.parse(user).reason).toBe(facts.reason);
  });

  it("template mentions the outcome counts", () => {
    const t = templateSummary({ ...facts, rescues: [...facts.rescues, { ...facts.rescues[0], success: false }] });
    expect(t).toMatch(/1 of 2/);
  });
});

describe("incident build, sign and store", () => {
  it("test_signedIncidentVerifies end to end", async () => {
    const inc = await signAndRecord({ ...facts, sk: SK }, join(mkdtempSync(join(tmpdir(), "qday-")), "i.jsonl"));
    expect(verifyIncident(inc)).toBe(true);
    expect(inc.summary).toBe(templateSummary(facts));
    expect(inc.summarySource).toBe("template");
  });

  it("round-trips through the jsonl file and still verifies", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "qday-")), "data", "i.jsonl");
    const inc = await signAndRecord({ ...facts, sk: SK }, file);
    await signAndRecord({ ...facts, reason: "second", sk: SK }, file);
    const back = readIncidents(file);
    expect(back).toHaveLength(2);
    // bigint fields come back as decimal strings; canonical JSON makes the signature still valid.
    expect(back[0].id).toBe(inc.id);
    expect(verifyIncident(back[0] as never)).toBe(true);
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(2);
  });

  it("readIncidents is empty for a missing file", () => {
    expect(readIncidents(join(tmpdir(), "qday-does-not-exist.jsonl"))).toEqual([]);
  });

  it("signs summarySource, so flipping it fails verification", async () => {
    const inc = await signAndRecord({ ...facts, sk: SK }, join(mkdtempSync(join(tmpdir(), "qday-")), "i.jsonl"));
    expect(verifyIncident({ ...inc, summarySource: "llm" })).toBe(false);
  });

  it("keeps the detectedAt it is given (time the trigger was seen)", async () => {
    const inc = await signAndRecord(
      { ...facts, detectedAt: "2026-01-01T00:00:00.000Z", sk: SK },
      join(mkdtempSync(join(tmpdir(), "qday-")), "i.jsonl"),
    );
    expect(inc.detectedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("readIncidents skips a truncated line and logs it", () => {
    const file = join(mkdtempSync(join(tmpdir(), "qday-")), "i.jsonl");
    writeFileSync(file, '{"id":"ok"}\n{"id":"trunc');
    const log = vi.fn();
    expect(readIncidents(file, log).map((i) => i.id)).toEqual(["ok"]);
    expect(log).toHaveBeenCalledOnce();
  });

  it("buildIncident gives a unique id and ISO time", () => {
    const a = buildIncident({ ...facts, summary: "s", summarySource: "template" });
    const b = buildIncident({ ...facts, summary: "s", summarySource: "template" });
    expect(a.id).not.toBe(b.id);
    expect(new Date(a.detectedAt).toISOString()).toBe(a.detectedAt);
  });

  it("appendIncident writes one line", () => {
    const file = join(mkdtempSync(join(tmpdir(), "qday-")), "x.jsonl");
    appendIncident(file, { ...buildIncident({ ...facts, summary: "s", summarySource: "template" }), agentPubkey: "", sig: "" });
    expect(readFileSync(file, "utf8").endsWith("\n")).toBe(true);
  });
});
