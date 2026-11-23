import { describe, expect, it } from "vitest";
import { parseVaultArtifact, vaultArtifact } from "./vaultArtifact";

const ctor = (types: string[]) => ({ type: "constructor", inputs: types.map((type) => ({ type, name: "x" })) });

describe("vaultArtifact (forge build output)", () => {
  it("loads through the Vite JSON import: constructor(address,address) and 0x creation bytecode", () => {
    const c = vaultArtifact.abi.find((x) => x.type === "constructor") as unknown as { inputs: { type: string }[] };
    expect(c.inputs.map((i) => i.type)).toEqual(["address", "address"]);
    expect(vaultArtifact.bytecode).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(vaultArtifact.bytecode.length).toBeGreaterThan(1000);
  });
});

describe("parseVaultArtifact", () => {
  const good = { abi: [ctor(["address", "address"])], bytecode: { object: "0x6080" } };

  it("accepts the expected shape", () => {
    expect(parseVaultArtifact(good)).toEqual({ abi: good.abi, bytecode: "0x6080" });
  });

  it("refuses a wrong or missing constructor", () => {
    expect(() => parseVaultArtifact({ ...good, abi: [ctor(["address"])] })).toThrow(/constructor/);
    expect(() => parseVaultArtifact({ ...good, abi: [ctor(["address", "uint256"])] })).toThrow(/constructor/);
    expect(() => parseVaultArtifact({ ...good, abi: [] })).toThrow(/constructor/);
    expect(() => parseVaultArtifact({ bytecode: good.bytecode })).toThrow(/constructor/);
  });

  it("refuses missing or non-hex creation bytecode", () => {
    expect(() => parseVaultArtifact({ abi: good.abi })).toThrow(/bytecode/);
    expect(() => parseVaultArtifact({ abi: good.abi, bytecode: { object: "" } })).toThrow(/bytecode/);
    expect(() => parseVaultArtifact({ abi: good.abi, bytecode: { object: "6080" } })).toThrow(/bytecode/);
    expect(() => parseVaultArtifact({ abi: good.abi, bytecode: { object: "0x__$link$__" } })).toThrow(/bytecode/);
  });
});
