import { erc20Abi, getAbiItem, type Hex } from "viem";
import { publicClient } from "./chain";
import type { AgentConfig } from "./config";

/** Owner and vault balances and the owner's recent token activity, read from the chain (Overview, Dashboard, Activity). */
export const SYMBOLS = ["fUSD", "fETH", "fBTC"] as const;
export const ACTIVITY_BLOCKS = 2000n;

export type AssetRow = { sym: string; owner: bigint; vault: bigint | null; allowance: bigint | null };

export async function readAssets(cfg: AgentConfig): Promise<AssetRow[]> {
  const rows = await Promise.all(
    SYMBOLS.map(async (sym) => {
      const address = cfg.tokens[sym];
      const [owner, vault, allowance] = await Promise.all([
        publicClient.readContract({ address, abi: erc20Abi, functionName: "balanceOf", args: [cfg.owner] }),
        publicClient.readContract({ address, abi: erc20Abi, functionName: "balanceOf", args: [cfg.vault] }),
        publicClient.readContract({ address, abi: erc20Abi, functionName: "allowance", args: [cfg.owner, cfg.vault] }),
      ]);
      return { sym, owner, vault, allowance };
    }),
  );
  const [qorOwner, qorVault] = await Promise.all([publicClient.getBalance({ address: cfg.owner }), publicClient.getBalance({ address: cfg.vault })]);
  return [...rows, { sym: "QOR", owner: qorOwner, vault: qorVault, allowance: null }];
}

export type Activity = { kind: "transfer" | "approval"; block: bigint; hash: Hex; logIndex: number; token: Hex; to: Hex; amount: bigint };

const TRANSFER = getAbiItem({ abi: erc20Abi, name: "Transfer" });
const APPROVAL = getAbiItem({ abi: erc20Abi, name: "Approval" });

/** The owner's token Transfer / Approval logs over the last 2,000 blocks (eth_getLogs with an indexed-topic filter). */
export async function readActivity(cfg: AgentConfig): Promise<{ tip: bigint; items: Activity[] }> {
  const tip = await publicClient.getBlockNumber();
  const fromBlock = tip > ACTIVITY_BLOCKS ? tip - ACTIVITY_BLOCKS : 0n;
  const address = Object.values(cfg.tokens);
  const [transfers, approvals] = await Promise.all([
    publicClient.getLogs({ address, event: TRANSFER, args: { from: cfg.owner }, fromBlock, toBlock: tip }),
    publicClient.getLogs({ address, event: APPROVAL, args: { owner: cfg.owner }, fromBlock, toBlock: tip }),
  ]);
  const items: Activity[] = [
    ...transfers.map((l) => ({ kind: "transfer" as const, block: l.blockNumber, hash: l.transactionHash, logIndex: l.logIndex, token: l.address, to: l.args.to!, amount: l.args.value! })),
    ...approvals.map((l) => ({ kind: "approval" as const, block: l.blockNumber, hash: l.transactionHash, logIndex: l.logIndex, token: l.address, to: l.args.spender!, amount: l.args.value! })),
  ];
  items.sort((a, b) => (a.block === b.block ? b.logIndex - a.logIndex : a.block > b.block ? -1 : 1));
  return { tip, items: items.slice(0, 25) };
}

