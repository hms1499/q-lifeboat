import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vitest/config";
import { APP_NAME } from "./src/brand";

/**
 * diana REST and Tendermint RPC (NETWORK.rest / NETWORK.rpc in @qday/core; a test checks they agree). Neither sends CORS
 * headers, so the browser reaches them through these same-origin proxies: /qore-rest/<path> -> <REST>/<path>,
 * /qore-rpc/<path> -> <RPC>/<path> (the hosted service serves the same paths). The EVM RPC allows any origin and is
 * called direct.
 */
export const DIANA_REST = "https://api-testnet.qore.host";
export const DIANA_RPC = "https://rpc-testnet.qore.host";
export const REST_PROXY_PATH = "/qore-rest";
export const RPC_PROXY_PATH = "/qore-rpc";
/** The hosted service (apps/hosted, PORT default 8080) run locally: dev and preview forward /api to it. */
export const HOSTED_DEV_URL = "http://127.0.0.1:8080";

/** Strip `prefix` only as a whole path segment: /qore-rest/x → /x, /qore-rest → /, /qore-restx stays as it is. */
const stripPrefix = (prefix: string) => (path: string) =>
  path.replace(new RegExp(`^${prefix}(?=/|\\?|$)`), "").replace(/^(?=\?|$)/, "/");
export const restProxyRewrite = stripPrefix(REST_PROXY_PATH);
export const rpcProxyRewrite = stripPrefix(RPC_PROXY_PATH);

const proxy = {
  [REST_PROXY_PATH]: { target: DIANA_REST, changeOrigin: true, rewrite: restProxyRewrite },
  [RPC_PROXY_PATH]: { target: DIANA_RPC, changeOrigin: true, rewrite: rpcProxyRewrite },
  "/api": { target: HOSTED_DEV_URL, changeOrigin: false },
};

/** index.html's <title> comes from APP_NAME too (main.tsx also sets it at runtime). */
const appName = (): Plugin => ({
  name: "qday-app-name",
  transformIndexHtml: (html) => html.replace("%APP_NAME%", APP_NAME.replace(/[<>&"]/g, "")),
});

export default defineConfig({
  plugins: [react(), appName()],
  // 5173 is the origin the agent allows to write /policy (DEFAULT_DASHBOARD_ORIGINS): never drift to another port.
  server: { host: "127.0.0.1", port: 5173, strictPort: true, proxy },
  preview: { host: "127.0.0.1", port: 5173, strictPort: true, proxy },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
