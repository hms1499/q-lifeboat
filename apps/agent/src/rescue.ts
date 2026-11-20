import { vaultAbi, type RescueRecord } from "@qday/core";
import { chain, publicClient } from "@qday/core/chain";
import { encodeFunctionData, keccak256, parseAbi, parseEventLogs, type Hex, type Log, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AgentConfig } from "./config";
import { createBatchClient } from "./rpc";
import type { WindowKeeper } from "./window";

export type RescueResult = RescueRecord;

/** Gas limit of one `vault.rescue(token)` tx. The chain charges at least 50% of it; rescue used 58705 on diana. */
export const RESCUE_GAS = 120_000n;
/**
 * Fee cap of every rescue tx, set explicitly: the guardian's window charges `gas x maxFeePerGas` per tx, and
 * `window.ts` sizes its budget from this same value. Diana's base fee is 100 gwei, so the cap leaves headroom.
 */
export const RESCUE_MAX_FEE_PER_GAS = 150_000_000_000n;
/**
 * 40 gwei tip: an attacker sending with viem's default fees tips far less, so when the rescue and a drain
 * compete for the same block, the rescue is ordered first. Base fee 100 + tip 40 = 140 gwei stays under the
 * 150 gwei cap, and the guardian's window budget (sized from the cap, not the tip) is unchanged.
 */
export const RESCUE_PRIORITY_FEE_PER_GAS = 40_000_000_000n;

/** The only tx the agent ever sends: `vault.rescue(token)`, no value. */
export type RescueTx = { to: Hex; data: Hex; gas: bigint; nonce: number; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };

export type RescueReceipt = {
  status: "success" | "reverted";
  /** Block the tx landed in (logged for latency tuning). */
  blockNumber?: bigint;
  logs: Pick<Log, "address" | "topics" | "data">[];
};

export type RescueDeps = {
  vault: Hex;
  /** The ERC-20 tokens the vault can rescue. */
  tokens: Hex[];
  readBalance(token: Hex): Promise<bigint>;
  /** Owner's allowance to the vault. */
  readAllowance(token: Hex): Promise<bigint>;
  /**
   * Runs once, only when something will be sent (makes sure the guardian's EVM window is usable). Resolves true
   * when it sent a tx from the guardian account (opened a window), so the nonce read in parallel is stale.
   */
  prepare(): Promise<boolean>;
  /** The guardian account's next EVM nonce (pending block). Read alongside the balance/allowance reads. */
  fetchNonce(): Promise<number>;
  /** Sign locally with the guardian account, so the hash is known before sending. */
  signTx(tx: RescueTx): Promise<{ hash: Hex; raw: Hex }>;
  /** Submit a signed tx; resolves once the node accepted it. */
  sendRaw(raw: Hex): Promise<void>;
  /** Whether the node knows this tx (pending or mined). */
  isKnown(hash: Hex): Promise<boolean>;
  waitReceipt(hash: Hex): Promise<RescueReceipt>;
  /** Timing lines (send time, receipt block) for latency tuning. Optional. */
  log?: (line: string) => void;
  now?: () => Date;
};

function rescueTx(vault: Hex, token: Hex, nonce: number): RescueTx {
  return {
    to: vault,
    data: encodeFunctionData({ abi: vaultAbi, functionName: "rescue", args: [token] }),
    gas: RESCUE_GAS,
    nonce,
    maxFeePerGas: RESCUE_MAX_FEE_PER_GAS,
    maxPriorityFeePerGas: RESCUE_PRIORITY_FEE_PER_GAS,
  };
}

