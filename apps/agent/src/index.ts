import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { vaultAbi } from "@qday/core";
import { publicClient } from "@qday/core/chain";
import { checkVaultGuardian, loadAgentConfig } from "./config";
import { createGuardian } from "./guardian";
import { anthropicLlm, signAndRecord } from "./report";
import { productionDeps, rescueAll } from "./rescue";
import { createBatchClient } from "./rpc";
import { startServer } from "./server";
import { watchOwner } from "./watch";
import { createSerial, createWindowKeeper, productionWindowDeps, skipWhileBusy } from "./window";

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const WINDOW_CHECK_MS = 30_000;

async function main() {
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
  const file = resolve(fileURLToPath(import.meta.url), "../../../../data/incidents.jsonl");
  const llm = cfg.anthropicApiKey ? anthropicLlm(cfg.anthropicApiKey) : undefined;
  const server = await startServer({ file, port: cfg.port });
  const deps = productionDeps(cfg, windowKeeper, log);

  const guardian = createGuardian({
    policy: { vault: cfg.vault, allowlist: cfg.allowlist, maxOutbound: cfg.maxOutbound },
    rescue: (trigger) => serial(() => rescueAll(deps, trigger.token)),
    record: (facts) => signAndRecord({ ...facts, sk: cfg.agentKey.sk, llm, log }, file),
    publish: server.publish,
    log,
  });

  watchOwner({
    // Tip + logs in one batched request per tick; native block reads on their own client (never in that batch).
    client: createBatchClient(),
    blockClient: publicClient,
    owner: cfg.owner,
    tokens: Object.values(cfg.tokens),
    pollMs: cfg.pollMs,
    // Not awaited: the watcher keeps polling while a rescue runs (see watch.ts).
    onTx: (tx) => void guardian.onTx(tx).catch((e) => log(`handler error: ${errorText(e)}`)),
    onError: (e) => log(`watch error: ${errorText(e)}`),
    log,
  });

  log(
    `guardian ${cfg.gas.evm} watching ${cfg.owner} -> vault ${cfg.vault} every ${cfg.pollMs} ms; API on :${server.port}; summaries: ${llm ? "claude" : "template"}`,
  );
}

main().catch((e) => {
  console.error(`fatal: ${errorText(e)}`);
  process.exit(1);
});
