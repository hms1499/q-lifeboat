import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type Incident } from "@qday/core";
import { bigintReplacer } from "@qday/core/chain";
import type { PolicyFile } from "./policy";
import { readIncidents } from "./report";

export type Server = { port: number; address: string; publish(incident: Incident): void; close(): Promise<void> };

export type ServerOptions = {
  file: string;
  port: number;
  /** Must be loopback (127.0.0.1, ::1 or localhost). Default 127.0.0.1. */
  host?: string;
  /** GET /health body (cached values only). */
  health?: () => unknown;
  /** GET/PUT /policy. */
  policy?: { get(): PolicyFile; set(input: unknown): PolicyFile };
  /** Origins allowed to read and write /policy from a browser (the dashboard). */
  dashboardOrigins?: string[];
};

const CORS = { "Access-Control-Allow-Origin": "*" };
const LOOPBACK_HOSTS = ["127.0.0.1", "::1", "localhost"];
const MAX_POLICY_BODY = 64 * 1024;

const isLoopbackPeer = (a: string | undefined) =>
  !!a && (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a) || a === "::1" || /^::ffff:127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i.test(a));

export type PolicyWriteRequest = { remoteAddress?: string; host?: string; origin?: string; contentType?: string };

/**
 * Review Focus 6: who may replace the trusted list. A loopback bind alone is not enough, since any web page the owner
 * opens can send requests to 127.0.0.1 (CSRF) or reach it under its own name (DNS rebinding). Returns null when the
 * write is allowed, else the refusal. An absent Origin is allowed (curl, the CLI): browsers always send one on a PUT.
 */
export function checkPolicyWrite(
  req: PolicyWriteRequest,
  opts: { port: number; origins: string[] },
): { status: number; error: string } | null {
  if (!isLoopbackPeer(req.remoteAddress)) return { status: 403, error: "policy writes are accepted from loopback only" };
  const hosts = [`127.0.0.1:${opts.port}`, `localhost:${opts.port}`, `[::1]:${opts.port}`];
  if (!req.host || !hosts.includes(req.host.toLowerCase())) return { status: 403, error: "unexpected Host header" };
  if (req.origin !== undefined && !opts.origins.includes(req.origin)) return { status: 403, error: "origin not allowed" };
  const type = (req.contentType ?? "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return { status: 415, error: "Content-Type must be application/json" };
  return null;
}

/** Read a body of at most `limit` bytes; null when it is larger (the rest is drained, not buffered). */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? 0);
    let size = 0;
    let tooBig = declared > limit;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) tooBig = true;
      if (!tooBig) chunks.push(c);
    });
    req.on("end", () => resolve(tooBig ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * HTTP API on loopback: GET /incidents (JSON array), GET /events (SSE, one `incident` event each), GET /health, and
 * GET/PUT /policy (the trusted list). Only PUT /policy writes, and only behind `checkPolicyWrite`.
 */
export async function startServer(opts: ServerOptions): Promise<Server> {
  const host = opts.host ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.includes(host)) throw new Error(`the agent API binds loopback only (127.0.0.1, ::1, localhost), not "${host}"`);
  const origins = opts.dashboardOrigins ?? [];
  let boundPort = opts.port;
  const clients = new Set<ServerResponse>();

  const json = (res: ServerResponse, status: number, headers: Record<string, string>, body: unknown) =>
    res.writeHead(status, { ...headers, "Content-Type": "application/json" }).end(JSON.stringify(body, bigintReplacer));

  /** /policy CORS: only a dashboard origin is named (never `*`). */
  const policyCors = (origin: string | undefined): Record<string, string> =>
    origin !== undefined && origins.includes(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {};

  async function putPolicy(req: IncomingMessage, res: ServerResponse, cors: Record<string, string>, policy: NonNullable<ServerOptions["policy"]>) {
    const refused = checkPolicyWrite(
      { remoteAddress: req.socket.remoteAddress, host: req.headers.host, origin: req.headers.origin, contentType: req.headers["content-type"] },
      { port: boundPort, origins },
    );
    if (refused) {
      req.resume();
      return json(res, refused.status, cors, { error: refused.error });
    }
    const body = await readBody(req, MAX_POLICY_BODY);
    if (body === null) return json(res, 413, cors, { error: `body larger than ${MAX_POLICY_BODY} bytes` });
    let input: unknown;
    try {
      input = JSON.parse(body);
    } catch {
      return json(res, 400, cors, { error: "body is not valid JSON" });
    }
    try {
      return json(res, 200, cors, policy.set(input));
    } catch (e) {
      return json(res, 400, cors, { error: e instanceof Error ? e.message : String(e) });
    }
  }

  function route(req: IncomingMessage, res: ServerResponse) {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/policy") {
      const cors = policyCors(req.headers.origin);
      if (req.method === "OPTIONS") {
        res.writeHead(204, { ...cors, "Access-Control-Allow-Methods": "GET, PUT, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }).end();
      } else if (!opts.policy) {
        res.writeHead(404, cors).end();
      } else if (req.method === "GET") {
        json(res, 200, cors, opts.policy.get());
      } else if (req.method === "PUT") {
        putPolicy(req, res, cors, opts.policy).catch(() => {
          if (!res.headersSent) json(res, 500, cors, { error: "internal error" });
        });
      } else {
        res.writeHead(405, cors).end();
      }
    } else if (req.method === "OPTIONS") {
      res.writeHead(204, { ...CORS, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" }).end();
    } else if (req.method === "GET" && path === "/incidents") {
      json(res, 200, CORS, readIncidents(opts.file));
    } else if (req.method === "GET" && path === "/health" && opts.health) {
      json(res, 200, CORS, opts.health());
    } else if (req.method === "GET" && path === "/events") {
      res.writeHead(200, { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
    } else {
      res.writeHead(404, CORS).end();
    }
  }

  // A throwing provider (health, policy, incidents) answers 500; it must never become an uncaught exception that
  // takes the agent, and its rescue loop, down.
  const server = createServer((req, res) => {
    try {
      route(req, res);
    } catch {
      if (!res.headersSent) res.writeHead(500, CORS);
      res.end();
    }
  });

  const heartbeat = setInterval(() => clients.forEach((c) => c.write(": heartbeat\n\n")), 15_000);
  heartbeat.unref();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, resolve);
  });
  const bound = server.address() as AddressInfo;
  boundPort = bound.port;

  return {
    port: bound.port,
    address: bound.address,
    publish(incident) {
      const frame = `event: incident\ndata: ${JSON.stringify(incident, bigintReplacer)}\n\n`;
      clients.forEach((c) => c.write(frame));
    },
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        clients.forEach((c) => c.end());
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
