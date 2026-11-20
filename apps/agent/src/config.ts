import type { Hex } from "viem";
import type { UnifiedAccount } from "@qorechain/sdk";
import { loadAgentKey, loadGasAccount, loadOwnerAddress, loadTokens, loadVault, type TokenSymbol } from "@qday/core";
import { DEFAULT_POLL_MS } from "./watch";

type Env = Record<string, string | undefined>;

export type AgentConfig = {
  owner: Hex;
  vault: Hex;
  tokens: Record<TokenSymbol, Hex>;
  /** Signs incident reports. */
  agentKey: { sk: Uint8Array; pk: Uint8Array };
  /** The agent's own funded account, the vault's immutable guardian: it sends the rescue txs. Never the owner. */
  gas: UnifiedAccount;
  allowlist: Hex[];
  maxOutbound: bigint;
  port: number;
  /** Watcher poll interval in ms (POLL_MS, default 300). */
  pollMs: number;
  anthropicApiKey?: string;
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DEFAULT_MAX_OUTBOUND = 1000n * 10n ** 18n;

/** Load the agent's configuration. Deliberately never reads OWNER_MNEMONIC. */
export async function loadAgentConfig(env: Env = process.env): Promise<AgentConfig> {
  const { evm: owner } = loadOwnerAddress(env);
  const gas = await loadGasAccount(env);
  if (gas.evm.toLowerCase() === owner.toLowerCase()) {
    throw new Error("GAS_MNEMONIC must be a separate account from the owner (its address equals OWNER_EVM_ADDRESS)");
  }
  const guardian = env.GUARDIAN_ADDRESS?.trim();
  if (guardian) {
    if (!ADDRESS_RE.test(guardian)) throw new Error("GUARDIAN_ADDRESS must be a 0x address");
    if (guardian.toLowerCase() !== gas.evm.toLowerCase()) {
      throw new Error(`GUARDIAN_ADDRESS ${guardian} is not the GAS_MNEMONIC account (${gas.evm})`);
    }
  }

  const allowlist = (env.ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((a) => {
      if (!ADDRESS_RE.test(a)) throw new Error(`ALLOWLIST contains an invalid address: ${a}`);
      return a as Hex;
    });

  const maxRaw = env.MAX_OUTBOUND?.trim();
  if (maxRaw && !/^\d+$/.test(maxRaw)) throw new Error("MAX_OUTBOUND must be a decimal integer (wei)");
  const portRaw = env.AGENT_PORT?.trim();
  if (portRaw && !/^\d+$/.test(portRaw)) throw new Error("AGENT_PORT must be a number");
  const pollRaw = env.POLL_MS?.trim();
  if (pollRaw && (!/^\d+$/.test(pollRaw) || Number(pollRaw) <= 0)) throw new Error("POLL_MS must be a positive number of milliseconds");

  return {
    owner,
    vault: loadVault(env),
    tokens: loadTokens(env),
    agentKey: loadAgentKey(env),
    gas,
    allowlist,
    maxOutbound: maxRaw ? BigInt(maxRaw) : DEFAULT_MAX_OUTBOUND,
    port: portRaw ? Number(portRaw) : 8787,
    pollMs: pollRaw ? Number(pollRaw) : DEFAULT_POLL_MS,
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || undefined,
  };
}

/** Startup check: the vault's immutable `guardian()` must be the agent's own account, or every rescue would revert. */
export function checkVaultGuardian(onChain: string, agent: string): void {
  if (onChain.toLowerCase() !== agent.toLowerCase()) {
    throw new Error(`vault guardian() is ${onChain}, not the agent's account ${agent} (redeploy the vault with GUARDIAN_ADDRESS)`);
  }
}
