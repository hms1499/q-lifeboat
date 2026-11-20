import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { appendIncident } from "../src/report";
import { startServer, type Server } from "../src/server";

let srv: Server | undefined;
afterEach(async () => { await srv?.close(); srv = undefined; });

const inc = { id: "i1", detectedAt: "t", trigger: { amount: 1n }, reason: "r", rescues: [], summary: "s", agentPubkey: "", sig: "" } as never;

describe("server", () => {
  it("GET /incidents returns the stored incidents with CORS", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "qday-")), "i.jsonl");
    appendIncident(file, inc);
    srv = await startServer({ file, port: 0 });
    const r = await fetch(`http://127.0.0.1:${srv.port}/incidents`);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await r.json()) as { id: string; trigger: { amount: string } }[];
    expect(body.map((i) => i.id)).toEqual(["i1"]);
    expect(body[0].trigger.amount).toBe("1");
  });

  it("GET /events streams a published incident as an SSE event", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "qday-")), "i.jsonl");
    srv = await startServer({ file, port: 0 });
    const ac = new AbortController();
    const r = await fetch(`http://127.0.0.1:${srv.port}/events`, { signal: ac.signal });
    expect(r.headers.get("content-type")).toBe("text/event-stream");
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    const reader = r.body!.getReader();
    await reader.read(); // initial comment flushes the headers
    srv.publish(inc);
    let text = "";
    while (!text.includes("event: incident")) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain('"id":"i1"');
    ac.abort();
  });

  it("survives a truncated line in the incidents file", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "qday-")), "i.jsonl");
    appendIncident(file, inc);
    writeFileSync(file, '{"id":"ok"}\n{"id":"trunc');
    srv = await startServer({ file, port: 0 });
    const r = await fetch(`http://127.0.0.1:${srv.port}/incidents`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as { id: string }[]).map((i) => i.id)).toEqual(["ok"]);
  });

  it("404s other paths and answers OPTIONS", async () => {
    srv = await startServer({ file: join(tmpdir(), "nope.jsonl"), port: 0 });
    expect((await fetch(`http://127.0.0.1:${srv.port}/x`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${srv.port}/incidents`, { method: "OPTIONS" })).status).toBe(204);
    expect((await fetch(`http://127.0.0.1:${srv.port}/incidents`)).status).toBe(200); // missing file = []
  });
});
