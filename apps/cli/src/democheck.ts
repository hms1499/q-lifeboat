import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadTokens, loadVault } from "@qday/core";
import { erc20Abi, formatUnits, isAddress, type Hex } from "viem";
import type { DrainRecord, ForgedRecord, MisuseRecord } from "./attacker";
import { publicClient } from "./chain";
import { MINT_AMOUNT } from "./fresh";
import { runDirFromEnv } from "./run";

type Env = Record<string, string | undefined>;

/** What demo-check needs from attack.json. */
export type AttackFile = { drains: DrainRecord[]; forged: ForgedRecord; misuse: MisuseRecord };
/** The fields demo-check reads from an incident served on GET /incidents (bigints arrive as strings). */
export type IncidentView = {
  id: string;
  detectedAt: string;
  /** `block` is the trigger tx's block (a decimal string on the wire). */
  trigger: { hash: string; block?: string | number };
  rescues: { token: string; hash: string; amount: string; expected: string; success: boolean }[];
};

export const MAX_BLOCKS = 3n;
/** 80% in basis points. */
export const MIN_KEPT_BP = 8_000n;

export function parseAttackFile(text: string): AttackFile {
  let j: Partial<AttackFile>;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error("attack.json is not valid JSON");
  }
  if (!Array.isArray(j?.drains) || !j.forged || !j.misuse) throw new Error("attack.json has no drains / forged / misuse results");
  return j as AttackFile;
}

const lower = (s: string) => s.toLowerCase();

/** The newest incident whose trigger tx is one of `hashes` (the attack's drains). */
export function pickIncident<T extends Pick<IncidentView, "detectedAt" | "trigger">>(incidents: T[], hashes: string[]): T | undefined {
  const want = new Set(hashes.map(lower));
  return incidents
    .filter((i) => want.has(lower(String(i.trigger?.hash ?? ""))))
    .sort((a, b) => Date.parse(b.detectedAt) - Date.parse(a.detectedAt))[0];
}

/**
 * R: the block of the earliest successful fUSD rescue across ALL of this run's incidents (trigger = one of the
 * drains). A later recheck incident with only failed rescues must not hide a rescue that landed. Undefined when none.
 */
export async function earliestRescueBlock(o: {
  incidents: Pick<IncidentView, "trigger" | "rescues">[];
  hashes: string[];
  fusd: string;
  blockOf: (hash: Hex) => Promise<bigint>;
}): Promise<bigint | undefined> {
  const want = new Set(o.hashes.map(lower));
  const rescues = o.incidents
    .filter((i) => want.has(lower(String(i.trigger?.hash ?? ""))))
    .flatMap((i) => i.rescues.filter((r) => r.success && r.hash && lower(r.token) === lower(o.fusd)).map((r) => r.hash as Hex));
  let earliest: bigint | undefined;
  for (const hash of new Set(rescues)) {
    const block = await o.blockOf(hash);
    if (earliest === undefined || block < earliest) earliest = block;
  }
  return earliest;
}

/** Hashes of the incident's successful rescue txs. */
export function rescueHashes(incident: Pick<IncidentView, "rescues">): Hex[] {
  return incident.rescues.filter((r) => r.success && r.hash).map((r) => r.hash as Hex);
}

/** Drains that the node took but whose receipt the attacker never saw: demo-check fetches their receipts. */
export function drainsWithoutBlock(a: AttackFile): Hex[] {
  return a.drains.filter((d) => d.hash && d.block === undefined).map((d) => d.hash!);
}

const fusd = (v: bigint) => formatUnits(v, 18);
const drainHashes = (a: AttackFile) => a.drains.filter((d) => d.hash).map((d) => d.hash!);

/**
 * The Task 5 verdict for one run. B = earliest block among the drains that landed (as recorded, plus
 * `drainReceiptBlocks` fetched for drains whose receipt the attacker missed) and the incident trigger's block, so a
 * lost receipt never understates the latency. R = block of the earliest successful fUSD
 * rescue across this run's incidents (`earliestRescueBlock`). Kept = what the vault holds plus what the recovery withdraw already paid out to the
 * owner's safe address, over the 100 fUSD the owner started with. Pass: R - B <= 3, kept >= 80%, (a), (b).
 */
