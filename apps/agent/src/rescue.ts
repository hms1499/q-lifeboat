import { vaultAbi, type RescueRecord } from "@qday/core";
import { chain, publicClient } from "@qday/core/chain";
import { createWalletClient, encodeFunctionData, http, parseAbi, parseEventLogs, type Hex, type Log } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AgentConfig } from "./config";
import type { WindowKeeper } from "./window";

export type RescueResult = RescueRecord;

/** Gas limit of one `vault.rescue(token)` tx. The chain charges at least 50% of it; rescue used 58705 on diana. */
export const RESCUE_GAS = 120_000n;

/** The only tx the agent ever sends: `vault.rescue(token)`, no value. */
export type RescueTx = { to: Hex; data: Hex; gas: bigint; nonce: number };

export type RescueReceipt = { status: "success" | "reverted"; logs: Pick<Log, "address" | "topics" | "data">[] };

export type RescueDeps = {
  vault: Hex;
  /** The ERC-20 tokens the vault can rescue. */
  tokens: Hex[];
  readBalance(token: Hex): Promise<bigint>;
  /** Owner's allowance to the vault. */
  readAllowance(token: Hex): Promise<bigint>;
  /** Runs once, only when something will be sent (makes sure the guardian's EVM window is usable). */
  prepare(): Promise<void>;
  /** The guardian account's next EVM nonce (pending block). */
  fetchNonce(): Promise<number>;
  /** Sign and send from the guardian account; resolves with the tx hash once the node accepted it. */
  sendTx(tx: RescueTx): Promise<Hex>;
  waitReceipt(hash: Hex): Promise<RescueReceipt>;
};

function rescueTx(vault: Hex, token: Hex, nonce: number): RescueTx {
  return { to: vault, data: encodeFunctionData({ abi: vaultAbi, functionName: "rescue", args: [token] }), gas: RESCUE_GAS, nonce };
}

/** Sum of the `Rescued(token, amount)` logs the VAULT emitted in this receipt. */
function rescuedAmount(receipt: RescueReceipt, vault: Hex, token: Hex): bigint {
  const logs = parseEventLogs({ abi: vaultAbi, eventName: "Rescued", logs: receipt.logs as Log[], strict: true });
  return logs
    .filter((l) => l.address.toLowerCase() === vault.toLowerCase() && l.args.token.toLowerCase() === token.toLowerCase())
    .reduce((sum, l) => sum + l.args.amount, 0n);
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Rescue every token the vault can actually pull (min of balance and allowance > 0), one `vault.rescue(token)`
 * tx per token from the guardian account, sent back to back with sequential nonces, then wait for all receipts.
 * Nothing is prepared, read or sent when there is nothing to rescue. A failure is reported per token, never
 * thrown, so the incident record is always produced. `amount` is what the vault's `Rescued` logs in that
 * receipt say it moved; `expected` is the pre-read estimate.
 */
export async function rescueAll(deps: RescueDeps): Promise<RescueResult[]> {
  const planned: { token: Hex; expected: bigint }[] = [];
  for (const token of deps.tokens) {
    const [balance, allowance] = await Promise.all([deps.readBalance(token), deps.readAllowance(token)]);
    const expected = balance < allowance ? balance : allowance;
    if (expected > 0n) planned.push({ token, expected });
  }
  if (planned.length === 0) return [];

  let nonce: number;
  try {
    await deps.prepare();
    nonce = await deps.fetchNonce();
  } catch (e) {
    return planned.map((p) => ({ ...p, amount: 0n, hash: "", success: false, error: message(e) }));
  }

  // Send all first. A nonce is consumed only by a tx the node accepted, so a failed send leaves no gap.
  const sent: ({ hash: Hex } | { error: string })[] = [];
  for (const p of planned) {
    try {
      sent.push({ hash: await deps.sendTx(rescueTx(deps.vault, p.token, nonce)) });
      nonce += 1;
    } catch (e) {
      sent.push({ error: message(e) });
    }
  }

  return Promise.all(
    planned.map(async (p, i): Promise<RescueResult> => {
      const s = sent[i];
      if ("error" in s) return { ...p, amount: 0n, hash: "", success: false, error: s.error };
      try {
        const receipt = await deps.waitReceipt(s.hash);
        if (receipt.status !== "success") return { ...p, amount: 0n, hash: s.hash, success: false, error: "rescue tx reverted" };
        return { ...p, amount: rescuedAmount(receipt, deps.vault, p.token), hash: s.hash, success: true };
      } catch (e) {
        return { ...p, amount: 0n, hash: s.hash, success: false, error: message(e) };
      }
    }),
  );
}

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);

const RECEIPT_TIMEOUT_MS = 60_000;

/**
 * Wire `rescueAll` to diana: viem reads, plain EVM txs signed by the guardian account (GAS_MNEMONIC), inside the
 * guardian's own window (checked only when the cached status is not usable; a sent tx invalidates the cache).
 */
export function productionDeps(cfg: AgentConfig, keeper: Pick<WindowKeeper, "ensureIfStale" | "invalidate">): RescueDeps {
  const account = privateKeyToAccount(cfg.gas.privateKey as Hex);
  const wallet = createWalletClient({ account, chain, transport: http() });
  return {
    vault: cfg.vault,
    tokens: Object.values(cfg.tokens),
    readBalance: (token) =>
      publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [cfg.owner] }),
    readAllowance: (token) =>
      publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [cfg.owner, cfg.vault] }),
    prepare: () => keeper.ensureIfStale(),
    fetchNonce: () => publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
    sendTx: async (tx) => {
      const hash = await wallet.sendTransaction({ ...tx, value: 0n });
      keeper.invalidate();
      return hash;
    },
    waitReceipt: (hash) => publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS }),
  };
}
