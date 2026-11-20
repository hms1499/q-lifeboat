import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { vaultAbi } from "@qday/core";
import { publicClient } from "@qday/core/chain";
import { checkVaultGuardian, loadAgentConfig } from "./config";
import { createGuardian } from "./guardian";
import { anthropicLlm, signAndRecord } from "./report";
import { productionDeps, rescueAll } from "./rescue";
import { startServer } from "./server";
import { watchOwner } from "./watch";
import { createSerial, createWindowKeeper, productionWindowDeps } from "./window";

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

const WINDOW_CHECK_MS = 30_000;

async function main() {
  const cfg = await loadAgentConfig();
  checkVaultGuardian(await publicClient.readContract({ address: cfg.vault, abi: vaultAbi, functionName: "guardian" }), cfg.gas.evm);

  // Window opening and rescues both use the guardian account's nonce, so they never overlap.
  const serial = createSerial();
  const windowKeeper = createWindowKeeper({ ...productionWindowDeps(cfg), log });
  await serial(() => windowKeeper.ensure()); // fail loudly at startup
  setInterval(() => void serial(() => windowKeeper.ensure()).catch((e) => log(`window error: ${errorText(e)}`)), WINDOW_CHECK_MS);

  // data/ lives at the repo root (gitignored), whatever the working directory is.
  const file = resolve(fileURLToPath(import.meta.url), "../../../../data/incidents.jsonl");
  const llm = cfg.anthropicApiKey ? anthropicLlm(cfg.anthropicApiKey) : undefined;
  const server = await startServer({ file, port: cfg.port });
  const deps = productionDeps(cfg, windowKeeper);

  const guardian = createGuardian({
    policy: { vault: cfg.vault, allowlist: cfg.allowlist, maxOutbound: cfg.maxOutbound },
    rescue: () => serial(() => rescueAll(deps)),
    record: (facts) => signAndRecord({ ...facts, sk: cfg.agentKey.sk, llm, log }, file),
    publish: server.publish,
    log,
  });

  watchOwner({
    client: publicClient,
    owner: cfg.owner,
    tokens: Object.values(cfg.tokens),
    // Not awaited: the watcher keeps polling while a rescue runs (see watch.ts).
    onTx: (tx) => void guardian.onTx(tx).catch((e) => log(`handler error: ${errorText(e)}`)),
    onError: (e) => log(`watch error: ${errorText(e)}`),
  });

  log(
    `guardian ${cfg.gas.evm} watching ${cfg.owner} -> vault ${cfg.vault}; API on :${server.port}; summaries: ${llm ? "claude" : "template"}`,
  );
}

main().catch((e) => {
  console.error(`fatal: ${errorText(e)}`);
  process.exit(1);
});