export function evaluateRun(i: {
  attack: AttackFile;
  incident?: Pick<IncidentView, "id"> & { trigger?: Partial<IncidentView["trigger"]> };
  /** Blocks of successful receipts fetched for `drainsWithoutBlock(attack)`. */
  drainReceiptBlocks?: bigint[];
  rescueBlock?: bigint;
  vaultFusd: bigint;
  recoveredFusd: bigint;
  attackerFusd: bigint;
  initial?: bigint;
}) {
  const initial = i.initial ?? MINT_AMOUNT;
  const failures: string[] = [];
  const landed = i.attack.drains.filter((d) => d.status === "success" && d.block !== undefined).map((d) => BigInt(d.block!));
  landed.push(...(i.drainReceiptBlocks ?? []));
  const triggerBlock = i.incident?.trigger?.block;
  if (triggerBlock !== undefined && /^\d+$/.test(String(triggerBlock))) landed.push(BigInt(triggerBlock));
  const firstDrainBlock = landed.length ? landed.reduce((a, b) => (b < a ? b : a)) : undefined;
  if (firstDrainBlock === undefined) failures.push("no drain landed");
  if (!i.incident) failures.push("no incident for this run's drains");
  else if (i.rescueBlock === undefined) failures.push("the incident has no successful rescue");

  const blocks = firstDrainBlock !== undefined && i.rescueBlock !== undefined ? i.rescueBlock - firstDrainBlock : undefined;
  if (blocks !== undefined && blocks > MAX_BLOCKS) failures.push(`rescue took ${blocks} blocks (max ${MAX_BLOCKS})`);

  const kept = i.vaultFusd + i.recoveredFusd;
  const keptBp = (kept * 10_000n) / initial;
  const keptPct = (Number(keptBp) / 100).toFixed(2);
  if (keptBp < MIN_KEPT_BP) failures.push(`kept ${keptPct}% (min 80%)`);
  if (!i.attack.forged.pass) failures.push("(a) forged withdraw did not revert with BadSignature");
  if (!i.attack.misuse.pass) failures.push("(b) agent key misuse was not refused by call policy");

  const row = (k: string, v: string) => `${k.padEnd(20)} ${v}`;
  const f = i.attack.forged;
  const m = i.attack.misuse;
  const lines = [
    row("first drain block", firstDrainBlock?.toString() ?? "-"),
    row("rescue block", i.rescueBlock?.toString() ?? "-"),
    row("blocks", blocks !== undefined ? `${blocks} (max ${MAX_BLOCKS})` : "-"),
    row("kept", `${keptPct}% (vault ${fusd(i.vaultFusd)} + recovered ${fusd(i.recoveredFusd)} of ${fusd(initial)} fUSD)`),
    row("attacker fUSD", fusd(i.attackerFusd)),
    row("(a) forged withdraw", `${f.pass ? "PASS" : "FAIL"} (eth_call ${f.revert ?? "no revert"}, tx ${f.hash ?? "-"} ${f.status ?? f.error ?? ""})`),
    row("(b) agent misuse", `${m.pass ? "PASS" : "FAIL"} (tx ${m.tx ?? "-"}: ${m.error ?? m.reason})`),
    row("incident", i.incident?.id ?? "-"),
  ];
  return { pass: failures.length === 0, failures, lines, firstDrainBlock, blocks, keptPct };
}

/** `demo-check --out <file>`: the verdict as JSON, read by the agent's fire drill. Addresses and numbers only. */
export type VerdictFile = {
  runId: string;
  /** "drill" when the run was `demo.sh --drill` (env DRILL=1). */
  mode: "drill" | "demo";
  pass: boolean;
  failures: string[];
  firstDrainBlock: string | null;
  blocks: string | null;
  keptPct: string;
  incident: string | null;
  owner: string;
  vault: string;
  checkedAt: string;
};

/** Build verdict.json from `evaluateRun`'s result. Fields are picked by name, so nothing else in `env` can leak in. */
export function buildVerdictFile(
  r: Pick<ReturnType<typeof evaluateRun>, "pass" | "failures" | "firstDrainBlock" | "blocks" | "keptPct">,
  ctx: { runId: string; incident?: string; owner: string; vault: string; env: Env; now: Date },
): VerdictFile {
  return {
    runId: ctx.runId,
    mode: ctx.env.DRILL?.trim() === "1" ? "drill" : "demo",
    pass: r.pass,
    failures: [...r.failures],
    firstDrainBlock: r.firstDrainBlock?.toString() ?? null,
    blocks: r.blocks?.toString() ?? null,
    keptPct: r.keptPct,
    incident: ctx.incident ?? null,
    owner: ctx.owner,
    vault: ctx.vault,
    checkedAt: ctx.now.toISOString(),
  };
}

