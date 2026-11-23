import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { vaultAbi } from "@qday/core";
import { publicClient } from "@qday/core/chain";
import type { Hex } from "viem";
import { checkVaultGuardian, loadAgentConfig, publicConfig } from "./config";
import { createGuardian } from "./guardian";
import { createHealth } from "./health";
import { createNotifier } from "./notify";
import { createPolicyStore, policyFilePath, seedPolicy, toRulesPolicy } from "./policy";
import { anthropicLlm, signAndRecord } from "./report";
import { productionDeps, rescueAll } from "./rescue";
import { createWatchClient } from "./rpc";
import { startServer } from "./server";
import { watchOwner } from "./watch";
import { createSerial, createWindowKeeper, productionWindowDeps, skipWhileBusy } from "./window";

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const WINDOW_CHECK_MS = 30_000;
const GAS_CHECK_MS = 60_000;

async function main() {
  const startedAt = new Date().toISOString();
  const cfg = await loadAgentConfig();
  checkVaultGuardian(await publicClient.readContract({ address: cfg.vault, abi: vaultAbi, functionName: "guardian" }), cfg.gas.evm);

  // Window opening and rescues both use the guardian account's nonce, so they never overlap.
  const serial = createSerial();
  const windowKeeper = createWindowKeeper(productionWindowDeps(cfg, log));
  await serial(() => windowKeeper.ensure()); // fail loudly at startup
  // At most one periodic check is running or queued, so a slow REST node cannot pile checks up ahead of a rescue.
  const windowTick = skipWhileBusy(async () => void (await serial(() => windowKeeper.ensure())));
  setInterval(() => void windowTick().catch((e) => log(`window error: ${errorText(e)}`)), WINDOW_CHECK_MS);

  // data/ lives at the repo root (gitignored), whatever the working directory is.
  const dataDir = resolve(fileURLToPath(import.meta.url), "../../../../data");
  const file = resolve(dataDir, "incidents.jsonl");
  const llm = cfg.anthropicApiKey ? anthropicLlm(cfg.anthropicApiKey) : undefined;

  // The owner's trusted list, one file per owner. ALLOWLIST / MAX_OUTBOUND only seed a missing file; an invalid
  // file stops the agent here. Edits (by hand or PUT /policy) apply to the next trigger, no restart.
  const policyFile = policyFilePath(dataDir, cfg.owner);
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
  });
  const gasTick = () => void health.checkGas().catch((e) => log(`gas check error: ${errorText(e)}`));
  gasTick();
  setInterval(gasTick, GAS_CHECK_MS).unref();

  const pub = publicConfig(cfg);
  const server = await startServer({
    file,
    port: cfg.port,
    health: health.snapshot,
    config: () => pub,
    policy: policyStore,
    dashboardOrigins: cfg.dashboardOrigins,
    log,
  });
  const deps = productionDeps(cfg, windowKeeper, log);

  const guardian = createGuardian({
    // cfg.gas.evm is the vault's guardian: checkVaultGuardian above refuses to start when vault.guardian() differs.
    policy: () => toRulesPolicy(cfg.vault, cfg.gas.evm as Hex, policyStore.get()),
    rescue: (trigger) => serial(() => rescueAll(deps, trigger.token)),
    record: (facts) => signAndRecord({ ...facts, sk: cfg.agentKey.sk, llm, log }, file),
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
  log(
    `guardian ${cfg.gas.evm} watching ${cfg.owner} -> vault ${cfg.vault} every ${cfg.pollMs} ms; API on :${server.port}; ` +
      `summaries: ${llm ? "claude" : "template"}; alerts: ${channels.length ? channels.join(", ") : "none"}`,
  );
}

main().catch((e) => {
  console.error(`fatal: ${errorText(e)}`);
  process.exit(1);
});
