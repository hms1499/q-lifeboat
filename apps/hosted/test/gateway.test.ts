import { createServer, request, type IncomingHttpHeaders, type Server, type ServerResponse } from "node:http";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { signOwnerRequest, type OwnerPurpose, type SignedOwnerRequest } from "@qday/core";
import { deriveUnifiedAccount, type PqcStatus, type UnifiedAccount } from "@qorechain/sdk";
import { createOwnerAuth } from "../src/auth.ts";
import { createGateway, type GatewaySupervisor } from "../src/gateway.ts";
import { createHostedServer } from "../src/server.ts";
import { createStore, type Store } from "../src/store.ts";

const OWNER_MN = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const OTHER_MN = "letter advice cage absurd amount doctor acoustic avoid letter advice cage above";
const T0 = Date.UTC(2026, 10, 25, 12);
const nowSec = Math.floor(T0 / 1000);
const VAULT = ("0x" + "77".repeat(20)) as Hex;
const GUARD = ("0x" + "66".repeat(20)) as Hex;

let ownerAcc: UnifiedAccount, otherAcc: UnifiedAccount;
let agent: Server, agentPort: number, hosted: Server, base: string;
let store: Store;
let t = T0;
type Seen = { method?: string; url?: string; headers: IncomingHttpHeaders; body: string };
let seen: Seen[] = [];
let sseClosed = 0;
const sseClients = new Set<ServerResponse>();

const running = new Map<string, number>();
const calls: string[] = [];
/** The owner's lastActiveAt as revive saw it. */
const reviveSaw: number[] = [];
/** Owners refilled, in call order, with what the agent had seen by then. */
const refills: string[] = [];
let refillFails = false;
const supervisor: GatewaySupervisor = {
  portOf: (o) => running.get(o.toLowerCase()),
  start: async (o) => {
    calls.push(`start:${o}`);
    running.set(o.toLowerCase(), agentPort);
    return { ok: true, port: agentPort };
  },
  stop: async (o) => {
    calls.push(`stop:${o}`);
    running.delete(o.toLowerCase());
  },
  revive: async (o) => {
    calls.push(`revive:${o}`);
    const s = store.get(o)!;
    reviveSaw.push(s.lastActiveAt);
    store.put({ ...s, stage: "active" });
    running.set(o.toLowerCase(), agentPort);
    return { ok: true, port: agentPort };
  },
};

let n = 0;
const sign = (acc: UnifiedAccount, purpose: OwnerPurpose, body: unknown, over: Partial<SignedOwnerRequest["request"]> = {}): SignedOwnerRequest =>
  signOwnerRequest({ owner: acc.evm as Hex, purpose, body, nonce: `g-${++n}`, expiresAt: nowSec + 120, ...over }, acc.pqc.secretKey);

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));

const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(base + path, {
    method,
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: r.status, json, text, headers: r.headers };
};

beforeAll(async () => {
  [ownerAcc, otherAcc] = await Promise.all([OWNER_MN, OTHER_MN].map((m) => deriveUnifiedAccount(m)));
  agent = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.url === "/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
        res.write(": connected\n\n");
        sseClients.add(res);
        res.on("close", () => {
          sseClosed++;
          sseClients.delete(res);
        });
        return;
      }
      if (req.url === "/arm") {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ tx: "0xARM", got: JSON.parse(body) }));
      }
      if (req.url === "/policy" && req.method === "PUT") {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(body);
      }
      res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
      res.end(JSON.stringify({ path: req.url }));
    });
  });
  agentPort = await listen(agent);
});

beforeEach(async () => {
  hosted?.close();
  hosted?.closeAllConnections();
  seen = [];
  calls.length = 0;
  running.clear();
  t = T0;
  store = createStore(mkdtempSync(join(tmpdir(), "gw-")));
  store.put({ owner: ownerAcc.evm as Hex, stage: "active", starter: true, guardian: GUARD, vault: VAULT, port: agentPort, createdAt: T0 - 1000, lastActiveAt: T0 - 1000, topups: 0 });
  running.set(ownerAcc.evm.toLowerCase(), agentPort);
  const pqc = new Map<string, PqcStatus>([
    [ownerAcc.cosmos, { registered: true, possessionProven: true, pubkey: ownerAcc.pqc.publicKey }],
    [otherAcc.cosmos, { registered: true, possessionProven: true, pubkey: otherAcc.pqc.publicKey }],
  ]);
  const auth = createOwnerAuth({ pqcStatus: async (c) => pqc.get(c) ?? { registered: false }, now: () => t });
  refills.length = 0;
  refillFails = false;
  const gateway = createGateway({
    store,
    supervisor,
    auth,
    now: () => t,
    sleep: async () => {},
    readyTimeoutMs: 2000,
    refill: async (o) => {
      refills.push(`${o}:${seen.map((x) => x.url).join(",")}`);
      if (refillFails) throw new Error("funder RPC down");
    },
  });
  hosted = createHostedServer({ distDir: mkdtempSync(join(tmpdir(), "d-")), restUrl: "http://x", rpcUrl: "http://x", store, status: () => ({ onboarding: "open", activeGuardians: 0 }), gateway });
  base = `http://127.0.0.1:${await listen(hosted)}`;
});