/** Write verdict.json with mode 0600 (an existing file keeps its old mode otherwise). The caller picks the path. */
function writeVerdictFile(path: string, v: VerdictFile): void {
  const file = resolve(path);
  writeFileSync(file, JSON.stringify(v, null, 2) + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Poll GET /incidents until one is for these drains, or `timeoutMs` passes. Fetch errors count as "not yet". */
export async function waitForIncident(o: {
  fetchIncidents: () => Promise<IncidentView[]>;
  hashes: string[];
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  intervalMs?: number;
}): Promise<IncidentView | undefined> {
  const end = o.now() + o.timeoutMs;
  for (;;) {
    const found = pickIncident(await o.fetchIncidents().catch(() => []), o.hashes);
    if (found) return found;
    if (o.now() >= end) return undefined;
    await o.sleep(o.intervalMs ?? 1_000);
  }
}

const incidentsUrl = (env: Env) => `http://127.0.0.1:${env.AGENT_PORT?.trim() || "8787"}/incidents`;

async function fetchIncidents(env: Env): Promise<IncidentView[]> {
  const r = await fetch(incidentsUrl(env), { signal: AbortSignal.timeout(5_000) });
  if (!r.ok) throw new Error(`GET /incidents: HTTP ${r.status}`);
  return (await r.json()) as IncidentView[];
}

const balanceOf = (token: Hex, who: Hex) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });

/**
 * `pnpm cli demo-check [--wait <seconds> | --out <file>]`. With --wait: exit 0 once the agent has an incident for
 * this run's drains, 1 on timeout. Without: print the run's verdict and exit 0 only if it passes; --out also writes
 * it as JSON (`VerdictFile`, mode 0600) for a PASS and a FAIL alike.
 */
export async function runDemoCheck(args: string[], env: Env = process.env): Promise<number> {
  const waitIdx = args.indexOf("--wait");
  const outIdx = args.indexOf("--out");
  if (waitIdx >= 0 && outIdx >= 0) throw new Error("usage: demo-check --out <file> writes the verdict; it does not combine with --wait");
  const out = outIdx >= 0 ? args[outIdx + 1] : undefined;
  if (outIdx >= 0 && (!out || out.startsWith("--"))) throw new Error("usage: demo-check --out <file>");

  const runId = env.RUN_ID?.trim() ?? "";
  const attack = parseAttackFile(readFileSync(join(runDirFromEnv(env), "attack.json"), "utf8"));
  const hashes = drainHashes(attack);

  if (waitIdx >= 0) {
    const seconds = Number(args[waitIdx + 1]);
    if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("usage: demo-check --wait <seconds>");
    const found = await waitForIncident({
      fetchIncidents: () => fetchIncidents(env),
      hashes,
      timeoutMs: seconds * 1_000,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: Date.now,
    });
    console.log(found ? `incident ${found.id} (trigger ${found.trigger.hash})` : `no incident for this run's drains after ${seconds} s`);
    return found ? 0 : 1;
  }

  const vault = loadVault(env);
  const { fUSD } = loadTokens(env);
  const attacker = env.ATTACKER_ADDR?.trim();
  if (!attacker || !isAddress(attacker, { strict: false })) throw new Error("ATTACKER_ADDR must be a 0x address");
  const safe = env.SAFE_ADDR?.trim();
  if (safe && !isAddress(safe, { strict: false })) throw new Error("SAFE_ADDR must be a 0x address");

  const incidents = await fetchIncidents(env);
  const incident = pickIncident(incidents, hashes);
  // A drain the attacker sent but never saw a receipt for may still be the first one that landed.
  const drainReceiptBlocks: bigint[] = [];
  for (const hash of drainsWithoutBlock(attack)) {
    const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => undefined);
    if (receipt?.status === "success") drainReceiptBlocks.push(receipt.blockNumber);
  }
  const rescueBlock = await earliestRescueBlock({
    incidents,
    hashes,
    fusd: fUSD,
    blockOf: async (hash) => (await publicClient.getTransactionReceipt({ hash })).blockNumber,
  });
  const r = evaluateRun({
    attack,
    incident,
    drainReceiptBlocks,
    rescueBlock,
    vaultFusd: await balanceOf(fUSD, vault),
    recoveredFusd: safe ? await balanceOf(fUSD, safe as Hex) : 0n,
    attackerFusd: await balanceOf(fUSD, attacker as Hex),
  });
  for (const line of r.lines) console.log(line);
  console.log(r.pass ? "RESULT PASS" : `RESULT FAIL: ${r.failures.join("; ")}`);
  if (out) {
    const owner = env.OWNER_EVM_ADDRESS?.trim() ?? "";
    writeVerdictFile(out, buildVerdictFile(r, { runId, incident: incident?.id, owner, vault, env, now: new Date() }));
  }
  return r.pass ? 0 : 1;
}
