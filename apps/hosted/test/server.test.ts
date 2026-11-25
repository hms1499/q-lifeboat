import { createServer, type Server } from "node:http";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHostedServer } from "../src/server.ts";
import { createStore } from "../src/store.ts";

const A = "0x" + "ab".repeat(20);
const listen = (s: Server) => new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

let up: Server, hosted: Server, base: string, upBase: string;
const seen: { url?: string; method?: string; body?: string; lastRpcUrl?: string }[] = [];
const store = createStore(mkdtempSync(join(tmpdir(), "hs-")));

beforeAll(async () => {
  up = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, method: req.method, body });
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ via: "upstream", url: req.url }));
    });
  });
  upBase = await listen(up);
  const dist = mkdtempSync(join(tmpdir(), "dist-"));
  writeFileSync(join(dist, "index.html"), "<html>SPA</html>");
  mkdirSync(join(dist, "assets"));
  writeFileSync(join(dist, "assets", "a.js"), "console.log(1)");
  store.put({ owner: A as `0x${string}`, stage: "active", createdAt: 1, lastActiveAt: 1, topups: 0, guardian: ("0x" + "11".repeat(20)) as `0x${string}`, port: 9999 });
  hosted = createHostedServer({
    distDir: dist, restUrl: upBase, rpcUrl: upBase, store,
    status: () => ({ onboarding: "open", activeGuardians: store.list().filter((o) => o.stage === "active").length }),
  });
  base = await listen(hosted);
});
afterAll(() => { up.close(); hosted.close(); });

describe("hosted server", () => {
  it("forwards /qore-rest/cosmos/x to <REST>/cosmos/x", async () => {
    const r = await fetch(`${base}/qore-rest/cosmos/x?a=1`);
    expect(r.status).toBe(201);
    expect((await r.json()).url).toBe("/cosmos/x?a=1");
  });
  it("does not strip a non-segment prefix", async () => {
    const r = await fetch(`${base}/qore-restx/y`);
    expect(await r.text()).toContain("SPA");
  });
  it("forwards POST JSON-RPC on /qore-rpc", async () => {
    const r = await fetch(`${base}/qore-rpc`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"id":1}' });
    expect(r.status).toBe(201);
    const last = seen.at(-1)!;
    expect(last.method).toBe("POST");
    expect(last.body).toBe('{"id":1}');
    expect(last.url).toBe("/");
  });
  it("forwards GET /qore-rpc/status", async () => {
    await fetch(`${base}/qore-rpc/status`);
    expect(seen.at(-1)!.url).toBe("/status");
  });
  it("serves index.html at / and for unknown paths, assets as files", async () => {
    expect(await (await fetch(`${base}/`)).text()).toContain("SPA");
    expect(await (await fetch(`${base}/some/route`)).text()).toContain("SPA");
    const a = await fetch(`${base}/assets/a.js`);
    expect(await a.text()).toBe("console.log(1)");
    expect(a.headers.get("content-type")).toContain("javascript");
  });
  it("blocks path traversal", async () => {
    const r = await fetch(`${base}/..%2f..%2fetc/passwd`);
    expect(await r.text()).toContain("SPA");
  });
  it("/api/status shape", async () => {
    const r = await fetch(`${base}/api/status`);
    expect(await r.json()).toEqual({ onboarding: "open", activeGuardians: 1 });
  });
  it("/api/owner returns public state only, none when unknown, 400 when malformed", async () => {
    const known = await (await fetch(`${base}/api/owner/${A.toUpperCase().replace("0X", "0x")}`)).json();
    expect(known).toEqual({ stage: "active", guardian: "0x" + "11".repeat(20) });
    expect(await (await fetch(`${base}/api/owner/0x${"cd".repeat(20)}`)).json()).toEqual({ stage: "none" });
    expect((await fetch(`${base}/api/owner/nope`)).status).toBe(400);
  });
  it("unknown /api path is 404 json", async () => {
    expect((await fetch(`${base}/api/zzz`)).status).toBe(404);
  });
});
