import { ed25519 } from "@noble/curves/ed25519";
import { hexToBytes, type Hex } from "viem";
import { addressesFrom20, deriveUnifiedAccount, type UnifiedAccount } from "@qorechain/sdk";

type Env = Record<string, string | undefined>;

/** Derive the owner account from OWNER_MNEMONIC. Never echoes the secret in errors. */
export async function loadOwner(env: Env = process.env): Promise<UnifiedAccount> {
  const mnemonic = env.OWNER_MNEMONIC?.trim();
  if (!mnemonic) throw new Error("OWNER_MNEMONIC is not set");
  try {
    return await deriveUnifiedAccount(mnemonic);
  } catch (e) {
    // Only the error name is safe to surface; the message could contain the secret.
    const name = e instanceof Error ? e.name : "UnknownError";
    throw new Error(`OWNER_MNEMONIC could not be used to derive an account (${name})`);
  }
}

/** Load the agent's Ed25519 key from AGENT_ED25519_SK (32-byte hex, 0x optional). */
export function loadAgentKey(env: Env = process.env): { sk: Uint8Array; pk: Uint8Array } {
  const raw = env.AGENT_ED25519_SK?.trim();
  if (!raw) throw new Error("AGENT_ED25519_SK is not set");
  const hex = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("AGENT_ED25519_SK must be 32 bytes of hex (64 hex characters)");
  }
  const sk = hexToBytes(`0x${hex}`);
  return { sk, pk: ed25519.getPublicKey(sk) };
}

/** The owner's public addresses from OWNER_EVM_ADDRESS. For processes that must never hold the owner's secret. */
export function loadOwnerAddress(env: Env = process.env): { evm: Hex; cosmos: string } {
  const raw = env.OWNER_EVM_ADDRESS?.trim();
  if (!raw) throw new Error("OWNER_EVM_ADDRESS is not set");
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) throw new Error("OWNER_EVM_ADDRESS must be a 0x-prefixed 20-byte address");
  return { evm: raw as Hex, cosmos: addressesFrom20(hexToBytes(raw as Hex)).cosmos };
}

/** Derive the relayer (gas) account from GAS_MNEMONIC. Never echoes the secret in errors. */
export async function loadGasAccount(env: Env = process.env): Promise<UnifiedAccount> {
  const mnemonic = env.GAS_MNEMONIC?.trim();
  if (!mnemonic) throw new Error("GAS_MNEMONIC is not set");
  try {
    return await deriveUnifiedAccount(mnemonic);
  } catch (e) {
    throw new Error(`GAS_MNEMONIC could not be used to derive an account (${e instanceof Error ? e.name : "UnknownError"})`);
  }
}

/** The authenticator wallet shape the SDK expects for the agent's ed25519 key. The key never leaves the process. */
export function agentWallet(key: { sk: Uint8Array; pk: Uint8Array }) {
  return {
    publicKey: key.pk,
    async signMessage(m: Uint8Array) {
      return { signature: ed25519.sign(m, key.sk) };
    },
  };
}
