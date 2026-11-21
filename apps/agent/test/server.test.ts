import { mkdtempSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHealth } from "../src/health";
import { createPolicyStore } from "../src/policy";
import { appendIncident } from "../src/report";
import { checkPolicyWrite, startServer, type Server } from "../src/server";

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

// ---------------------------------------------------------------- Task 6C: /policy and /health

const A = "0x4444444444444444444444444444444444444444";
const B = "0x5555555555555555555555555555555555555555";
const DASH = "http://localhost:5173";

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; body: string };
/** Raw node:http request, so the Host header can be set (fetch forbids it). */
function raw(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }));
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function policySetup() {
  const dir = mkdtempSync(join(tmpdir(), "qday-srv-"));
  const policyFile = join(dir, "policy.json");
  const store = createPolicyStore({ file: policyFile, seed: { trusted: [{ label: "cold", address: A, kind: "wallet" }], maxOutbound: "10" }, log: () => {} });
  return { file: join(dir, "i.jsonl"), policyFile, store };
}

describe("server: binding", () => {
  it("test_serverBindsLoopbackOnly", async () => {
    const file = join(tmpdir(), "nope.jsonl");
    srv = await startServer({ file, port: 0 });
    expect(srv.address).toBe("127.0.0.1"); // the default bind
    await srv.close();
    srv = undefined;
    for (const host of ["0.0.0.0", "::", "192.168.1.5", "example.com", ""]) {
      await expect(startServer({ file, port: 0, host })).rejects.toThrow(/loopback/);
    }
    srv = await startServer({ file, port: 0, host: "localhost" });
    await srv.close();
    srv = await startServer({ file, port: 0, host: "::1" }).catch(() => undefined); // no IPv6 on some hosts
  });
});

