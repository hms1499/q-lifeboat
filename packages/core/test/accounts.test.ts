import { bytesToHex } from "viem";
import { describe, expect, it } from "vitest";
import { loadAgentKey, loadOwner } from "../src/accounts";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
// RFC 8032 section 7.1, test 1.
const SK = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
const PK = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";

const hex = (b: Uint8Array) => bytesToHex(b).slice(2);

describe("loadOwner", () => {
  it("derives the EVM address from OWNER_MNEMONIC", async () => {
    const acct = await loadOwner({ OWNER_MNEMONIC: MNEMONIC });
    expect(acct.evm.toLowerCase()).toBe("0x9858effd232b4033e47d90003d41ec34ecaeda94");
  });

  it("throws naming the variable when missing", async () => {
    await expect(loadOwner({})).rejects.toThrow(/OWNER_MNEMONIC/);
  });

  it("does not echo a malformed mnemonic", async () => {
    const bad = "not a real mnemonic secretword";
    const err = await loadOwner({ OWNER_MNEMONIC: bad }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/OWNER_MNEMONIC/);
    expect((err as Error).message).not.toContain("secretword");
  });
});

describe("loadAgentKey", () => {
  it("derives the Ed25519 public key (RFC 8032 test 1)", () => {
    const k = loadAgentKey({ AGENT_ED25519_SK: SK });
    expect(hex(k.sk)).toBe(SK);
    expect(hex(k.pk)).toBe(PK);
  });

  it("accepts a 0x prefix", () => {
    expect(hex(loadAgentKey({ AGENT_ED25519_SK: `0x${SK}` }).pk)).toBe(PK);
  });

  it("throws naming the variable when missing", () => {
    expect(() => loadAgentKey({})).toThrow(/AGENT_ED25519_SK/);
  });

  it("throws on wrong length without echoing the value", () => {
    expect(() => loadAgentKey({ AGENT_ED25519_SK: "abcd1234" })).toThrow(/AGENT_ED25519_SK/);
    try {
      loadAgentKey({ AGENT_ED25519_SK: "abcd1234" });
    } catch (e) {
      expect((e as Error).message).not.toContain("abcd1234");
    }
  });

  it("throws on non-hex input", () => {
    expect(() => loadAgentKey({ AGENT_ED25519_SK: "zz".repeat(32) })).toThrow(/AGENT_ED25519_SK/);
  });
});
