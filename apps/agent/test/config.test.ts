import { describe, expect, it } from "vitest";
import { checkVaultGuardian, loadAgentConfig } from "../src/config";

const base = {
  OWNER_EVM_ADDRESS: "0x7777777777777777777777777777777777777777",
  VAULT_ADDRESS: "0x17d867860a0A0Ff528dF655439ff59176b061B3C",
  FUSD_ADDRESS: "0x1111111111111111111111111111111111111111",
  FETH_ADDRESS: "0x2222222222222222222222222222222222222222",
  FBTC_ADDRESS: "0x3333333333333333333333333333333333333333",
  AGENT_ED25519_SK: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
  GAS_MNEMONIC: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
};

describe("loadAgentConfig", () => {
  it("applies defaults", async () => {
    const c = await loadAgentConfig(base);
    expect(c.maxOutbound).toBe(1000n * 10n ** 18n);
    expect(c.port).toBe(8787);
    expect(c.allowlist).toEqual([]);
    expect(c.anthropicApiKey).toBeUndefined();
    expect(c.gas.evm.toLowerCase()).toBe("0x9858effd232b4033e47d90003d41ec34ecaeda94");
  });

  it("parses allowlist, max, port and key", async () => {
    const c = await loadAgentConfig({
      ...base,
      ALLOWLIST: "0x4444444444444444444444444444444444444444, 0x5555555555555555555555555555555555555555",
      MAX_OUTBOUND: "42",
      AGENT_PORT: "9000",
      ANTHROPIC_API_KEY: "k",
    });
    expect(c.allowlist).toHaveLength(2);
    expect(c.maxOutbound).toBe(42n);
    expect(c.port).toBe(9000);
    expect(c.anthropicApiKey).toBe("k");
  });

  it("never needs OWNER_MNEMONIC", async () => {
    await expect(loadAgentConfig({ ...base, OWNER_MNEMONIC: undefined })).resolves.toBeTruthy();
  });

  it("requires the owner address, gas mnemonic and valid values", async () => {
    await expect(loadAgentConfig({ ...base, OWNER_EVM_ADDRESS: undefined })).rejects.toThrow(/OWNER_EVM_ADDRESS/);
    await expect(loadAgentConfig({ ...base, GAS_MNEMONIC: undefined })).rejects.toThrow(/GAS_MNEMONIC/);
    await expect(loadAgentConfig({ ...base, ALLOWLIST: "nope" })).rejects.toThrow(/ALLOWLIST/);
    await expect(loadAgentConfig({ ...base, MAX_OUTBOUND: "1.5" })).rejects.toThrow(/MAX_OUTBOUND/);
    await expect(loadAgentConfig({ ...base, AGENT_PORT: "x" })).rejects.toThrow(/AGENT_PORT/);
  });

  it("refuses a gas mnemonic that is the owner account", async () => {
    // The base mnemonic derives 0x9858...; pointing the owner at it must fail, case-insensitively.
    const owner = "0x9858EfFD232B4033E47d90003D41EC34EcaEdA94";
    await expect(loadAgentConfig({ ...base, OWNER_EVM_ADDRESS: owner })).rejects.toThrow(/GAS_MNEMONIC.*owner/i);
    await expect(loadAgentConfig({ ...base, OWNER_EVM_ADDRESS: owner.toLowerCase() })).rejects.toThrow(/GAS_MNEMONIC.*owner/i);
  });

  it("accepts GUARDIAN_ADDRESS when it is the gas account's EVM address (any case)", async () => {
    const c = await loadAgentConfig({ ...base, GUARDIAN_ADDRESS: "0x9858EfFD232B4033E47d90003D41EC34EcaEdA94" });
    expect(c.gas.evm.toLowerCase()).toBe("0x9858effd232b4033e47d90003d41ec34ecaeda94");
    await expect(loadAgentConfig({ ...base, GUARDIAN_ADDRESS: "0x9858effd232b4033e47d90003d41ec34ecaeda94" })).resolves.toBeTruthy();
  });

  it("refuses a GUARDIAN_ADDRESS that is not the gas account, or is malformed", async () => {
    await expect(
      loadAgentConfig({ ...base, GUARDIAN_ADDRESS: "0x8888888888888888888888888888888888888888" }),
    ).rejects.toThrow(/GUARDIAN_ADDRESS.*GAS_MNEMONIC/);
    await expect(loadAgentConfig({ ...base, GUARDIAN_ADDRESS: "0x1234" })).rejects.toThrow(/GUARDIAN_ADDRESS/);
  });

  it("does not echo a bad gas mnemonic", async () => {
    const err = await loadAgentConfig({ ...base, GAS_MNEMONIC: "bad secretword" }).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/GAS_MNEMONIC/);
    expect((err as Error).message).not.toContain("secretword");
  });
});

describe("checkVaultGuardian", () => {
  const agent = "0x9858EfFD232B4033E47d90003D41EC34EcaEdA94";

  it("passes when the vault's guardian() is the agent (any case)", () => {
    expect(() => checkVaultGuardian(agent.toLowerCase(), agent)).not.toThrow();
  });

  it("fails loudly when the vault was deployed for another guardian", () => {
    expect(() => checkVaultGuardian("0x8888888888888888888888888888888888888888", agent)).toThrow(
      /guardian\(\) is 0x8888888888888888888888888888888888888888.*0x9858EfFD232B4033E47d90003D41EC34EcaEdA94/,
    );
  });
});
