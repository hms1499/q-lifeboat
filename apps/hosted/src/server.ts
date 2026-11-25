import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import type { HostedStatus, OwnerPublicState } from "@qday/core";
import type { Gateway } from "./gateway.ts";
import type { Provisioner } from "./provision.ts";
import { isOwnerAddress, type Store } from "./store.ts";

export type HostedDeps = {
  /** Built dashboard (apps/dashboard/dist). */
  distDir: string;
  /** Upstream diana REST and Tendermint RPC base URLs (no trailing slash needed). */
  restUrl: string;
  rpcUrl: string;
  store: Store;
  /** Injectable so later tasks can add the funder floor check. */
  status: () => HostedStatus | Promise<HostedStatus>;
  fetchImpl?: typeof fetch;
  /** Starter pack, top-up, onboard and activate. Absent (no FUNDER_MNEMONIC): those routes answer 503. */
  provision?: Pick<Provisioner, "starter" | "topup" | "onboard" | "activate">;
  /** TRUST_PROXY=1: the client IP is the right-most X-Forwarded-For entry (appended by the proxy) instead of the socket address. */
  trustProxy?: boolean;
  /** `/api/o/<owner>/*` to the owner's loopback agent. Absent: those routes answer 404. */
  gateway?: Pick<Gateway, "handle">;
};

/** Largest JSON body a provisioning route reads (an ML-DSA-87 signature is ~9.3 KB as hex). */
export const MAX_JSON_BODY = 64 * 1024;

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    // The right-most entry is the hop our trusted proxy appended; entries left of it are client-supplied and forgeable.
    const xff = req.headers["x-forwarded-for"];
    const joined = Array.isArray(xff) ? xff.join(",") : xff;
    const last = joined?.split(",").map((s) => s.trim()).filter(Boolean).at(-1);
    if (last) return last;
  }
  return req.socket.remoteAddress ?? "unknown";
}

/** Read a JSON body of at most MAX_JSON_BODY bytes. Past the cap it drains without buffering. */
export async function readJson(req: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false; code: 400 | 413 }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size <= MAX_JSON_BODY) chunks.push(c as Buffer);
  }
  if (size > MAX_JSON_BODY) return { ok: false, code: 413 };
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    return { ok: false, code: 400 };
  }
}

const PROVISION_ROUTES = new Set(["/api/starter", "/api/topup", "/api/onboard", "/api/activate"]);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".map": "application/json",
  ".txt": "text/plain; charset=utf-8", ".wasm": "application/wasm",
};

/** Same semantics as restProxyRewrite in apps/dashboard/vite.config.ts: strip the prefix only as a whole path segment. */
export const stripPrefix = (prefix: string, path: string): string => {
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return path.replace(new RegExp(`^${esc}(?=/|\\?|$)`), "").replace(/^(?=\?|$)/, "/");
};

const isUnder = (path: string, prefix: string) => path === prefix || path.startsWith(prefix + "/") || path.startsWith(prefix + "?");

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

const HOP = new Set(["connection", "content-length", "content-encoding", "transfer-encoding", "keep-alive"]);

async function proxy(deps: HostedDeps, base: string, target: string, req: IncomingMessage, res: ServerResponse) {
  const f = deps.fetchImpl ?? fetch;
  try {
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const headers: Record<string, string> = {};
    const ct = req.headers["content-type"];
    if (ct) headers["content-type"] = ct;
    const up = await f(base.replace(/\/+$/, "") + target, {
      method: req.method,
      headers,
      body: hasBody ? new Uint8Array(await readBody(req)) : undefined,
    });
    const out: Record<string, string> = {};
    up.headers.forEach((v, k) => { if (!HOP.has(k.toLowerCase())) out[k] = v; });
    res.writeHead(up.status, out);
    res.end(Buffer.from(await up.arrayBuffer()));
  } catch {
    json(res, 502, { error: "upstream unreachable" });
  }
}

function serveStatic(deps: HostedDeps, pathname: string, res: ServerResponse) {
  let file: string | null = null;
  let rel = "";
  try { rel = decodeURIComponent(pathname); } catch { rel = "/"; }
  const root = normalize(deps.distDir);
  const candidate = normalize(join(root, rel));
  if ((candidate === root || candidate.startsWith(root + sep)) && existsSync(candidate) && statSync(candidate).isFile()) file = candidate;
  if (!file) file = join(root, "index.html"); // SPA fallback
  if (!existsSync(file)) { json(res, 404, { error: "dashboard not built" }); return; }
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

export function createHostedServer(deps: HostedDeps): Server {
  return createServer(async (req, res) => {
    try {
      const url = req.url ?? "/";
      const pathname = url.split("?")[0]!;
      if (isUnder(url, "/qore-rest")) return void (await proxy(deps, deps.restUrl, stripPrefix("/qore-rest", url), req, res));
      if (isUnder(url, "/qore-rpc")) return void (await proxy(deps, deps.rpcUrl, stripPrefix("/qore-rpc", url), req, res));
      if (pathname === "/api/status" && req.method === "GET") return json(res, 200, await deps.status());
      if (PROVISION_ROUTES.has(pathname) && req.method === "POST") {
        const p = deps.provision;
        if (!p) return json(res, 503, { error: "onboarding unavailable" });
        const body = await readJson(req);
        if (!body.ok) return json(res, body.code, { error: body.code === 413 ? "body too large" : "invalid json" });
        const r =
          pathname === "/api/starter" ? await p.starter(clientIp(req, deps.trustProxy === true), body.value)
          : pathname === "/api/topup" ? await p.topup(body.value)
          : pathname === "/api/onboard" ? await p.onboard(body.value)
          : await p.activate(body.value);
        return json(res, r.code, r.body);
      }
      const m = /^\/api\/owner\/([^/]+)$/.exec(pathname);
      if (m && req.method === "GET") {
        if (!isOwnerAddress(m[1]!)) return json(res, 400, { error: "invalid owner address" });
        const s = deps.store.get(m[1]!);
        const out: OwnerPublicState = s ? { stage: s.stage, ...(s.guardian ? { guardian: s.guardian } : {}), ...(s.vault ? { vault: s.vault } : {}) } : { stage: "none" };
        return json(res, 200, out);
      }
      if (isUnder(pathname, "/api/o")) {
        if (!deps.gateway) return json(res, 404, { error: "not found" });
        return void (await deps.gateway.handle(req, res));
      }
      if (pathname.startsWith("/api/")) return json(res, 404, { error: "not found" });
      if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });
      serveStatic(deps, pathname, res);
    } catch {
      if (!res.headersSent) json(res, 500, { error: "internal error" });
      else res.end();
    }
  });
}
