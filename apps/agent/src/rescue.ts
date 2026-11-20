import { decodeAuthenticatorExecutions, fetchAuthNonce, buildPhantomExecuteEvm, resolveEvmAuthDigestVersion } from "@qorechain/sdk";
import { broadcastTx, NETWORK, publicClient, vaultAbi } from "@qday/core";
import { ed25519 } from "@noble/curves/ed25519";
import { encodeFunctionData, hexToBytes, parseAbi, type Hex } from "viem";
import type { AgentConfig } from "./config";

export type RescueResult = { token: Hex; hash: string; amount: bigint; success: boolean; error?: string };

export type RescueDeps = {
  /** The ERC-20 tokens the vault can rescue. */
  tokens: Hex[];
  readBalance(token: Hex): Promise<bigint>;
  /** Owner's allowance to the vault. */
  readAllowance(token: Hex): Promise<bigint>;
  fetchNonce(): Promise<bigint>;
  buildMsg(token: Hex, nonce: bigint): Promise<unknown>;
  broadcast(msgs: unknown[]): Promise<{ hash: string; executions: { success: boolean; error?: string }[] }>;
};

/**
 * Rescue every token the vault can actually pull (min of balance and allowance > 0) in ONE tx.
 * Nothing is fetched or broadcast when there is nothing to rescue. A failed execution is reported,
 * never thrown, so the incident record is always produced.
 */
export async function rescueAll(deps: RescueDeps): Promise<RescueResult[]> {
  const planned: { token: Hex; amount: bigint }[] = [];
  for (const token of deps.tokens) {
    const [balance, allowance] = await Promise.all([deps.readBalance(token), deps.readAllowance(token)]);
    const amount = balance < allowance ? balance : allowance;
    if (amount > 0n) planned.push({ token, amount });
  }
  if (planned.length === 0) return [];

  try {
    const first = await deps.fetchNonce();
    const msgs = await Promise.all(planned.map((p, i) => deps.buildMsg(p.token, first + BigInt(i))));
    const { hash, executions } = await deps.broadcast(msgs);
    return planned.map((p, i) => {
      const x = executions[i];
      if (!x) return { ...p, hash, success: false, error: "no execution result for this message" };
      return x.success ? { ...p, hash, success: true } : { ...p, hash, success: false, error: x.error || "execution failed" };
    });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    return planned.map((p) => ({ ...p, hash: "", success: false, error }));
  }
}

const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
]);

const RESCUE_GAS_LIMIT = 200_000n;

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
    fetchNonce: async () => (await fetchAuthNonce({ rest: NETWORK.rest, address: cfg.ownerCosmos, pubkey: pk })).nonce,
    buildMsg: async (token, nonce) => {
      const data = encodeFunctionData({ abi: vaultAbi, functionName: "rescue", args: [token] });
      return buildPhantomExecuteEvm({
        wallet,
        relayer: cfg.gas.cosmos,
        chainId: NETWORK.chainId,
        account: cfg.ownerCosmos,
        to: cfg.vault,
        value: "0",
        data: hexToBytes(data),
        gasLimit: RESCUE_GAS_LIMIT,
        nonce,
        digestVersion: await resolveEvmAuthDigestVersion({ rest: NETWORK.rest }),
      });
    },
    broadcast: async (msgs) => {
      const res = await broadcastTx(cfg.gas, msgs as any[], "qday-guardian: rescue");
      const executions = decodeAuthenticatorExecutions(res, msgs as any[]).map((x) => ({
        success: x.success,
        error: x.success ? undefined : x.reason || x.vmError || "execution failed",
      }));
      return { hash: res.transactionHash, executions };
    },
  };
}
