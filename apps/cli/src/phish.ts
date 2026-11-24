import { loadOwner, loadTokens, loadVault, NETWORK } from "@qday/core";
import { evmWindowCost, evmWindowStatus } from "@qorechain/evm";
import { openEvmWindowMsg, type UnifiedAccount } from "@qorechain/sdk";
import { createWalletClient, erc20Abi, formatUnits, http, maxUint256, parseAbiItem, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadMisuseRelayer } from "./attacker";
import { broadcast, chain, publicClient } from "./chain";
import { runDirFromEnv, writeRunFile } from "./run";

type Env = Record<string, string | undefined>;
type Bal = { owner: bigint; vault: bigint; drainer: bigint };
type TxRecord = { hash?: Hex; block?: string; status?: "success" | "reverted"; error?: string };

/** A TestToken transferFrom to a holder is ~55k gas; diana bills >= 50% of the limit (chain fact 5). */
export const PHISH_TRANSFER_GAS = 80_000n;
const APPROVE_GAS = 100_000n;
/** The same rescue bar as `demo-check`: rescue at most 3 blocks after the trigger, at least 80% kept. */
const MAX_BLOCKS = 3n;
const MIN_KEPT_PERMILLE = 800n;
/** The drainer's window: 2 txs (its transferFrom plus one spare), 300 blocks (~7 min), scoped to fUSD only. */
const DRAINER_WINDOW = { blocks: 300, txs: 2 };
const PER_TX_BUDGET = evmWindowCost({ gas: 3_000_000n, maxFeePerGas: 112_500_000_000n });
const RECEIPT_POLL_MS = 250;
const RECEIPT_TIMEOUT_MS = 60_000;

export type PhishDeps = {
  log(line: string): void;
  /** The drainer's EVM address (the spender the owner is tricked into approving). */
  drainer: Hex;
  /** fUSD balances of the owner, the vault and the drainer. */
  balances(): Promise<Bal>;
  /** The drainer's own EVM window, scoped to fUSD (every EVM tx on diana needs one, chain fact 17). */
  openDrainerWindow(): Promise<string>;
  /** fUSD.approve(drainer, max) signed by the owner: the phishing signature. */
  sendApprove(): Promise<Hex>;
  /** fUSD.transferFrom(owner, drainer, amount) from the drainer. */
  sendTransferFrom(amount: bigint): Promise<Hex>;
  waitReceipt(hash: Hex): Promise<{ status: "success" | "reverted"; blockNumber: bigint }>;
  /** Wait until the chain tip is at least `block` (a slower drainer, `--drainer-delay`). */
  waitBlock(block: bigint): Promise<void>;
  /** Wait until the chain is a few blocks past the approval, so a rescue (or its absence) is final. */
  settle(approveBlock: bigint): Promise<void>;
  /** The first fUSD Transfer(owner -> vault) at or after `fromBlock`: the Guardian's rescue. */
  findRescue(fromBlock: bigint): Promise<{ hash: Hex; block: bigint } | null>;
};

