import { describe, expect, it } from "vitest";
import { EXPLORER, explorerTxUrl } from "./chain";

const HEX64 = "a6b34d03".repeat(8);

describe("explorerTxUrl (diana's explorer indexes native-lane txs only)", () => {
  it("a 0x EVM hash gets no link (the explorer has no EVM tx page)", () => {
    expect(explorerTxUrl(`0x${HEX64}`)).toBeNull();
    expect(explorerTxUrl(`0x${HEX64.toUpperCase()}`)).toBeNull();
  });

  it("a 64-hex Cosmos hash without 0x, any case, links to the explorer", () => {
    expect(explorerTxUrl(HEX64.toUpperCase())).toBe(`${EXPLORER}/tx/${HEX64.toUpperCase()}`);
    expect(explorerTxUrl(HEX64)).toBe(`${EXPLORER}/tx/${HEX64}`);
  });

  it("anything else gets no link", () => {
    for (const bad of ["", "0x", "abc", HEX64.slice(1), `${HEX64}00`, `${HEX64.slice(1)}z`, ` ${HEX64}`]) {
      expect(explorerTxUrl(bad), bad).toBeNull();
    }
  });
});