/** Sum of the `Rescued(token, amount)` logs the VAULT emitted in this receipt. */
function rescuedAmount(receipt: RescueReceipt, vault: Hex, token: Hex): bigint {
  const logs = parseEventLogs({ abi: vaultAbi, eventName: "Rescued", logs: receipt.logs as Log[], strict: true });
  return logs
    .filter((l) => l.address.toLowerCase() === vault.toLowerCase() && l.args.token.toLowerCase() === token.toLowerCase())
    .reduce((sum, l) => sum + l.args.amount, 0n);
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The trigger's token first (it is the one being drained right now), then the others in config order. */
function triggerFirst(tokens: Hex[], trigger?: Hex): Hex[] {
  if (!trigger) return tokens;
  const t = trigger.toLowerCase();
  return [...tokens.filter((x) => x.toLowerCase() === t), ...tokens.filter((x) => x.toLowerCase() !== t)];
}

/**
 * Rescue every token the vault can actually pull (min of balance and allowance > 0), one `vault.rescue(token)`
 * tx per token from the guardian account, sent back to back with sequential nonces, then wait for all receipts.
 * `trigger` is the token of the transfer that started the rescue: it gets the first nonce and is sent first.
 * The nonce read starts in the same turn as the balance/allowance reads (one round trip for all of them with a
 * batching transport); it is redone only when `prepare` opened a window. Nothing is prepared or sent when there
 * is nothing to rescue (the nonce result is then ignored). A failure (read, send, receipt) is reported per
 * token, never thrown, so the other tokens are still rescued and the incident record is always produced.
 * Results are in send order (trigger token first, then config order). `amount` is what the vault's `Rescued`
 * logs in that receipt say it moved; `expected` is the pre-read estimate.
 */
export async function rescueAll(deps: RescueDeps, trigger?: Hex): Promise<RescueResult[]> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date());
  type Slot = { token: Hex; expected: bigint; readError?: string };
  const slotsRead = Promise.all(
    triggerFirst(deps.tokens, trigger).map(async (token): Promise<Slot> => {
      try {
        const [balance, allowance] = await Promise.all([deps.readBalance(token), deps.readAllowance(token)]);
        return { token, expected: balance < allowance ? balance : allowance };
      } catch (e) {
        return { token, expected: 0n, readError: `read failed: ${message(e)}` };
      }
    }),
  );
  // Started after the reads were issued, in the same turn; settled so an unused failure is never unhandled.
  const nonceRead = deps.fetchNonce().then(
    (n) => ({ ok: true as const, n }),
    (e: unknown) => ({ ok: false as const, e }),
  );
  const slots = await slotsRead;
  const kept = slots.filter((s) => s.readError || s.expected > 0n);
  const failed = (s: Slot, error: string, hash = ""): RescueResult => ({ token: s.token, hash, amount: 0n, expected: s.expected, success: false, error });
  const planned = kept.filter((s) => !s.readError);
  if (planned.length === 0) return kept.map((s) => failed(s, s.readError!));

  let nonce: number;
  try {
    if (await deps.prepare()) {
      nonce = await deps.fetchNonce(); // the window open used a nonce after the parallel read
    } else {
      const read = await nonceRead;
      if (!read.ok) throw read.e;
      nonce = read.n;
    }
  } catch (e) {
    return kept.map((s) => failed(s, s.readError ?? message(e)));
  }

  // Send all first. Each tx is signed locally, so its hash is known even when the send call fails: if the node
  // took it anyway (a lost response), it keeps its hash and its nonce; otherwise the nonce is reused.
  const sent = new Map<Slot, { hash: Hex } | { error: string }>(); // keyed by slot: two slots may share an address
  for (const p of planned) {
    let signed: { hash: Hex; raw: Hex };
    try {
      signed = await deps.signTx(rescueTx(deps.vault, p.token, nonce));
    } catch (e) {
      sent.set(p, { error: message(e) });
      continue;
    }
    try {
      await deps.sendRaw(signed.raw);
    } catch (e) {
      if (!(await deps.isKnown(signed.hash).catch(() => false))) {
        sent.set(p, { error: message(e) });
        continue;
      }
    }
    sent.set(p, { hash: signed.hash });
    log(`timing: rescue ${p.token} sent ${signed.hash} at ${now().toISOString()}`);
    nonce += 1;
  }

  return Promise.all(
    kept.map(async (p): Promise<RescueResult> => {
      if (p.readError) return failed(p, p.readError);
      const s = sent.get(p)!;
      if ("error" in s) return failed(p, s.error);
      try {
        const receipt = await deps.waitReceipt(s.hash);
        log(`timing: rescue ${s.hash} receipt block ${receipt.blockNumber ?? "?"} status ${receipt.status}`);
        if (receipt.status !== "success") return failed(p, "rescue tx reverted", s.hash);
        return { token: p.token, expected: p.expected, amount: rescuedAmount(receipt, deps.vault, p.token), hash: s.hash, success: true };
      } catch (e) {
        return failed(p, message(e), s.hash);
      }
    }),
  );
}

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);

const RECEIPT_TIMEOUT_MS = 60_000;
/** Receipt polling interval: viem's default is the chain's block time or 4 s; a quick read keeps the incident timely. */
const RECEIPT_POLL_MS = 500;

/**
 * Wire `rescueAll` to diana: the balance, allowance and nonce reads go out as ONE batched request (`reads`, see
 * rpc.ts), then plain EVM txs signed by the guardian account (GAS_MNEMONIC) inside the guardian's own window
 * (checked only when the cached status is not usable; a sent tx invalidates the cache).
 */
export function productionDeps(
  cfg: AgentConfig,
  keeper: Pick<WindowKeeper, "ensureIfStale" | "invalidate">,
  log?: (line: string) => void,
  reads: Pick<PublicClient, "readContract" | "getTransactionCount"> = createBatchClient(),
): RescueDeps {
  const account = privateKeyToAccount(cfg.gas.privateKey as Hex);
  return {
    vault: cfg.vault,
    tokens: Object.values(cfg.tokens),
    readBalance: (token) =>
      reads.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [cfg.owner] }),
    readAllowance: (token) =>
      reads.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [cfg.owner, cfg.vault] }),
    prepare: () => keeper.ensureIfStale(),
    fetchNonce: () => reads.getTransactionCount({ address: account.address, blockTag: "pending" }),
    signTx: async (tx) => {
      const raw = await account.signTransaction({ ...tx, type: "eip1559", chainId: chain.id, value: 0n });
      return { hash: keccak256(raw), raw };
    },
    sendRaw: async (raw) => {
      keeper.invalidate(); // even a failed send may have reached the node and used the window
      await publicClient.sendRawTransaction({ serializedTransaction: raw });
    },
    isKnown: async (hash) => {
      try {
        await publicClient.getTransaction({ hash });
        return true;
      } catch {
        return false;
      }
    },
    waitReceipt: (hash) => publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS, pollingInterval: RECEIPT_POLL_MS }),
    log,
  };
}