export type PhishVerdict = { pass: boolean; drained: string; rescued: string; keptPct: string; blocks: string | null; failures: string[] };
export type PhishResult = {
  /** Blocks the drainer waited after the approval's block before pulling (0: at once, the worst case). */
  drainerDelayBlocks: number;
  drainerWindow: string;
  approve: TxRecord;
  transferFrom: TxRecord;
  rescue: { hash: Hex; block: string } | null;
  before: Record<keyof Bal, string>;
  after: Record<keyof Bal, string>;
  verdict: PhishVerdict;
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const str = (b: Bal) => ({ owner: b.owner.toString(), vault: b.vault.toString(), drainer: b.drainer.toString() });

async function sendAndWait(deps: PhishDeps, send: () => Promise<Hex>): Promise<TxRecord> {
  let hash: Hex;
  try {
    hash = await send();
  } catch (e) {
    return { error: errorText(e) };
  }
  try {
    const r = await deps.waitReceipt(hash);
    return { hash, block: r.blockNumber.toString(), status: r.status };
  } catch (e) {
    return { hash, error: errorText(e) };
  }
}

/** PASS: the drainer gained nothing, the vault kept >= 80% of what the owner held, the rescue within 3 blocks. */
export function phishVerdict(before: Bal, after: Bal, approveBlock: bigint | null, rescueBlock: bigint | null): PhishVerdict {
  const drained = after.drainer > before.drainer ? after.drainer - before.drainer : 0n;
  const rescued = after.vault > before.vault ? after.vault - before.vault : 0n;
  const permille = before.owner > 0n ? (rescued * 1000n) / before.owner : 0n;
  const keptPct = `${(Number((rescued * 10000n) / (before.owner || 1n)) / 100).toFixed(2)}`;
  const blocks = approveBlock !== null && rescueBlock !== null ? rescueBlock - approveBlock : null;
  const failures: string[] = [];
  if (drained > 0n) failures.push(`the drainer took ${formatUnits(drained, 18)} fUSD`);
  if (rescueBlock === null) failures.push("no rescue into the vault");
  else if (blocks !== null && blocks > MAX_BLOCKS) failures.push(`rescue ${blocks} blocks after the approval (max ${MAX_BLOCKS})`);
  if (permille < MIN_KEPT_PERMILLE) failures.push(`${keptPct}% kept (min 80%)`);
  return { pass: failures.length === 0, drained: drained.toString(), rescued: rescued.toString(), keptPct, blocks: blocks?.toString() ?? null, failures };
}

/**
 * Approval phishing, the video's first act. The owner signs `approve(drainer, max)` (a phishing site's request), and
 * the drainer sends `transferFrom(owner, drainer, balance)` the moment the approval has a receipt: the worst case, no
 * delay. The Guardian sees the `Approval` to an untrusted spender (Task 6B) and races it with `vault.rescue`. The
 * result is reported as it happened, whoever wins.
 */
export async function phish(deps: PhishDeps, opts: { drainerDelayBlocks?: number } = {}): Promise<PhishResult> {
  const drainerDelayBlocks = opts.drainerDelayBlocks ?? 0;
  const before = await deps.balances();
  if (before.owner === 0n) throw new Error("the owner holds no fUSD: nothing to phish (run fresh-owner and setup first)");

  const drainerWindow = await deps.openDrainerWindow();
  deps.log(`drainer ${deps.drainer} window (scoped to fUSD): ${drainerWindow}`);

  const approve = await sendAndWait(deps, () => deps.sendApprove());
  deps.log(`owner approve(drainer, max): ${approve.hash ?? "-"} block ${approve.block ?? "-"} ${approve.status ?? approve.error ?? ""}`);
  if (approve.status !== "success" || approve.block === undefined) {
    const after = await deps.balances();
    const verdict = phishVerdict(before, after, null, null);
    verdict.pass = false;
    verdict.failures.unshift(`the owner's approve did not land (${approve.error ?? approve.status ?? "no receipt"})`);
    return { drainerDelayBlocks, drainerWindow, approve, transferFrom: {}, rescue: null, before: str(before), after: str(after), verdict };
  }

  // Worst case (delay 0): the drainer fires at once, for everything the owner held, without re-reading.
  const approveBlock = BigInt(approve.block);
  if (drainerDelayBlocks > 0) {
    await deps.waitBlock(approveBlock + BigInt(drainerDelayBlocks));
    deps.log(`drainer waited until block ${approveBlock + BigInt(drainerDelayBlocks)} (--drainer-delay ${drainerDelayBlocks})`);
  }
  const transferFrom = await sendAndWait(deps, () => deps.sendTransferFrom(before.owner));
  deps.log(`drainer transferFrom(owner, drainer, ${formatUnits(before.owner, 18)}): ${transferFrom.hash ?? "-"} block ${transferFrom.block ?? "-"} ${transferFrom.status ?? transferFrom.error ?? ""}`);

  await deps.settle(approveBlock);
  const found = await deps.findRescue(approveBlock);
  const rescue = found ? { hash: found.hash, block: found.block.toString() } : null;
  deps.log(`guardian rescue: ${rescue ? `${rescue.hash} block ${rescue.block}` : "none found"}`);
  const after = await deps.balances();
  const verdict = phishVerdict(before, after, approveBlock, found?.block ?? null);
  // No race took place unless the drainer's pull was mined (reverted or not): never a PASS on a pull that never ran.
  if (transferFrom.status === undefined) {
    verdict.pass = false;
    verdict.failures.unshift(`the drainer's transferFrom was not mined (${transferFrom.error ?? "no receipt"})`);
  }
  return { drainerDelayBlocks, drainerWindow, approve, transferFrom, rescue, before: str(before), after: str(after), verdict };
}

const USAGE = "usage: phish [--drainer-delay <blocks 0-20>]";

/** `phish [--drainer-delay N]`: N blocks the drainer waits after the approval (default 0, the worst case). */
export function parsePhishArgs(args: string[]): { drainerDelayBlocks: number } {
  if (args.length === 0) return { drainerDelayBlocks: 0 };
  if (args.length !== 2 || args[0] !== "--drainer-delay" || !/^\d+$/.test(args[1]!)) throw new Error(USAGE);
  const n = Number(args[1]);
  if (n > 20) throw new Error(`--drainer-delay is 0 to 20 blocks (${USAGE})`);
  return { drainerDelayBlocks: n };
}

/** Refuse a drainer the agent trusts (an approval to it would not trigger) or one that is the owner itself. */
export function checkDrainer(drainer: string, owner: string, trusted: { address: string }[]): void {
  const lc = drainer.toLowerCase();
  if (lc === owner.toLowerCase()) throw new Error("the drainer (FUNDER_MNEMONIC) is the owner: use a separate funder");
  if (trusted.some((t) => t.address.toLowerCase() === lc)) {
    throw new Error(`the drainer ${drainer} is on the agent's trusted list: an approval to it would not trigger a rescue`);
  }
}

/** Refuse an agent on AGENT_PORT that watches another owner: it would never see this run's approval. */
export function checkAgentOwner(agentOwner: string, owner: string): void {
  if (agentOwner.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(`the agent on AGENT_PORT watches ${agentOwner}, not this run's owner ${owner}: start this run's agent first`);
  }
}

async function readJson<T>(port: string, path: string): Promise<T> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!res.ok) throw new Error(`GET ${path} answered HTTP ${res.status}`);
  return (await res.json()) as T;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil<T>(read: () => Promise<T>, ok: (v: T) => boolean, what: string, timeoutMs = 60_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await read().catch(() => undefined);
    if (v !== undefined && ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

function productionDeps(env: Env, owner: UnifiedAccount, drainer: UnifiedAccount): PhishDeps {
  const vault = loadVault(env);
  const { fUSD } = loadTokens(env);
  const ownerHex = owner.evm as Hex;
  const drainerHex = drainer.evm as Hex;
  const ownerWallet = createWalletClient({ account: privateKeyToAccount(owner.privateKey as Hex), chain, transport: http() });
  const drainerWallet = createWalletClient({ account: privateKeyToAccount(drainer.privateKey as Hex), chain, transport: http() });
  const bal = (who: Hex) => publicClient.readContract({ address: fUSD, abi: erc20Abi, functionName: "balanceOf", args: [who] });
  return {
    log: (line) => console.log(line),
    drainer: drainerHex,
    balances: async () => {
      const [o, v, d] = await Promise.all([bal(ownerHex), bal(vault), bal(drainerHex)]);
      return { owner: o, vault: v, drainer: d };
    },
    openDrainerWindow: async () => {
      const params = {
        sender: drainer.cosmos,
        blocks: DRAINER_WINDOW.blocks,
        maxTxs: DRAINER_WINDOW.txs,
        maxValue: (PER_TX_BUDGET * BigInt(DRAINER_WINDOW.txs)).toString(),
        allowedTargets: [fUSD],
      };
      const nonceBefore = await publicClient.getTransactionCount({ address: drainerHex, blockTag: "pending" });
      const hash = await broadcast(drainer, [openEvmWindowMsg(params)], "qday: phishing demo drainer window");
      await waitUntil(async () => (await evmWindowStatus({ rest: NETWORK.rest, address: drainer.cosmos })).live, (l) => l, "the drainer's window");
      // A cosmos tx advances the account's EVM nonce: wait until the EVM RPC sees it, or the transferFrom collides.
      await waitUntil(() => publicClient.getTransactionCount({ address: drainerHex, blockTag: "pending" }), (n) => n > nonceBefore, "the drainer's EVM nonce");
      return hash;
    },
    sendApprove: () => ownerWallet.writeContract({ address: fUSD, abi: erc20Abi, functionName: "approve", args: [drainerHex, maxUint256], gas: APPROVE_GAS }),
    // An explicit gas limit skips estimation, so a transferFrom that would revert is still mined (and recorded).
    sendTransferFrom: (amount) =>
      drainerWallet.writeContract({ address: fUSD, abi: erc20Abi, functionName: "transferFrom", args: [ownerHex, drainerHex, amount], gas: PHISH_TRANSFER_GAS }),
    waitReceipt: (hash) => publicClient.waitForTransactionReceipt({ hash, pollingInterval: RECEIPT_POLL_MS, timeout: RECEIPT_TIMEOUT_MS }),
    waitBlock: async (block) => {
      await waitUntil(() => publicClient.getBlockNumber({ cacheTime: 0 }), (n) => n >= block, `block ${block}`);
    },
    settle: async (approveBlock) => {
      await waitUntil(() => publicClient.getBlockNumber({ cacheTime: 0 }), (n) => n >= approveBlock + MAX_BLOCKS + 1n, "the chain to pass the rescue bar");
    },
    findRescue: async (fromBlock) => {
      const logs = await publicClient.getLogs({
        address: fUSD,
        event: parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)"),
        args: { from: ownerHex, to: vault },
        fromBlock,
        toBlock: "latest",
      });
      const first = logs[0];
      return first?.transactionHash && first.blockNumber !== null ? { hash: first.transactionHash, block: first.blockNumber } : null;
    },
  };
}

/** `pnpm cli phish`: run the approval-phishing act on the run's owner and write `phish.json` in the run dir. */
export async function runPhish(args: string[] = [], env: Env = process.env): Promise<boolean> {
  const { drainerDelayBlocks } = parsePhishArgs(args);
  const dir = runDirFromEnv(env);
  const owner = await loadOwner(env);
  const drainer = await loadMisuseRelayer(env); // the funder: never the guardian, so the agent's nonce stays free
  const port = env.AGENT_PORT?.trim() || "8787";
  checkAgentOwner((await readJson<{ owner: string }>(port, "/config")).owner, owner.evm);
  checkDrainer(drainer.evm, owner.evm, (await readJson<{ trusted?: { address: string }[] }>(port, "/policy")).trusted ?? []);
  const when = drainerDelayBlocks ? `${drainerDelayBlocks} block(s) after the approval` : "at once";
  console.log(`approval phishing on ${owner.evm}: the owner approves ${drainer.evm} (drainer), which pulls ${when}`);
  const result = await phish(productionDeps(env, owner, drainer), { drainerDelayBlocks });
  const file = writeRunFile(dir, "phish.json", `${JSON.stringify({ runId: env.RUN_ID, owner: owner.evm, drainer: drainer.evm, ...result }, null, 2)}\n`);
  const v = result.verdict;
  console.log(
    `RESULT ${v.pass ? "PASS" : "FAIL"} (drainer delay ${drainerDelayBlocks} block(s)): rescue ${v.blocks ?? "-"} block(s) after the approval, ${v.keptPct}% kept, drainer got ${formatUnits(BigInt(v.drained), 18)} fUSD` +
      (v.failures.length ? ` (${v.failures.join("; ")})` : ""),
  );
  console.log(`wrote ${file}`);
  return v.pass;
}
