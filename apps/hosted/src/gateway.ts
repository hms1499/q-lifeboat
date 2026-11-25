import { request, type IncomingMessage, type ServerResponse } from "node:http";
import type { OwnerPurpose } from "@qday/core";
import type { Hex } from "viem";
import type { OwnerAuth } from "./auth.ts";
import { readJson } from "./server.ts";
import { isOwnerAddress, type Store } from "./store.ts";
import type { StartResult } from "./supervisor.ts";

/** What the gateway needs from the supervisor. */
export type GatewaySupervisor = {
  portOf(owner: string): number | undefined;
  start(owner: string): Promise<StartResult>;
  stop(owner: string): Promise<void>;
  revive(owner: string): Promise<StartResult>;
};

export type GatewayDeps = {
  store: Store;
  supervisor: GatewaySupervisor;
  /** Shared with the provisioner: one replay set for every signed request. */
  auth: OwnerAuth;
  /** Milliseconds. */
  now(): number;
  log?(line: string): void;
  sleep?(ms: number): Promise<void>;
  /** How long a signed `arm` waits for a just-started agent to answer /health. */
  readyTimeoutMs?: number;
  /** Top the owner's guardian up before a signed `arm` reaches its agent (the provisioner's `refillOnArm`). */
  refill?(owner: Hex): Promise<unknown>;
};

/** Reads proxied as is. `/policy` is read by the dashboard's Rules page (spec §6.3); `/drill*` never (spec §6.8). */
const READS = new Set(["config", "health", "incidents", "events", "policy"]);
/** Signed writes: route → method and the purpose its signature must carry. */
const WRITES: Record<string, { method: string; purpose: OwnerPurpose }> = {
  policy: { method: "PUT", purpose: "policy" },
  arm: { method: "POST", purpose: "arm" },
  stop: { method: "POST", purpose: "stop" },
};

const READ_TIMEOUT_MS = 15_000;
/**
 * The app arms for 600 blocks. A bound on what an owner can ask the agent for; it does NOT stop repeated arms from
 * reopening 0.225 QOR windows: the refill caps (per owner and overall, per day) are what bound the funder's spend.
 */
export const MAX_ARM_BLOCKS = 1800;
/** `/arm` opens the guardian window and waits until it is live: a few blocks plus REST lag. */
const WRITE_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 500;
const HOP = new Set(["connection", "content-length", "content-encoding", "transfer-encoding", "keep-alive"]);

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Stream one agent response through: headers as soon as they arrive, the body piped (SSE frames are never buffered).
 * The request goes to 127.0.0.1:<port> with `Host: 127.0.0.1:<port>` and no Origin, so the agent's loopback write
 * checks pass. When the client goes away, the upstream request is torn down.
 */
