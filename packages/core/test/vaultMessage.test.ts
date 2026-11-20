import { keccak256 } from "viem";
import { describe, expect, it } from "vitest";
import { withdrawalMessage } from "../src/vaultMessage";

// Shared with contracts/test/MessageVector.t.sol. Both sides must produce this exact hash.
const VECTOR_HASH = "0x783fcbffbc8f1ec81272b39002a0c603c86984c6f9138f874c950e790e3c31eb";

describe("withdrawalMessage", () => {
  const msg = withdrawalMessage({
    chainId: 9800n,
    vault: "0x1111111111111111111111111111111111111111",
    to: "0x2222222222222222222222222222222222222222",
    token: "0x3333333333333333333333333333333333333333",
    amount: 10n ** 18n,
    nonce: 0n,
  });

  it("matches the Solidity vector hash", () => {
    expect(keccak256(msg)).toBe(VECTOR_HASH);
  });

  it("is exactly 172 bytes", () => {
    expect(msg.length).toBe(172);
  });

  it("starts with the domain tag", () => {
    expect(new TextDecoder().decode(msg.slice(0, 16))).toBe("QDAY-GUARDIAN-V1");
  });
});
