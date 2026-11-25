import { join } from "node:path";
import { NETWORK } from "@qday/core";
import { createOwnerAuth } from "./auth.ts";
import { createGateway } from "./gateway.ts";
import { createLimits } from "./limits.ts";
import { createProvisioner, loadFunder, productionChainDeps } from "./provision.ts";
import { createHostedServer } from "./server.ts";
import { createStore } from "./store.ts";
import { agentBaseEnv, createGuardianSweeper, createSupervisor, spawnAgent, systemClock } from "./supervisor.ts";

const dataDir = process.env.HOSTED_DATA_DIR ?? join(process.cwd(), "data");
const distDir = process.env.DASHBOARD_DIST ?? join(process.cwd(), "../dashboard/dist");
const port = Number(process.env.PORT ?? 8080);
/** How often idle owners are looked for (retirement itself needs 7 idle days). */
const RETIRE_CHECK_MS = 60 * 60 * 1000;

const log = (l: string) => console.log(`${new Date().toISOString()} ${l}`);
const store = createStore(dataDir);
const activeGuardians = () => store.list().filter((o) => o.stage === "active").length;
const funder = await loadFunder();
const chain = productionChainDeps();
// One replay set for every signed request, provisioning and gateway alike.
const auth = createOwnerAuth({ pqcStatus: (c) => chain.pqcStatus(c), now: Date.now, log });
// Owners that took a starter pack stay used and count toward today's cap after a restart.
const limits = createLimits(Date.now, store.list().filter((o) => o.starter === true).map((o) => ({ owner: o.owner, at: o.createdAt })));

// Fails at boot when FUSD/FETH/FBTC_ADDRESS are missing: an agent could not start without them.
const baseEnv = agentBaseEnv(process.env);
let provision: ReturnType<typeof createProvisioner> | undefined;
const supervisor = createSupervisor({
  spawn: spawnAgent(log),
  store,
  clock: systemClock,
  log,
  baseEnv,
  sweep: funder ? createGuardianSweeper({ store, chain, funderCosmos: funder.cosmos }) : undefined,
  refund: funder ? (o) => provision!.refundGuardian(o) : undefined,
});
provision = funder
  ? createProvisioner({ store, chain, funder, limits, auth, now: Date.now, log, onActivated: async (o) => {
        const r = await supervisor.start(o);
        if (!r.ok) log(`owner ${o}: active, but its agent did not start (${r.reason})`);
      } })
  : undefined;
if (!funder) log("FUNDER_MNEMONIC is not set: onboarding, re-funds and sweeps are paused");

// Kill every agent with the service: a SIGTERM to this process alone would leave them running.
process.once("exit", () => supervisor.shutdown());
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(sig, () => {
    supervisor.shutdown();
    process.exit({ SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }[sig]);
  });
}

const gateway = createGateway({ store, supervisor, auth, now: Date.now, log });
const server = createHostedServer({
  distDir,
  restUrl: NETWORK.rest,
  rpcUrl: NETWORK.rpc,
  store,
  provision,
  gateway,
  trustProxy: process.env.TRUST_PROXY === "1",
  status: provision ? () => provision!.status() : () => ({ onboarding: "paused", reason: "no-funder", activeGuardians: activeGuardians() }),
});
server.listen(port, () => log(`hosted listening on :${port} (data ${dataDir}, dist ${distDir}${funder ? `, funder ${funder.evm}` : ""})`));

await supervisor.resumeAll();
log(`resumed ${supervisor.running()} agent(s)`);
const retire = () => void supervisor.retireIdle(Math.floor(Date.now() / 1000)).catch((e) => log(`retireIdle failed: ${e instanceof Error ? e.message : String(e)}`));
retire();
setInterval(retire, RETIRE_CHECK_MS).unref();
