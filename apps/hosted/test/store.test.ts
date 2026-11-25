import { mkdtempSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createStore, type OwnerState } from "../src/store.ts";

const A = "0x" + "AB".repeat(20);
const mk = (owner: string, stage: OwnerState["stage"] = "starter"): OwnerState => ({
  owner: owner as OwnerState["owner"], stage, createdAt: 1, lastActiveAt: 2, topups: 0,
});

describe("store", () => {
  it("round-trips, lowercases keys, lists", () => {
    const s = createStore(mkdtempSync(join(tmpdir(), "hs-")));
    expect(s.get(A)).toBeNull();
    s.put(mk(A));
    s.put(mk("0x" + "cd".repeat(20), "active"));
    expect(s.get(A.toLowerCase())?.stage).toBe("starter");
    expect(s.get(A)?.owner).toBe(A.toLowerCase());
    expect(s.list().length).toBe(2);
  });
  it("rejects a malformed owner", () => {
    const s = createStore(mkdtempSync(join(tmpdir(), "hs-")));
    expect(() => s.get("../etc")).toThrow();
    expect(() => s.put(mk("0x12"))).toThrow();
  });
  it("writes secrets with mode 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-"));
    const s = createStore(dir);
    s.writeSecrets(A, { GAS_MNEMONIC: "m", AGENT_ED25519_SK: "k" });
    expect(s.readSecrets(A)).toEqual({ GAS_MNEMONIC: "m", AGENT_ED25519_SK: "k" });
    const f = join(dir, "owners", A.toLowerCase(), "secrets.json");
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(s.readSecrets("0x" + "11".repeat(20))).toBeNull();
  });
  it("a crash between temp write and rename keeps the previous state", () => {
    const dir = mkdtempSync(join(tmpdir(), "hs-"));
    const s = createStore(dir);
    s.put(mk(A, "starter"));
    const od = join(dir, "owners", A.toLowerCase());
    writeFileSync(join(od, "state.json.tmp"), '{"owner":"0x', "utf8"); // torn temp from a crash
    expect(s.get(A)?.stage).toBe("starter");
    s.put(mk(A, "active")); // next write recovers
    expect(s.get(A)?.stage).toBe("active");
    expect(readdirSync(od).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
