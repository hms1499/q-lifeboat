import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import type { HostedStatus, OwnerPublicState } from "@qday/core";
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
};

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
      const m = /^\/api\/owner\/([^/]+)$/.exec(pathname);
      if (m && req.method === "GET") {
        if (!isOwnerAddress(m[1]!)) return json(res, 400, { error: "invalid owner address" });
        const s = deps.store.get(m[1]!);
        const out: OwnerPublicState = s ? { stage: s.stage, ...(s.guardian ? { guardian: s.guardian } : {}), ...(s.vault ? { vault: s.vault } : {}) } : { stage: "none" };
        return json(res, 200, out);
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