function forward(port: number, method: string, path: string, body: string | undefined, timeoutMs: number | undefined, res: ServerResponse): Promise<void> {
  return new Promise<void>((done) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${port}` };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(body));
    }
    const up = request({ host: "127.0.0.1", port, method, path, headers }, (ur) => {
      const out: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(ur.headers)) {
        // Same-origin dashboard: the agent's CORS headers have no business on the public origin.
        if (v === undefined || HOP.has(k) || k.startsWith("access-control-")) continue;
        out[k] = v;
      }
      if (String(ur.headers["content-type"] ?? "").startsWith("text/event-stream")) out["x-accel-buffering"] = "no";
      res.writeHead(ur.statusCode ?? 502, out);
      res.flushHeaders();
      ur.pipe(res);
      ur.on("end", done);
      ur.on("error", () => {
        res.end();
        done();
      });
    });
    up.on("error", () => {
      if (!res.headersSent) json(res, 502, { error: "agent unreachable" });
      else res.end();
      done();
    });
    if (timeoutMs !== undefined) up.setTimeout(timeoutMs, () => up.destroy(new Error("agent timeout")));
    res.on("close", () => {
      up.destroy();
      done();
    });
    up.end(body);
  });
}

/** One GET /health that answers 200 within 2 s. */
function healthy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const r = request({ host: "127.0.0.1", port, method: "GET", path: "/health", headers: { host: `127.0.0.1:${port}` } }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    r.on("error", () => resolve(false));
    r.setTimeout(2_000, () => r.destroy(new Error("timeout")));
    r.end();
  });
}

/**
 * `/api/o/<owner>/<route>`: reads proxied to the owner's loopback agent; `PUT policy`, `POST arm` and `POST stop`
 * only with a valid ML-DSA-87 signature by that owner's registered key, with the matching purpose. Anything else 404.
 */
export function createGateway(deps: GatewayDeps) {
  const { store, supervisor, auth } = deps;
  const log = deps.log ?? (() => {});
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const readyTries = Math.max(1, Math.ceil((deps.readyTimeoutMs ?? 60_000) / READY_POLL_MS));

  const waitReady = async (port: number): Promise<boolean> => {
    for (let i = 0; i < readyTries; i++) {
      if (await healthy(port)) return true;
      await sleep(READY_POLL_MS);
    }
    return false;
  };

  const touch = (o: Hex) => {
    const s = store.get(o);
    if (s) store.put({ ...s, lastActiveAt: deps.now() });
  };

  async function signedWrite(req: IncomingMessage, res: ServerResponse, o: Hex, route: string, purpose: OwnerPurpose): Promise<void> {
    const body = await readJson(req);
    if (!body.ok) return json(res, body.code, { error: body.code === 413 ? "body too large" : "invalid json" });
    // The path names the owner: a request signed for any other owner is refused before any chain read.
    const named = (body.value as { request?: { owner?: unknown } } | null)?.request?.owner;
    if (typeof named === "string" && named.toLowerCase() !== o) return json(res, 401, { error: "owner-mismatch" });
    const a = await auth.authorize(body.value, purpose);
    if (!a.ok) {
      // An unsigned (or classically signed) body is an authorization failure, not a bad request.
      if (a.reply.code === 400) return json(res, 401, { error: "signature-required" });
      return json(res, a.reply.code, a.reply.body);
    }
    if (a.owner !== o) return json(res, 401, { error: "owner-mismatch" });

    const state = store.get(o);
    if (!state) return json(res, 404, { error: "unknown owner" });
    if (route === "arm") {
      const blocks = (a.body as { blocks?: unknown } | null)?.blocks;
      if (typeof blocks !== "number" || !Number.isInteger(blocks) || blocks < 1 || blocks > MAX_ARM_BLOCKS) {
        return json(res, 400, { error: `blocks must be a whole number from 1 to ${MAX_ARM_BLOCKS}` });
      }
    }

    if (route === "stop") {
      if (state.stage !== "active" && state.stage !== "retired") return json(res, 409, { error: "not-active" });
      touch(o);
      await supervisor.stop(o);
      return json(res, 200, { ok: true });
    }

    let port = supervisor.portOf(o);
    if (route === "arm" && port === undefined) {
      if (state.stage !== "active" && state.stage !== "retired") return json(res, 409, { error: "not-active" });
      // A stopped owner starts again; a retired one gets its guardian re-funded first. Both go through revive, under
      // the per-owner lock, so an arm never races retireIdle into a running agent on a retired row.
      // Active now, before the (possibly slow) start: an hourly retireIdle in between must not retire this owner.
      touch(o);
      const r = await supervisor.revive(o);
      if (!r.ok) {
        log(`gateway: arm for ${o} could not start its agent (${r.reason})`);
        return json(res, 503, { error: r.reason });
      }
      port = r.port;
      if (!(await waitReady(port))) return json(res, 504, { error: "agent-not-ready" });
    }
    if (port === undefined) return json(res, 503, { error: "agent-not-running" });
    touch(o);
    // The agent opens its window right after this: its gas must be there first. A failed refill is logged, not fatal
    // (the guardian may still hold enough for one window).
    if (route === "arm" && deps.refill) {
      try {
        await deps.refill(o);
      } catch (e) {
        log(`gateway: refill for ${o} failed: ${errorText(e)}`);
      }
    }
    // Only the signed inner body reaches the agent, never the signature wrapper.
    await forward(port, WRITES[route]!.method, `/${route}`, JSON.stringify(a.body ?? null), WRITE_TIMEOUT_MS, res);
  }

  return {
    async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
      try {
        const pathname = (req.url ?? "/").split("?")[0]!;
        const m = /^\/api\/o\/([^/]+)\/([^/]+)$/.exec(pathname);
        const method = req.method ?? "GET";
        const route = m?.[2];
        const isRead = route !== undefined && method === "GET" && READS.has(route);
        const write = route !== undefined ? WRITES[route] : undefined;
        const isWrite = write !== undefined && write.method === method;
        if (!m || (!isRead && !isWrite)) {
          req.resume();
          return json(res, 404, { error: "not found" });
        }
        if (!isOwnerAddress(m[1]!)) {
          req.resume();
          return json(res, 400, { error: "invalid owner address" });
        }
        const o = m[1]!.toLowerCase() as Hex;
        if (!store.get(o)) {
          req.resume();
          return json(res, 404, { error: "unknown owner" });
        }
        if (isWrite) return await signedWrite(req, res, o, route!, write!.purpose);
        req.resume();
        const port = supervisor.portOf(o);
        if (port === undefined) return json(res, 503, { error: "agent-not-running" });
        // The query string is dropped: no agent read takes one.
        await forward(port, "GET", `/${route}`, undefined, route === "events" ? undefined : READ_TIMEOUT_MS, res);
      } catch (e) {
        log(`gateway: ${req.method} ${req.url} failed: ${errorText(e)}`);
        if (!res.headersSent) json(res, 500, { error: "internal error" });
        else res.end();
      }
    },
  };
}

export type Gateway = ReturnType<typeof createGateway>;
