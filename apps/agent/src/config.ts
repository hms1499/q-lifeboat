import type { Hex } from "viem";
import type { UnifiedAccount } from "@qorechain/sdk";
import { loadAgentKey, loadGasAccount, loadOwnerAddress, loadTokens, loadVault, type TokenSymbol } from "@qday/core";

type Env = Record<string, string | undefined>;

export type AgentConfig = {
  owner: Hex;
  ownerCosmos: string;
  vault: Hex;
  tokens: Record<TokenSymbol, Hex>;
  agentKey: { sk: Uint8Array; pk: Uint8Array };
  /** The agent's own funded relayer account. It pays gas; it never holds the owner's key. */
  gas: UnifiedAccount;
  allowlist: Hex[];
  maxOutbound: bigint;
  port: number;
  anthropicApiKey?: string;
};

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DEFAULT_MAX_OUTBOUND = 1000n * 10n ** 18n;

/** Load the agent's configuration. Deliberately never reads OWNER_MNEMONIC. */
export async function loadAgentConfig(env: Env = process.env): Promise<AgentConfig> {
  const { evm: owner, cosmos: ownerCosmos } = loadOwnerAddress(env);
  const gas = await loadGasAccount(env);
  if (gas.evm.toLowerCase() === owner.toLowerCase()) {
    throw new Error("GAS_MNEMONIC must be a separate account from the owner (its address equals OWNER_EVM_ADDRESS)");
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

  return {
    owner,
    ownerCosmos,
    vault: loadVault(env),
    tokens: loadTokens(env),
    agentKey: loadAgentKey(env),
    gas,
    allowlist,
    maxOutbound: maxRaw ? BigInt(maxRaw) : DEFAULT_MAX_OUTBOUND,
    port: portRaw ? Number(portRaw) : 8787,
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || undefined,
  };
}