describe("server: PUT /policy write checks", () => {
  const opts = { port: 8787, origins: [DASH] };
  const ok = { remoteAddress: "127.0.0.1", host: "127.0.0.1:8787", origin: undefined, contentType: "application/json" };

  it("checkPolicyWrite allows loopback writes with a local Host, a dashboard or no Origin and JSON", () => {
    expect(checkPolicyWrite(ok, opts)).toBeNull();
    expect(checkPolicyWrite({ ...ok, remoteAddress: "::1", host: "[::1]:8787" }, opts)).toBeNull();
    expect(checkPolicyWrite({ ...ok, remoteAddress: "::ffff:127.0.0.1", host: "localhost:8787" }, opts)).toBeNull();
    expect(checkPolicyWrite({ ...ok, remoteAddress: "127.0.0.2" }, opts)).toBeNull();
    expect(checkPolicyWrite({ ...ok, origin: DASH, contentType: "application/json; charset=utf-8" }, opts)).toBeNull();
  });

  it("test_policyWriteRejectedFromNonLoopback", async () => {
    // The pure check: a non-loopback peer is refused whatever its headers say.
    expect(checkPolicyWrite({ ...ok, remoteAddress: "192.168.1.5" }, opts)).toEqual({ status: 403, error: expect.any(String) });
    expect(checkPolicyWrite({ ...ok, remoteAddress: "::ffff:10.0.0.1" }, opts)).toEqual({ status: 403, error: expect.any(String) });
    expect(checkPolicyWrite({ ...ok, remoteAddress: undefined }, opts)?.status).toBe(403);
    // DNS rebinding (foreign Host), a foreign web page (foreign Origin), a simple-request body (no preflight).
    expect(checkPolicyWrite({ ...ok, host: "evil.example:8787" }, opts)?.status).toBe(403);
    expect(checkPolicyWrite({ ...ok, host: "127.0.0.1:9999" }, opts)?.status).toBe(403);
    expect(checkPolicyWrite({ ...ok, host: undefined }, opts)?.status).toBe(403);
    expect(checkPolicyWrite({ ...ok, origin: "https://evil.example" }, opts)?.status).toBe(403);
    expect(checkPolicyWrite({ ...ok, origin: "null" }, opts)?.status).toBe(403);
    expect(checkPolicyWrite({ ...ok, contentType: "text/plain" }, opts)?.status).toBe(415);
    expect(checkPolicyWrite({ ...ok, contentType: undefined }, opts)?.status).toBe(415);

    // Over real HTTP: each refused write leaves the file byte-for-byte unchanged.
    const { file, policyFile, store } = policySetup();
    srv = await startServer({ file, port: 0, policy: store, dashboardOrigins: [DASH] });
    const before = readFileSync(policyFile, "utf8");
    const body = JSON.stringify({ trusted: [{ label: "attacker", address: B, kind: "app" }], maxOutbound: "999999" });
    const json = { "Content-Type": "application/json" };
    const tries: [Record<string, string>, number][] = [
      [{ ...json, Host: `evil.example:${srv.port}` }, 403],
      [{ ...json, Origin: "https://evil.example" }, 403],
      [{ "Content-Type": "text/plain" }, 415],
    ];
    for (const [headers, status] of tries) {
      const r = await raw(srv.port, "PUT", "/policy", headers, body);
      expect(r.status).toBe(status);
      expect(JSON.parse(r.body).error).toEqual(expect.any(String));
      expect(readFileSync(policyFile, "utf8")).toBe(before);
    }
  });

  it("test_putPolicyValidates", async () => {
    const { file, policyFile, store } = policySetup();
    srv = await startServer({ file, port: 0, policy: store, dashboardOrigins: [DASH] });
    const before = readFileSync(policyFile, "utf8");
    const json = { "Content-Type": "application/json" };

    const bad = await raw(srv.port, "PUT", "/policy", json, JSON.stringify({ trusted: [{ label: "x", address: "0x12", kind: "app" }], maxOutbound: "1" }));
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).error).toMatch(/address/);
    expect((await raw(srv.port, "PUT", "/policy", json, "{nope")).status).toBe(400);
    const big = JSON.stringify({ trusted: [], maxOutbound: "1", pad: "x".repeat(70 * 1024) });
    expect((await raw(srv.port, "PUT", "/policy", json, big)).status).toBe(413);
    expect(readFileSync(policyFile, "utf8")).toBe(before);

    const next = { trusted: [{ label: "dex", address: B, kind: "app" }], maxOutbound: "5" };
    const put = await raw(srv.port, "PUT", "/policy", { ...json, Origin: DASH }, JSON.stringify(next));
    expect(put.status).toBe(200);
    expect(put.headers["access-control-allow-origin"]).toBe(DASH);
    expect(JSON.parse(put.body)).toEqual(next);
    const get = await raw(srv.port, "GET", "/policy");
    expect(get.status).toBe(200);
    expect(JSON.parse(get.body)).toEqual(next);
    expect(JSON.parse(readFileSync(policyFile, "utf8"))).toEqual(next);
  });

  it("CORS on /policy names only a dashboard origin; the preflight allows GET, PUT and Content-Type", async () => {
    const { file, store } = policySetup();
    srv = await startServer({ file, port: 0, policy: store, dashboardOrigins: [DASH] });
    const pre = await raw(srv.port, "OPTIONS", "/policy", { Origin: DASH, "Access-Control-Request-Method": "PUT" });
    expect(pre.status).toBe(204);
    expect(pre.headers["access-control-allow-origin"]).toBe(DASH);
    expect(pre.headers["vary"]).toBe("Origin");
    expect(pre.headers["access-control-allow-methods"]).toBe("GET, PUT, OPTIONS");
    expect(pre.headers["access-control-allow-headers"]).toBe("Content-Type");
    const evil = await raw(srv.port, "OPTIONS", "/policy", { Origin: "https://evil.example" });
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
    const get = await raw(srv.port, "GET", "/policy", { Origin: "https://evil.example" });
    expect(get.headers["access-control-allow-origin"]).toBeUndefined();
    expect((await raw(srv.port, "GET", "/incidents")).headers["access-control-allow-origin"]).toBe("*");
  });

  it("every /policy method checks the Host header (DNS rebinding cannot read the trusted list either)", async () => {
    const { file, store } = policySetup();
    srv = await startServer({ file, port: 0, policy: store, dashboardOrigins: [DASH] });
    const evil = { Host: `evil.example:${srv.port}` };
    const get = await raw(srv.port, "GET", "/policy", evil);
    expect(get.status).toBe(403);
    expect(get.body).not.toContain(A.slice(2));
    expect((await raw(srv.port, "OPTIONS", "/policy", { ...evil, Origin: DASH })).status).toBe(403);
    expect((await raw(srv.port, "GET", "/policy", { Host: `localhost:${srv.port}` })).status).toBe(200);
    expect((await raw(srv.port, "GET", "/policy", { Host: `[::1]:${srv.port}` })).status).toBe(200);
  });

  it("a server-side write failure answers 500 with a generic message (no paths); validation errors stay 400", async () => {
    const { file, store } = policySetup();
    const lines: string[] = [];
    const failing = {
      get: store.get,
      set: () => { throw new Error("EACCES: permission denied, open '/home/owner/data/.policy-0xabc.json.123.tmp'"); },
    };
    srv = await startServer({ file, port: 0, policy: failing, dashboardOrigins: [DASH], log: (l) => void lines.push(l) });
    const json = { "Content-Type": "application/json" };
    const r = await raw(srv.port, "PUT", "/policy", json, JSON.stringify({ trusted: [], maxOutbound: "1" }));
    expect(r.status).toBe(500);
    expect(r.body).not.toContain("/home");
    expect(r.body).not.toContain("EACCES");
    expect(JSON.parse(r.body).error).toEqual(expect.any(String));
    expect(lines.some((l) => l.includes("EACCES"))).toBe(true); // the cause is logged on the agent side
    const bad = await raw(srv.port, "PUT", "/policy", json, JSON.stringify({ trusted: [], maxOutbound: 1 }));
    expect(bad.status).toBe(400);
    expect(JSON.parse(bad.body).error).toMatch(/maxOutbound/);
  });

  it("answers 413 at once on a declared Content-Length over 64 KiB, without waiting for the body, and closes", async () => {
    const { file, policyFile, store } = policySetup();
    srv = await startServer({ file, port: 0, policy: store, dashboardOrigins: [DASH] });
    const before = readFileSync(policyFile, "utf8");
    const port = srv.port;
    const r = await new Promise<{ status: number; closed: Promise<void> }>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port, method: "PUT", path: "/policy", headers: { Host: `127.0.0.1:${port}`, "Content-Type": "application/json", "Content-Length": String(1024 * 1024) } },
        (res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0, closed: new Promise<void>((done) => req.socket?.once("close", () => done())) });
        },
      );
      req.on("error", () => {}); // the server closing the socket mid-upload is expected
      req.flushHeaders(); // headers only: the 1 MiB body is never sent
      setTimeout(() => reject(new Error("no 413 before the body was sent")), 1000).unref();
    });
    expect(r.status).toBe(413);
    await r.closed; // the server closed the connection instead of reading 1 MiB
    expect(readFileSync(policyFile, "utf8")).toBe(before);
  });

  it("404s /policy and /health when no provider is wired", async () => {
    srv = await startServer({ file: join(tmpdir(), "nope.jsonl"), port: 0 });
    expect((await raw(srv.port, "GET", "/policy")).status).toBe(404);
    expect((await raw(srv.port, "PUT", "/policy", { "Content-Type": "application/json" }, "{}")).status).toBe(404);
    expect((await raw(srv.port, "GET", "/health")).status).toBe(404);
  });
});