afterAll(() => {
  for (const c of sseClients) c.end();
  hosted?.close();
  hosted?.closeAllConnections();
  agent.close();
  agent.closeAllConnections();
});

const O = () => ownerAcc.evm;

describe("gateway reads", () => {
  it("GET /api/o/<owner>/drill → 404", async () => {
    const r = await call("GET", `/api/o/${O()}/drill`);
    expect(r.status).toBe(404);
    expect((await call("GET", `/api/o/${O()}/drill/runs`)).status).toBe(404);
    expect((await call("POST", `/api/o/${O()}/drill`, {})).status).toBe(404);
    expect((await call("GET", `/api/o/${O()}/arm`)).status).toBe(404);
    expect((await call("DELETE", `/api/o/${O()}/policy`)).status).toBe(404);
    expect(seen).toEqual([]);
  });

  it("GET config|health|incidents|policy are proxied as is, with Host 127.0.0.1:<port> and no Origin", async () => {
    for (const p of ["config", "health", "incidents", "policy"]) {
      const r = await call("GET", `/api/o/${O()}/${p}?x=1`, undefined, { origin: "https://evil.example" });
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ path: `/${p}` });
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(seen.map((s) => s.url)).toEqual(["/config", "/health", "/incidents", "/policy"]);
    for (const s of seen) {
      expect(s.headers.host).toBe(`127.0.0.1:${agentPort}`);
      expect(s.headers.origin).toBeUndefined();
    }
  });

  it("an invalid owner is 400, an unknown one 404, a stopped one 503", async () => {
    expect((await call("GET", `/api/o/0x12/config`)).status).toBe(400);
    expect((await call("GET", `/api/o/0x${"ab".repeat(20)}/config`)).status).toBe(404);
    running.clear();
    expect((await call("GET", `/api/o/${O()}/config`)).status).toBe(503);
  });

  it("GET events is streamed through and closed upstream when the client goes away", async () => {
    const before = sseClosed;
    const url = new URL(`${base}/api/o/${O()}/events`);
    const first = await new Promise<string>((resolve, reject) => {
      const req = request(url, (res) => {
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toBe("text/event-stream");
        res.once("data", (c: Buffer) => {
          resolve(c.toString());
          // A frame published later also arrives, before any end.
          for (const c of sseClients) c.write("event: incident\ndata: {}\n\n");
          res.once("data", () => req.destroy());
        });
      });
      req.on("error", (e) => (e.message.includes("socket hang up") || e.message.includes("aborted") ? undefined : reject(e)));
      req.end();
    });
    expect(first).toContain(": connected");
    await new Promise((r) => setTimeout(r, 100));
    expect(sseClosed).toBe(before + 1);
  });
});

