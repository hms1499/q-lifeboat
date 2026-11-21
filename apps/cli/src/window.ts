import { loadOwner, loadTokens, loadVault, NETWORK, vaultAbi } from "@qday/core";
import { evmWindowCost, evmWindowStatus, MAX_EVM_WINDOW_BLOCKS, MAX_EVM_WINDOW_TXS } from "@qorechain/evm";
import { closeEvmWindowMsg, openEvmWindowMsg } from "@qorechain/sdk";
import type { Hex } from "viem";
import { broadcast, publicClient } from "./chain";

type Env = Record<string, string | undefined>;
type Tokens = { fUSD: string; fETH: string; fBTC: string };

/** ~42 min at 1.4 s blocks: room to click MetaMask txs by hand (600 blocks ran out mid-session). */
export const OWNER_WINDOW_BLOCKS = 1800;
/** A recover withdraw, a manual rescue, an approve or a guardian top-up each take one. */
export const OWNER_WINDOW_TXS = 5;
/** Same per-tx budget as `setup`: a 3M-gas tx at 112.5 gwei. */
const PER_TX_GAS = 3_000_000n;
const PER_TX_MAX_FEE = 112_500_000_000n;

export type WindowArgs = { action: "open"; blocks: number; txs: number } | { action: "close" };

const USAGE = "usage: window open [--blocks N] [--txs N] | window close";

function readInt(name: string, raw: string | undefined, max: bigint): number {
  if (raw === undefined || !/^\d+$/.test(raw)) throw new Error(`${name} needs a positive integer (${USAGE})`);
  const n = BigInt(raw);
  if (n < 1n || n > max) throw new Error(`${name} must be between 1 and ${max}`);
  return Number(n);
}

/** `window open [--blocks N] [--txs N]` or `window close`. Throws on anything else. */
export function parseWindowArgs(args: string[]): WindowArgs {
  const [action, ...rest] = args;
  if (action === "close") {
    if (rest.length) throw new Error(USAGE);
    return { action: "close" };
  }
  if (action !== "open") throw new Error(USAGE);
  let blocks: number | undefined;
  let txs: number | undefined;
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    if (flag === "--blocks" && blocks === undefined) blocks = readInt("--blocks", rest[i + 1], MAX_EVM_WINDOW_BLOCKS);
    else if (flag === "--txs" && txs === undefined) txs = readInt("--txs", rest[i + 1], MAX_EVM_WINDOW_TXS);
    else throw new Error(`unexpected "${flag}" (${USAGE})`);
  }
  return { action: "open", blocks: blocks ?? OWNER_WINDOW_BLOCKS, txs: txs ?? OWNER_WINDOW_TXS };
}

/**
 * The owner's hand-driven window: scoped to the three tokens, the vault and the guardian, so a withdraw, a manual
 * rescue, an approve and a QOR top-up of the guardian fit, and nothing else. `maxValue` covers fees only: against a
 * leaked ECDSA key the window budget is the only cap (chain fact 4), so it carries no value headroom.
 */
export function buildOwnerWindowParams(ownerCosmos: string, tokens: Tokens, vault: string, guardian: string, size: { blocks: number; txs: number }) {
  const allowedTargets = [tokens.fUSD, tokens.fETH, tokens.fBTC, vault, guardian];
  const seen = new Set(allowedTargets.map((t) => t.toLowerCase()));
  if (seen.size !== allowedTargets.length) throw new Error(`window targets contain a duplicate address: ${allowedTargets.join(", ")}`);
  const perTx = evmWindowCost({ gas: PER_TX_GAS, maxFeePerGas: PER_TX_MAX_FEE });
  return {
    sender: ownerCosmos,
    blocks: size.blocks,
    maxTxs: size.txs,
    maxValue: (perTx * BigInt(size.txs)).toString(),
    allowedTargets,
  };
}

/** `pnpm cli window open|close`: a hybrid-signed tx from the OWNER_MNEMONIC account. Prints the tx hash. */
export async function runWindow(args: string[], env: Env = process.env): Promise<void> {
  const parsed = parseWindowArgs(args);
  const owner = await loadOwner(env);

  if (parsed.action === "close") {
    const hash = await broadcast(owner, [closeEvmWindowMsg(owner.cosmos)], "qday: close owner window");
    console.log(`window close: ${hash}`);
  } else {
    const vault = loadVault(env);
    const tokens = loadTokens(env);
    // The vault's immutable guardian, read on chain: the env may not name it (a demo run.env).
    const guardian = (await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "guardian" })) as Hex;
    const params = buildOwnerWindowParams(owner.cosmos, tokens, vault, guardian, parsed);
    const hash = await broadcast(owner, [openEvmWindowMsg(params)], "qday: open owner window");
    console.log(`window open (${params.blocks} blocks, ${params.maxTxs} txs, targets fUSD fETH fBTC vault guardian): ${hash}`);
  }

  // Informational only: the tx above already succeeded, so a REST hiccup here must not turn it into an error.
  try {
    const w = await evmWindowStatus({ rest: NETWORK.rest, address: owner.cosmos });
    console.log(w.live ? `owner window live: ${w.remainingBlocks} blocks, ${w.remainingTxs} txs left` : "owner window closed");
  } catch (e) {
    console.log(`owner window status unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }
}
