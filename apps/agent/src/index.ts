import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { vaultAbi } from "@qday/core";
import { endpoints, publicClient } from "@qday/core/chain";
import { evmWindowStatus } from "@qorechain/evm";
import type { Hex } from "viem";
import { checkVaultGuardian, loadAgentConfig, publicConfig } from "./config";
import { createDrillRunner } from "./drill";
import { createGuardian } from "./guardian";
import { createHealth } from "./health";
import { createNotifier } from "./notify";
import { createPolicyStore, seedPolicy, toRulesPolicy } from "./policy";
import { guardianCoSigner } from "./cosign";
import { anthropicLlm, signAndRecord } from "./report";
import { productionDeps, rescueAll } from "./rescue";
import { createWatchClient } from "./rpc";
import { startServer } from "./server";
import { watchOwner } from "./watch";
import { createOnDemandWatcher, createSerial, createWindowKeeper, productionWindowDeps, skipWhileBusy } from "./window";

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const WINDOW_CHECK_MS = 30_000;
const ON_DEMAND_TICK_MS = 5_000;
const GAS_CHECK_MS = 60_000;
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const QDAY_DIR = join(homedir(), ".config", "qday");

/** Fire drill (Task 6G): `demo.sh --drill` in its own process group, so stop() and the timeout kill all of it. */
function productionDrill() {
  return createDrillRunner({
    spawn: (cmd, args, opts) => spawn(cmd, args, opts),
    kill: (pid, signal) => process.kill(pid, signal),
    repoRoot: REPO_ROOT,
    runsDir: join(QDAY_DIR, "runs"),
    guardianFile: join(QDAY_DIR, "drill-guardian.env"),
    exists: existsSync,
    readFile: (p) => readFileSync(p, "utf8"),
    listDirs: (p) => (existsSync(p) ? readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) : []),
    appendFile: (p, data) => appendFileSync(p, data, { mode: 0o600 }),
    now: () => new Date(),
    log,
  });
}

