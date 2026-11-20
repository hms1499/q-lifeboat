import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { toFunctionSelector, type Abi } from "viem";
import { describe, expect, it } from "vitest";
import { RESCUE_SELECTOR, vaultAbi } from "../src/abi";

const ARTIFACT = fileURLToPath(
  new URL("../../../contracts/out/GuardianVault.sol/GuardianVault.json", import.meta.url),
);

type Item = Record<string, unknown>;
const param = (p: Item): Item => {
  const out: Item = { type: p.type };
  if ("indexed" in p) out.indexed = p.indexed;
  if (p.components) out.components = (p.components as Item[]).map(param);
  return out;
};
// Normalised view of the constructor and every function/event/error: drops internalType and param names.
const norm = (abi: Abi) =>
  new Set(
    (abi as unknown as Item[])
      .filter((i) => ["constructor", "function", "event", "error"].includes(i.type as string))
      .map((i) =>
        JSON.stringify({
          type: i.type,
          name: i.name,
          inputs: ((i.inputs as Item[]) ?? []).map(param),
          outputs: ((i.outputs as Item[]) ?? []).map(param),
          stateMutability: i.stateMutability ?? null,
          anonymous: i.anonymous ?? null,
        }),
      ),
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
    const ours = norm(vaultAbi as unknown as Abi);
    const theirs = norm(compiled);
    expect([...theirs].filter((s) => !ours.has(s))).toEqual([]);
    expect([...ours].filter((s) => !theirs.has(s))).toEqual([]);
  });
});
