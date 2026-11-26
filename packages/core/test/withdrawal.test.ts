import { generatePqcKeypair, pqcVerify } from "@qorechain/sdk";
import { hexToBytes, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import { withdrawalMessage } from "../src/vaultMessage";
import { assertRegisteredKey, buildWithdrawal } from "../src/withdrawal";

const VAULT = "0x17d867860a0A0Ff528dF655439ff59176b061B3C";
const TO = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94";
const TOKEN = "0x1111111111111111111111111111111111111111";
const p = { vault: VAULT, to: TO, token: TOKEN, amount: 10n ** 18n, nonce: 7n } as const;

describe("buildWithdrawal (from @qday/core)", () => {
  const kp = generatePqcKeypair();
  const w = buildWithdrawal(p, kp.secretKey);

  it("emits the documented JSON shape", () => {
    expect(w).toMatchObject({ vault: VAULT, to: TO, token: TOKEN, amount: "1000000000000000000", nonce: "7" });
    expect(w.sig).toMatch(/^0x[0-9a-f]+$/);
  });

  it("signs exactly withdrawalMessage(...) for chain 9800: sig verifies with pqcVerify", () => {
    const msg = withdrawalMessage({ chainId: 9800n, ...p });
    expect(pqcVerify(kp.publicKey, msg, hexToBytes(w.sig))).toBe(true);
  });

  it("does not verify against a different key or a tampered field", () => {
    const sig = hexToBytes(w.sig);
    expect(pqcVerify(generatePqcKeypair().publicKey, withdrawalMessage({ chainId: 9800n, ...p }), sig)).toBe(false);
    for (const t of [{ amount: 2n * 10n ** 18n }, { nonce: 8n }, { to: TOKEN as `0x${string}` }]) {
      expect(pqcVerify(kp.publicKey, withdrawalMessage({ chainId: 9800n, ...p, ...t }), sig)).toBe(false);
    }
  });

  it("supports the native token (zero address)", () => {
    expect(buildWithdrawal({ ...p, token: zeroAddress }, kp.secretKey).token).toBe(zeroAddress);
  });
});

describe("assertRegisteredKey", () => {
  const kp = generatePqcKeypair();
  it("refuses an unregistered owner", () => {
    expect(() => assertRegisteredKey({ registered: false } as never, kp.publicKey)).toThrow(/no PQC key registered/);
  });
  it("refuses a key without proof of possession", () => {
    expect(() => assertRegisteredKey({ registered: true, possessionProven: false } as never, kp.publicKey)).toThrow(/proof of possession/);
  });
});