async function main() {
  const startedAt = new Date().toISOString();
  const cfg = await loadAgentConfig();
  checkVaultGuardian(await publicClient.readContract({ address: cfg.vault, abi: vaultAbi, functionName: "guardian" }), cfg.gas.evm);

  // Window opening and rescues both use the guardian account's nonce, so they never overlap.
  const serial = createSerial();
  const windowKeeper = createWindowKeeper(productionWindowDeps(cfg, log));
  // "always" (default, the root agent and demo.sh): keep the window open. "on-demand" (hosted guardians): open it
  // only when armed (POST /arm) or when the owner's window is live; rescue still ensures it as a last resort.
  let watcher: ReturnType<typeof createOnDemandWatcher> | undefined;
  let notifyAlert: (msg: string) => void = () => {};
  if (cfg.windowMode === "always") {
    await serial(() => windowKeeper.ensure()); // fail loudly at startup
    // At most one periodic check is running or queued, so a slow REST node cannot pile checks up ahead of a rescue.
    const windowTick = skipWhileBusy(async () => void (await serial(() => windowKeeper.ensure())));
    setInterval(() => void windowTick().catch((e) => log(`window error: ${errorText(e)}`)), WINDOW_CHECK_MS);
  } else {
    // peek/needsOpen stay outside serial (a REST read needs no nonce); only the open is serialised.
    const keeper = {
      peek: windowKeeper.peek,
      needsOpen: windowKeeper.needsOpen,
      ensure: (o?: { blocks?: number; minRemaining?: bigint }) => serial(() => windowKeeper.ensure(o)),
      lastOpen: windowKeeper.lastOpen,
    };
    watcher = createOnDemandWatcher({
      readOwnerWindow: () =>
        evmWindowStatus({ rest: endpoints().rest, address: cfg.ownerCosmos, fetch: (url) => fetch(url, { signal: AbortSignal.timeout(5_000) }) }),
      keeper,
      alert: (m) => notifyAlert(m),
      log,
    });
    await watcher.startup(); // an owner window that is already live gets its guardian window before the agent is ready
    const onDemandTick = skipWhileBusy(() => watcher!.tick());
    setInterval(() => void onDemandTick().catch((e) => log(`on-demand window error: ${errorText(e)}`)), ON_DEMAND_TICK_MS);
  }

  // Incidents: <repo>/data/incidents.jsonl, or INCIDENTS_FILE (a fire drill's own <run dir>/incidents.jsonl).
  const file = cfg.incidentsFile;
  const llm = cfg.anthropicApiKey ? anthropicLlm(cfg.anthropicApiKey) : undefined;
  // Token address → symbol, so the template summary reads "10 fUSD" (the LLM still sees raw facts).
  const tokenLabels = Object.fromEntries(Object.entries(cfg.tokens).map(([sym, addr]) => [addr, sym]));
  // Reports are co-signed by the guardian account (QoreSign: eth_secp256k1 + ML-DSA-87), the vault's immutable guardian.
  // A failure here must not stop the agent (Review Focus 8): reports then go out with the ed25519 signature only.
  let coSigner: ReturnType<typeof guardianCoSigner> | undefined;
  try {
    coSigner = guardianCoSigner(cfg.gas, log);
  } catch (e) {
    log(`report co-signing off: ${errorText(e)}`);
  }

  // The owner's trusted list, one file per owner. ALLOWLIST / MAX_OUTBOUND only seed a missing file; an invalid
  // file stops the agent here. Edits (by hand or PUT /policy) apply to the next trigger, no restart.
  const policyFile = cfg.policyFile;
  const policyStore = createPolicyStore({ file: policyFile, seed: seedPolicy(cfg.allowlist, cfg.maxOutbound), log });

  // Alerts and health are off the rescue path: nothing below is awaited by the guardian's single-flight loop.
  const notifier = createNotifier({ telegram: cfg.telegram, webhookUrl: cfg.webhookUrl, log });
  const health = createHealth({
    guardian: cfg.gas.evm as Hex,
    vault: cfg.vault,
    gasLowWei: cfg.gasLowWei,
    readBalance: () => publicClient.getBalance({ address: cfg.gas.evm as Hex }),
    readWindow: windowKeeper.status,
    channels: notifier.channels,
    notify: notifier.notify,
    log,
    startedAt,
    // On-demand: no guardian window is the normal state while the owner's window is closed.
    windowRequired: watcher ? () => watcher!.ownerLive() !== false : undefined,
  });
  notifyAlert = (m) => {
    health.recordAlert(m);
    void Promise.resolve(notifier.notify({ type: "info", message: m })).catch((e) => log(`alert error: ${errorText(e)}`));
  };
  const gasTick = () => void health.checkGas().catch((e) => log(`gas check error: ${errorText(e)}`));
  gasTick();
  setInterval(gasTick, GAS_CHECK_MS).unref();

  const pub = publicConfig(cfg);
  // The fire drill runner, except in a drill's own agent (demo.sh --drill exports DRILL=1): no drill inside a drill.
  // Review Focus 4: a drill never outlives the agent. Killing its process group stops demo.sh, whose exit trap stops
  // the drill agent.
  const drill = process.env.DRILL?.trim() === "1" ? undefined : productionDrill();
  process.once("exit", () => drill?.stop()); // a fatal error too (stop is synchronous and sends one SIGTERM per run)
  const SIGNAL_EXIT = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 } as const;
  for (const sig of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      drill?.stop();
      process.exit(SIGNAL_EXIT[sig]);
    });
  }
  const server = await startServer({
    file,
    port: cfg.port,
    health: health.snapshot,
    config: () => pub,
    policy: policyStore,
    dashboardOrigins: cfg.dashboardOrigins,
    drill,
    arm: watcher ? (blocks) => watcher.arm(blocks) : undefined,
    log,
  });
  const deps = productionDeps(cfg, windowKeeper, log);

  const guardian = createGuardian({
    // cfg.gas.evm is the vault's guardian: checkVaultGuardian above refuses to start when vault.guardian() differs.
    policy: () => toRulesPolicy(cfg.vault, cfg.gas.evm as Hex, policyStore.get()),
    rescue: (trigger) => serial(() => rescueAll(deps, trigger.token)),
    record: (facts) => signAndRecord({ ...facts, sk: cfg.agentKey.sk, llm, log, coSigner, labels: tokenLabels }, file),
    publish: server.publish,
    notify: notifier.notify,
    log,
  });

  watchOwner({
    // Tip + logs in one batched request per tick; native block reads on their own client (never in that batch).
    client: createWatchClient(),
    blockClient: publicClient,
    owner: cfg.owner,
    tokens: Object.values(cfg.tokens),
    pollMs: cfg.pollMs,
    onTip: health.setTip,
    // Not awaited: the watcher keeps polling while a rescue runs (see watch.ts).
    onTx: (tx) => void guardian.onTx(tx).catch((e) => log(`handler error: ${errorText(e)}`)),
    onError: (e) => log(`watch error: ${errorText(e)}`),
    log,
  });

  const policy = policyStore.get();
  const channels = Object.entries(notifier.channels).filter(([, on]) => on).map(([name]) => name);
  log(`policy ${policyFile}: ${policy.trusted.length} trusted, maxOutbound ${policy.maxOutbound}`);
  log(`incidents ${file}`);
  log(
    `guardian ${cfg.gas.evm} watching ${cfg.owner} -> vault ${cfg.vault} every ${cfg.pollMs} ms; API on :${server.port}; ` +
      `summaries: ${llm ? "claude" : "template"}; alerts: ${channels.length ? channels.join(", ") : "none"}`,
  );
}

main().catch((e) => {
  console.error(`fatal: ${errorText(e)}`);
  process.exit(1);
});
