import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatAbiItem } from "viem/utils";
import { toFunctionSelector, type Abi } from "viem";
import { describe, expect, it } from "vitest";
import { RESCUE_SELECTOR, vaultAbi } from "../src/abi";

const ARTIFACT = fileURLToPath(
  new URL("../../../contracts/out/GuardianVault.sol/GuardianVault.json", import.meta.url),
);

const sigs = (abi: Abi) =>
  new Set(
    abi
      .filter((i) => i.type === "function" || i.type === "event" || i.type === "error")
      .map((i) => `${i.type}:${formatAbiItem(i as never)}`),
  );

describe("vaultAbi", () => {
  it("RESCUE_SELECTOR is the rescue(address) selector", () => {
    expect(RESCUE_SELECTOR).toBe("0x839006f2");
    const rescue = vaultAbi.find((i) => i.type === "function" && i.name === "rescue");
    expect(rescue).toBeDefined();
    expect(toFunctionSelector(rescue as never)).toBe(RESCUE_SELECTOR);
  });

  it("has not drifted from the compiled contract", () => {
    if (!existsSync(ARTIFACT)) throw new Error("run `forge build` in contracts/");
    const compiled = JSON.parse(readFileSync(ARTIFACT, "utf8")).abi as Abi;
    const ours = sigs(vaultAbi as unknown as Abi);
    const theirs = sigs(compiled);
    expect([...theirs].filter((s) => !ours.has(s))).toEqual([]);
    expect([...ours].filter((s) => !theirs.has(s))).toEqual([]);
  });
});
