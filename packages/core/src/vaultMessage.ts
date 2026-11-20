import { encodePacked, hexToBytes, type Hex } from "viem";

export interface WithdrawalParams {
  chainId: bigint;
  vault: Hex;
  to: Hex;
  /** Token address, or the zero address for QOR. */
  token: Hex;
  amount: bigint;
  nonce: bigint;
}

/**
 * The bytes the owner's ML-DSA key signs for a withdrawal. Must stay byte-identical to
 * GuardianVault.withdrawalMessage (guarded by the shared vector test).
 */
export function withdrawalMessage(p: WithdrawalParams): Uint8Array {
  return hexToBytes(
    encodePacked(
      ["string", "uint256", "address", "address", "address", "uint256", "uint256"],
      ["QDAY-GUARDIAN-V1", p.chainId, p.vault, p.to, p.token, p.amount, p.nonce],
    ),
  );
}
