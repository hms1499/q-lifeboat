import { decodeAuthenticatorExecutions, fetchAuthNonce, buildPhantomExecuteEvm, resolveEvmAuthDigestVersion } from "@qorechain/sdk";
import { NETWORK, vaultAbi, type RescueRecord } from "@qday/core";
import { broadcastTx, publicClient } from "@qday/core/chain";
import { ed25519 } from "@noble/curves/ed25519";
import { encodeFunctionData, hexToBytes, parseAbi, parseAbiItem, type Hex } from "viem";
import type { AgentConfig } from "./config";

export type RescueResult = RescueRecord;

export type RescueDeps = {
  /** The ERC-20 tokens the vault can rescue. */
  tokens: Hex[];
  readBalance(token: Hex): Promise<bigint>;
  /** Owner's allowance to the vault. */
  readAllowance(token: Hex): Promise<bigint>;
  /** Authenticator nonce and EVM digest version, resolved once per run. */
  fetchAuthState(): Promise<{ nonce: bigint; digestVersion: string }>;
  buildMsg(token: Hex, nonce: bigint, digestVersion: string): Promise<unknown>;
  broadcast(msgs: unknown[]): Promise<{
    hash: string;
    /** Block height the tx was delivered in. */
    height?: number;
    executions: { success: boolean; error?: string }[];
  }>;
  /** Sum of the vault's `Rescued(token, amount)` logs in the block at `height`. */
  readRescued(token: Hex, height: bigint): Promise<bigint>;
};

/**
 * Rescue every token the vault can actually pull (min of balance and allowance > 0) in ONE tx.
 * Nothing is fetched or broadcast when there is nothing to rescue. A failed execution is reported,
 * never thrown, so the incident record is always produced. The reported `amount` is what the vault's
 * `Rescued` logs say it moved (0 when none is found), `expected` is the pre-read estimate.
 */
export async function rescueAll(deps: RescueDeps): Promise<RescueResult[]> {
  const planned: { token: Hex; expected: bigint }[] = [];
  for (const token of deps.tokens) {
    const [balance, allowance] = await Promise.all([deps.readBalance(token), deps.readAllowance(token)]);
    const expected = balance < allowance ? balance : allowance;
    if (expected > 0n) planned.push({ token, expected });
  }
  if (planned.length === 0) return [];

  try {
    const { nonce, digestVersion } = await deps.fetchAuthState();
    const msgs = await Promise.all(planned.map((p, i) => deps.buildMsg(p.token, nonce + BigInt(i), digestVersion)));
    const { hash, height, executions } = await deps.broadcast(msgs);
    return await Promise.all(
      planned.map(async (p, i): Promise<RescueResult> => {
        const x = executions[i];
        if (!x) return { ...p, amount: 0n, hash, success: false, error: "no execution result for this message" };
        if (!x.success) return { ...p, amount: 0n, hash, success: false, error: x.error || "execution failed" };
        let amount = 0n;
        if (height !== undefined) {
          try {
            amount = await deps.readRescued(p.token, BigInt(height));
          } catch {
            amount = 0n; // never fall back to the estimate
          }
        }
        return { ...p, amount, hash, success: true };
      }),
    );
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return planned.map((p) => ({ ...p, amount: 0n, hash: "", success: false, error }));
  }
}

const rescuedEvent = parseAbiItem("event Rescued(address indexed token, uint256 amount)");

const RESCUE_GAS_LIMIT = 200_000n;

/** The one call the agent may ever make: `vault.rescue(token)`, no value, tight gas. */
export function rescueCall(vault: Hex, token: Hex) {
  return {
    to: vault,
    value: "0",
    data: encodeFunctionData({ abi: vaultAbi, functionName: "rescue", args: [token] }),
    gasLimit: RESCUE_GAS_LIMIT,
  };
}

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);

/** Wire `rescueAll` to diana: viem reads, the agent's ed25519 key for the authenticator lane, the gas wallet as relayer. */
export function productionDeps(cfg: AgentConfig): RescueDeps {
  const { sk, pk } = cfg.agentKey;
  // The authenticator wallet shape the SDK expects (same as the spike); the key never leaves this process.
  const wallet = {
    publicKey: pk,
    async signMessage(m: Uint8Array) {
      return { signature: ed25519.sign(m, sk) };
    },
  };
  return {
    tokens: Object.values(cfg.tokens),
    readBalance: (token) =>
      publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [cfg.owner] }),
    readAllowance: (token) =>
      publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [cfg.owner, cfg.vault] }),
    fetchAuthState: async () => ({
      nonce: (await fetchAuthNonce({ rest: NETWORK.rest, address: cfg.ownerCosmos, pubkey: pk })).nonce,
      digestVersion: await resolveEvmAuthDigestVersion({ rest: NETWORK.rest }),
    }),
    buildMsg: async (token, nonce, digestVersion) => {
      const call = rescueCall(cfg.vault, token);
      return buildPhantomExecuteEvm({
        wallet,
        relayer: cfg.gas.cosmos,
        chainId: NETWORK.chainId,
        account: cfg.ownerCosmos,
        to: call.to,
        value: call.value,
        data: hexToBytes(call.data),
        gasLimit: call.gasLimit,
        nonce,
        digestVersion: digestVersion as "v1" | "v2",
      });
    },
    broadcast: async (msgs) => {
      const res = await broadcastTx(cfg.gas, msgs as any[], "qday-guardian: rescue");
      const executions = decodeAuthenticatorExecutions(res, msgs as any[]).map((x) => ({
        success: x.success,
        error: x.success ? undefined : x.reason || x.vmError || "execution failed",
      }));
      return { hash: res.transactionHash, height: res.height, executions };
    },
    readRescued: async (token, height) => {
      const logs = await publicClient.getLogs({
        address: cfg.vault,
        event: rescuedEvent,
        args: { token },
        fromBlock: height,
        toBlock: height,
      });
      return logs.reduce((sum, l) => sum + (l.args.amount ?? 0n), 0n);
    },
  };
}
