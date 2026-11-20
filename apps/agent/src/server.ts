import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { bigintReplacer, type Incident } from "@qday/core";
import { readIncidents } from "./report";

export type Server = { port: number; publish(incident: Incident): void; close(): Promise<void> };

const CORS = { "Access-Control-Allow-Origin": "*" };

/** Read-only HTTP API: GET /incidents (JSON array) and GET /events (SSE, one `incident` event each). */
export async function startServer(opts: { file: string; port: number; host?: string }): Promise<Server> {
  const clients = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "OPTIONS") {
      res.writeHead(204, { ...CORS, "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" }).end();
    } else if (req.method === "GET" && path === "/incidents") {
      res.writeHead(200, { ...CORS, "Content-Type": "application/json" });
      res.end(JSON.stringify(readIncidents(opts.file), bigintReplacer));
    } else if (req.method === "GET" && path === "/events") {
      res.writeHead(200, { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
    } else {
      res.writeHead(404, CORS).end();
    }
  });

  const heartbeat = setInterval(() => clients.forEach((c) => c.write(": heartbeat\n\n")), 15_000);
  heartbeat.unref();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host ?? "127.0.0.1", resolve);
  });

  return {
    port: (server.address() as AddressInfo).port,
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
