import { ed25519 } from "@noble/curves/ed25519";
import { deriveUnifiedAccount, type UnifiedAccount } from "@qorechain/sdk";

type Env = Record<string, string | undefined>;

/** Derive the owner account from OWNER_MNEMONIC. Never echoes the secret in errors. */
export async function loadOwner(env: Env = process.env): Promise<UnifiedAccount> {
  const mnemonic = env.OWNER_MNEMONIC?.trim();
  if (!mnemonic) throw new Error("OWNER_MNEMONIC is not set");
  try {
    return await deriveUnifiedAccount(mnemonic);
  } catch {
    throw new Error("OWNER_MNEMONIC is not a valid mnemonic");
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
  const sk = Uint8Array.from(Buffer.from(hex, "hex"));
  return { sk, pk: ed25519.getPublicKey(sk) };
}
