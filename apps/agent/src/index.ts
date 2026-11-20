import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publicClient } from "@qday/core/chain";
import { loadAgentConfig } from "./config";
import { createGuardian } from "./guardian";
import { anthropicLlm, signAndRecord } from "./report";
import { productionDeps, rescueAll } from "./rescue";
import { startServer } from "./server";
import { watchOwner } from "./watch";

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

async function main() {
  const cfg = await loadAgentConfig();
  // data/ lives at the repo root (gitignored), whatever the working directory is.
  const file = resolve(fileURLToPath(import.meta.url), "../../../../data/incidents.jsonl");
  const llm = cfg.anthropicApiKey ? anthropicLlm(cfg.anthropicApiKey) : undefined;
  const server = await startServer({ file, port: cfg.port });
  const deps = productionDeps(cfg);

  const guardian = createGuardian({
    policy: { vault: cfg.vault, allowlist: cfg.allowlist, maxOutbound: cfg.maxOutbound },
    rescue: () => rescueAll(deps),
    record: (facts) => signAndRecord({ ...facts, sk: cfg.agentKey.sk, llm, log }, file),
    publish: server.publish,
    log,
  });

  watchOwner({
    client: publicClient,
    owner: cfg.owner,
    tokens: Object.values(cfg.tokens),
    // Not awaited: the watcher keeps polling while a rescue runs (see watch.ts).
    onTx: (tx) => void guardian.onTx(tx).catch((e) => log(`handler error: ${e instanceof Error ? e.message : String(e)}`)),
    onError: (e) => log(`watch error: ${e instanceof Error ? e.message : String(e)}`),
  });

  log(`guardian watching ${cfg.owner} -> vault ${cfg.vault}; API on :${server.port}; summaries: ${llm ? "claude" : "template"}`);
}

main().catch((e) => {
  console.error(`fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
