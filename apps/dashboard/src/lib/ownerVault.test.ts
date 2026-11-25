import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { ownerVault } from "./ownerVault";

const OWNER = "0x880566d1985705E76C032daf7e3D1Bb4Ea72f536" as Hex;
const V1 = "0x4bf8d0462d4730218cbd857fc4f86adc08369dc6" as Hex;
const V2 = "0x16a63c1b090441f1ef5d35b7824e0d9d0fb45b05" as Hex;

describe("ownerVault (Recover with the in-app wallet, independent of the agent)", () => {
  it("the service's vault when the chain says this owner owns it", async () => {
    expect(await ownerVault(OWNER, [V1], async () => ({ owner: OWNER.toLowerCase() as Hex, guardian: V2 }))).toBe(V1);
  });

  it("falls through to the next candidate (the browser's saved vault) when one is unreadable or another owner's", async () => {
    const roles = async (v: Hex) => (v === V1 ? { owner: V2, guardian: V2 } : { owner: OWNER, guardian: V2 });
    expect(await ownerVault(OWNER, [V1, V2], roles)).toBe(V2);
    expect(await ownerVault(OWNER, [undefined, null, V2], roles)).toBe(V2);
  });

  it("null when no candidate is this owner's vault", async () => {
    expect(await ownerVault(OWNER, [V1], async () => null)).toBeNull();
    expect(await ownerVault(OWNER, [], async () => null)).toBeNull();
  });

  it("a read error propagates (never read as 'no vault')", async () => {
    await expect(ownerVault(OWNER, [V1], async () => Promise.reject(new Error("RPC down")))).rejects.toThrow(/RPC down/);
  });
});
