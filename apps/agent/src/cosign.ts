import { NETWORK, type GuardianCoSigner, type GuardianSignature } from "@qday/core";
import { classicalKeyFromPrivate, signMessage } from "@qorechain/qoresign";
import type { UnifiedAccount } from "@qorechain/sdk";
import { hexToBytes, type Hex } from "viem";

/** QoreSign binds the chain id into the ML-DSA-87 sign bytes (`"qorechain-msg-v1|" + chainId + "|" + data`). */
export const CHAIN_ID = NETWORK.chainId;

/**
 * Co-sign incident reports as the guardian account (submission gap 3): QoreSign `signMessage` with the account's EVM key
 * (`eth_secp256k1`, the `m/44'/60'` key the SDK derives) and its registered ML-DSA-87 key. The dashboard checks it with
 * `verifyMessageWithChain` against that registered key, with the signer bound to `vault.guardian()`. Spike 2026-11-24
 * (docs/specs/2026-11-24-submission-gaps.md): the SDK-derived ML-DSA key equals the one registered on diana.
 */
export function guardianCoSigner(gas: Pick<UnifiedAccount, "cosmos" | "privateKey" | "pqc">, log: (line: string) => void = () => {}): GuardianCoSigner {
  const raw = gas.privateKey.startsWith("0x") ? gas.privateKey : `0x${gas.privateKey}`;
  const classicalKey = classicalKeyFromPrivate(hexToBytes(raw as Hex), "eth_secp256k1");
  return {
    guardian: gas.cosmos,
    sign: (data) =>
      signMessage({ chainId: CHAIN_ID, signer: gas.cosmos, data, classicalKey, pqKey: { secretKey: gas.pqc.secretKey } }) as GuardianSignature,
    // Message only: never the key material.
    onError: (e) => log(`report co-sign failed (sent with the agent's ed25519 signature only): ${e instanceof Error ? e.message : String(e)}`),
  };
}