describe("server: GET /health", () => {
  it("test_healthReportsTipWindowAndGas", async () => {
    const VAULT = "0x17d867860a0A0Ff528dF655439ff59176b061B3C" as const;
    const GUARDIAN = "0x9858EfFD232B4033E47d90003D41EC34EcaEdA94" as const;
    const readBalance = vi.fn(async () => 2n * 10n ** 18n);
    const readWindow = vi.fn(() => ({ live: true, remainingBlocks: 900n, remainingTxs: 9n, remainingValue: 10n ** 18n, allowedTargets: [VAULT] }));
    const health = createHealth({
      guardian: GUARDIAN, vault: VAULT, gasLowWei: 5n * 10n ** 17n, readBalance, readWindow,
      channels: { telegram: true, webhook: false }, notify: () => {}, log: () => {}, startedAt: "2026-11-21T09:00:00.000Z",
    });
    health.setTip(1234n);
    await health.checkGas();
    srv = await startServer({ file: join(tmpdir(), "nope.jsonl"), port: 0, health: health.snapshot });
    const calls = readBalance.mock.calls.length;
    const r = await fetch(`http://127.0.0.1:${srv.port}/health`);
    expect(r.status).toBe(200);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    const body = await r.json();
    expect(body).toMatchObject({
      ok: true,
      startedAt: "2026-11-21T09:00:00.000Z",
      lastBlock: "1234",
      lastBlockAt: expect.any(String),
      window: { live: true, remainingBlocks: "900", remainingTxs: "9", remainingValue: "1000000000000000000" },
      gas: { guardian: GUARDIAN, balance: "2000000000000000000", threshold: "500000000000000000", low: false },
      alerts: { telegram: true, webhook: false },
    });
    expect(readBalance.mock.calls.length).toBe(calls); // served from cache: no RPC per request
  });
});

describe("server: a failing provider", () => {
  it("answers 500 instead of crashing the process", async () => {
    srv = await startServer({ file: join(tmpdir(), "nope.jsonl"), port: 0, health: () => { throw new Error("boom"); } });
    expect((await fetch(`http://127.0.0.1:${srv.port}/health`)).status).toBe(500);
    expect((await fetch(`http://127.0.0.1:${srv.port}/incidents`)).status).toBe(200); // still serving
  });
});
