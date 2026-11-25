import { describe, expect, it } from "vitest";
import { confirmPicks, checkConfirm } from "./session";
import { decryptSeed, encryptSeed, exportSeedFile, importSeedFile, loadSeed, saveSeed, type KvStore } from "./keystore";

const mem = (): KvStore => {
  let v: unknown = null;
  return { get: async () => v as never, put: async (x) => void (v = x) };
};
const seed = () => crypto.getRandomValues(new Uint8Array(32));

describe("keystore", () => {
  it("round-trips a seed", async () => {
    const s = seed();
    const e = await encryptSeed(s, "pw-1", 1000);
    expect(e.v).toBe(1);
    expect(e.iter).toBe(1000);
    expect(e.evm).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(await decryptSeed(e, "pw-1")).toEqual(s);
  });

  it("throws wrong password", async () => {
    const e = await encryptSeed(seed(), "right", 1000);
    await expect(decryptSeed(e, "wrong")).rejects.toThrow("wrong password");
  });

  it("saves and loads one record", async () => {
    const kv = mem();
    expect(await loadSeed(kv)).toBeNull();
    const e = await encryptSeed(seed(), "pw", 1000);
    await saveSeed(e, kv);
    expect(await loadSeed(kv)).toEqual(e);
  });

  it("exports and imports the encrypted file, rejecting bad shapes", async () => {
    const e = await encryptSeed(seed(), "pw", 1000);
    const text = await exportSeedFile(e).text();
    expect(importSeedFile(text)).toEqual(e);
    expect(text).not.toContain("QRC1");
    expect(() => importSeedFile("{}")).toThrow();
    expect(() => importSeedFile("not json")).toThrow();
    expect(() => importSeedFile(JSON.stringify({ ...e, v: 2 }))).toThrow();
  });
});

describe("confirm picks", () => {
  const code = "QRC1-" + Array.from({ length: 14 }, (_, i) => String(i % 10).repeat(4)).join("-");
  it("picks three distinct groups in 1..14", () => {
    const p = confirmPicks(code);
    expect(p).toHaveLength(3);
    expect(new Set(p).size).toBe(3);
    for (const i of p) expect(i).toBeGreaterThanOrEqual(1), expect(i).toBeLessThanOrEqual(14);
  });
  it("checkConfirm is case-insensitive and reads O as 0", () => {
    const c = "QRC1-" + ["0A0A", ...Array.from({ length: 13 }, () => "1111")].join("-");
    expect(checkConfirm(c, [1], ["0a0a"])).toBe(true);
    expect(checkConfirm(c, [1], ["OaOa"])).toBe(true);
    expect(checkConfirm(c, [1], ["0a0b"])).toBe(false);
    expect(checkConfirm(c, [2], ["liil"])).toBe(true);
  });
});
