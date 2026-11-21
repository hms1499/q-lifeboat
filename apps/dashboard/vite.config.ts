import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vitest/config";
import { APP_NAME } from "./src/brand";

/**
 * diana REST (NETWORK.rest in @qday/core; a test checks they agree). It sends no CORS headers, so the browser reads it
 * through this same-origin proxy: /qore-rest/<path> -> <REST>/<path>. The EVM RPC allows any origin and is called direct.
 */
export const DIANA_REST = "https://api-testnet.qore.host";
export const REST_PROXY_PATH = "/qore-rest";

const proxy = {
  [REST_PROXY_PATH]: {
    target: DIANA_REST,
    changeOrigin: true,
    rewrite: (path: string) => path.slice(REST_PROXY_PATH.length) || "/",
  },
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
