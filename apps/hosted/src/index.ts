import { join } from "node:path";
import { NETWORK } from "@qday/core";
import { createHostedServer } from "./server.ts";
import { createStore } from "./store.ts";

const dataDir = process.env.HOSTED_DATA_DIR ?? join(process.cwd(), "data");
const distDir = process.env.DASHBOARD_DIST ?? join(process.cwd(), "../dashboard/dist");
const port = Number(process.env.PORT ?? 8080);

const store = createStore(dataDir);
const server = createHostedServer({
  distDir,
  restUrl: NETWORK.rest,
  rpcUrl: NETWORK.rpc,
  store,
  status: () => ({ onboarding: "open", activeGuardians: store.list().filter((o) => o.stage === "active").length }),
});
server.listen(port, () => console.log(`hosted listening on :${port} (data ${dataDir}, dist ${distDir})`));
