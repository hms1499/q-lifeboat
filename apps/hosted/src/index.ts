import { join } from "node:path";
import { NETWORK } from "@qday/core";
import { createLimits } from "./limits.ts";
import { createProvisioner, loadFunder, productionChainDeps } from "./provision.ts";
import { createHostedServer } from "./server.ts";
import { createStore } from "./store.ts";

const dataDir = process.env.HOSTED_DATA_DIR ?? join(process.cwd(), "data");
const distDir = process.env.DASHBOARD_DIST ?? join(process.cwd(), "../dashboard/dist");
const port = Number(process.env.PORT ?? 8080);

const store = createStore(dataDir);
const activeGuardians = () => store.list().filter((o) => o.stage === "active").length;
const funder = await loadFunder();
// Owners that took a starter pack stay used and count toward today's cap after a restart.
const limits = createLimits(Date.now, store.list().filter((o) => o.starter === true).map((o) => ({ owner: o.owner, at: o.createdAt })));
const provision = funder
  ? createProvisioner({ store, chain: productionChainDeps(), funder, limits, now: Date.now, log: (l) => console.log(l) })
  : undefined;
if (!funder) console.log("FUNDER_MNEMONIC is not set: onboarding is paused");

const server = createHostedServer({
  distDir,
  restUrl: NETWORK.rest,
  rpcUrl: NETWORK.rpc,
  store,
  provision,
  trustProxy: process.env.TRUST_PROXY === "1",
  status: provision ? () => provision.status() : () => ({ onboarding: "paused", reason: "no-funder", activeGuardians: activeGuardians() }),
});
server.listen(port, () => console.log(`hosted listening on :${port} (data ${dataDir}, dist ${distDir}${funder ? `, funder ${funder.evm}` : ""})`));