describe("gateway signed writes", () => {
  const policy = { trusted: ["0x" + "12".repeat(20)], maxOutbound: "1000" };

  it("PUT policy with a classical-only body → 401", async () => {
    expect((await call("PUT", `/api/o/${O()}/policy`, policy)).status).toBe(401);
    // A secp256k1-style signature where the ML-DSA one belongs is refused too.
    const forged = { ...sign(ownerAcc, "policy", policy), sig: ("0x" + "ab".repeat(65)) as Hex };
    expect((await call("PUT", `/api/o/${O()}/policy`, forged)).status).toBe(401);
    expect(seen).toEqual([]);
  });

  it("PUT policy signed by another account → 401", async () => {
    // Its own request, sent to this owner's path.
    expect((await call("PUT", `/api/o/${O()}/policy`, sign(otherAcc, "policy", policy))).status).toBe(401);
    // This owner named in the request, but signed with the other account's key.
    const lie = signOwnerRequest({ owner: ownerAcc.evm as Hex, purpose: "policy", body: policy, nonce: "lie", expiresAt: nowSec + 60 }, otherAcc.pqc.secretKey);
    expect((await call("PUT", `/api/o/${O()}/policy`, lie)).status).toBe(401);
    expect(seen).toEqual([]);
  });

  it("a signature for another purpose is refused", async () => {
    expect((await call("PUT", `/api/o/${O()}/policy`, sign(ownerAcc, "arm", policy))).status).toBe(401);
    expect((await call("POST", `/api/o/${O()}/arm`, sign(ownerAcc, "stop", { blocks: 10 }))).status).toBe(401);
    expect(seen).toEqual([]);
  });

  it("a valid signed arm reaches the fake agent with Host 127.0.0.1:<port>", async () => {
    t = T0 + 5000;
    const r = await call("POST", `/api/o/${O()}/arm`, sign(ownerAcc, "arm", { blocks: 600 }), { origin: `${base}` });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ tx: "0xARM", got: { blocks: 600 } });
    expect(seen.length).toBe(1);
    const s = seen[0]!;
    expect(s).toMatchObject({ method: "POST", url: "/arm" });
    expect(s.headers.host).toBe(`127.0.0.1:${agentPort}`);
    expect(s.headers.origin).toBeUndefined();
    expect(s.headers["content-type"]).toBe("application/json");
    // Only the inner body, never the signature wrapper.
    expect(JSON.parse(s.body)).toEqual({ blocks: 600 });
    expect(store.get(O())?.lastActiveAt).toBe(T0 + 5000);
  });

  it("a valid signed policy forwards the policy itself and updates lastActiveAt", async () => {
    t = T0 + 7000;
    const r = await call("PUT", `/api/o/${O()}/policy`, sign(ownerAcc, "policy", policy));
    expect(r.status).toBe(200);
    expect(seen.length).toBe(1);
    expect(seen[0]).toMatchObject({ method: "PUT", url: "/policy" });
    expect(JSON.parse(seen[0]!.body)).toEqual(policy);
    expect(store.get(O())?.lastActiveAt).toBe(T0 + 7000);
  });

  it("a replayed signed request is refused", async () => {
    const s = sign(ownerAcc, "arm", { blocks: 10 });
    expect((await call("POST", `/api/o/${O()}/arm`, s)).status).toBe(200);
    expect((await call("POST", `/api/o/${O()}/arm`, s)).status).toBe(409);
    expect(seen.length).toBe(1);
  });

  it("a signed stop stops the owner's agent", async () => {
    t = T0 + 9000;
    const r = await call("POST", `/api/o/${O()}/stop`, sign(ownerAcc, "stop", {}));
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    expect(calls).toEqual([`stop:${O().toLowerCase()}`]);
    expect(store.get(O())?.lastActiveAt).toBe(T0 + 9000);
    expect(seen).toEqual([]);
  });

  it("a signed arm on a stopped owner starts it through revive (the per-owner lock), waits for /health, then forwards", async () => {
    running.clear();
    store.put({ ...store.get(O())!, stopped: true });
    const r = await call("POST", `/api/o/${O()}/arm`, sign(ownerAcc, "arm", { blocks: 600 }));
    expect(r.status).toBe(200);
    expect(calls).toEqual([`revive:${O().toLowerCase()}`]);
    expect(seen.map((s) => s.url)).toEqual(["/health", "/arm"]);
  });

  it("a signed arm marks the owner active BEFORE revive, so an hourly retireIdle cannot retire the agent just armed", async () => {
    running.clear();
    reviveSaw.length = 0;
    store.put({ ...store.get(O())!, stopped: true });
    t = T0 + 11_000;
    expect((await call("POST", `/api/o/${O()}/arm`, sign(ownerAcc, "arm", { blocks: 600 }))).status).toBe(200);
    expect(reviveSaw).toEqual([T0 + 11_000]);
  });

  it("a signed arm refills the guardian's gas BEFORE the agent opens its window", async () => {
    const r = await call("POST", `/api/o/${O()}/arm`, sign(ownerAcc, "arm", { blocks: 600 }));
    expect(r.status).toBe(200);
    expect(refills).toEqual([`${O().toLowerCase()}:`]);
    expect(seen.map((x) => x.url)).toEqual(["/arm"]);
  });

  it("an arm asking for more than 1800 blocks, or a non-integer, is refused before any refill or forward", async () => {
    for (const blocks of [1801, 14_400, 0, 1.5, "600"]) {
      const r = await call("POST", `/api/o/${O()}/arm`, sign(ownerAcc, "arm", { blocks }));
      expect(r.status).toBe(400);
    }
    expect(refills).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("a failed refill does not block the arm (the guardian may still hold enough)", async () => {
    refillFails = true;
    expect((await call("POST", `/api/o/${O()}/arm`, sign(ownerAcc, "arm", { blocks: 600 }))).status).toBe(200);
    expect(seen.map((x) => x.url)).toEqual(["/arm"]);
  });

  it("no refill for an unsigned arm, a policy write or a stop", async () => {
    await call("POST", `/api/o/${O()}/arm`, { blocks: 600 });
    await call("PUT", `/api/o/${O()}/policy`, sign(ownerAcc, "policy", { trusted: [], maxOutbound: "0" }));
    await call("POST", `/api/o/${O()}/stop`, sign(ownerAcc, "stop", {}));
    expect(refills).toEqual([]);
  });

  it("a signed arm on a retired owner revives it (re-fund + start) and forwards", async () => {
    running.clear();
    store.put({ ...store.get(O())!, stage: "retired" });
    const r = await call("POST", `/api/o/${O()}/arm`, sign(ownerAcc, "arm", { blocks: 600 }));
    expect(r.status).toBe(200);
    expect(calls).toEqual([`revive:${O().toLowerCase()}`]);
    expect(seen.at(-1)?.url).toBe("/arm");
  });

  it("a signed policy for an owner whose agent is not running is 503 and not forwarded", async () => {
    running.clear();
    expect((await call("PUT", `/api/o/${O()}/policy`, sign(ownerAcc, "policy", policy))).status).toBe(503);
    expect(seen).toEqual([]);
  });
});
