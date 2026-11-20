import { describe, expect, it } from "vitest";
import { bigintReplacer, chain } from "../src/chain";

describe("chain helpers", () => {
  it("renders bigint as a decimal string in JSON", () => {
    expect(JSON.stringify({ a: 10n ** 21n, b: 1 }, bigintReplacer)).toBe('{"a":"1000000000000000000000","b":1}');
  });
  it("targets diana's EVM chain id", () => {
    expect(chain.id).toBe(9800);
  });
});
