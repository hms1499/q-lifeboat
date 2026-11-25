import { pqcStatusPublicKey, pqcSign, type PqcStatus } from "@qorechain/sdk";
import { bytesToHex, type Hex } from "viem";
import { NETWORK } from "./config";
import { withdrawalMessage } from "./vaultMessage";

/** The JSON object the `withdraw` command (or the browser) submits to `GuardianVault.withdraw`. */
export interface WithdrawalFile {
  vault: Hex;
  to: Hex;
  token: Hex;
  /** Decimal string, base units. */
  amount: string;
  /** Decimal string. */
  nonce: string;
  sig: Hex;
}

/** Sign a withdrawal with the ML-DSA secret key and return the JSON object the `withdraw` command submits. */
export function buildWithdrawal(
  p: { vault: Hex; to: Hex; token: Hex; amount: bigint; nonce: bigint },
  pqcSecretKey: Uint8Array,
): WithdrawalFile {
  const msg = withdrawalMessage({ chainId: BigInt(NETWORK.evmChainId), ...p });
  const sig = pqcSign(pqcSecretKey, msg);
  return {
    vault: p.vault,
    to: p.to,
    token: p.token,
    amount: p.amount.toString(),
    nonce: p.nonce.toString(),
    sig: bytesToHex(sig),
  };
}

/**
 * Refuse to sign unless the chain knows the key: registered, proven by possession (the vault reverts
 * KeyNotProven otherwise) and equal to the key derived from OWNER_MNEMONIC.
 */
export function assertRegisteredKey(status: PqcStatus, localPublicKey: Uint8Array): void {
  if (!status.registered) throw new Error("the owner has no PQC key registered on-chain");
  if (status.possessionProven !== true) {
    throw new Error("the owner's PQC key has no proof of possession on-chain; the vault would reject withdrawals");
  }
  const onChain = pqcStatusPublicKey(status);
  if (!onChain) throw new Error("the chain returned no public key for the owner's PQC registration");
  if (bytesToHex(onChain) !== bytesToHex(localPublicKey)) {
    throw new Error("the on-chain PQC key differs from the key derived from OWNER_MNEMONIC; refusing to sign");
  }
}
