import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createPolicyStore, parsePolicy, policyFilePath, seedPolicy, toRulesPolicy, type PolicyFile } from "../src/policy";

const VAULT = "0x17d867860a0A0Ff528dF655439ff59176b061B3C" as const;
const A = "0x4444444444444444444444444444444444444444" as const;
const B = "0x5555555555555555555555555555555555555555" as const;
const good: PolicyFile = { trusted: [{ label: "cold wallet", address: A, kind: "wallet" }], maxOutbound: "1000" };
const tmp = () => mkdtempSync(join(tmpdir(), "qday-policy-"));

describe("parsePolicy", () => {
  it("accepts a valid policy and trims labels", () => {
    const p = parsePolicy({ trusted: [{ label: "  dex  ", address: A, kind: "app" }], maxOutbound: "0" });
    expect(p).toEqual({ trusted: [{ label: "dex", address: A, kind: "app" }], maxOutbound: "0" });
    expect(parsePolicy({ trusted: [], maxOutbound: "1" })).toEqual({ trusted: [], maxOutbound: "1" });
  });

  it("rejects anything that is not exactly {trusted, maxOutbound}", () => {
    expect(() => parsePolicy(null)).toThrow(/object/);
    expect(() => parsePolicy([])).toThrow(/object/);
    expect(() => parsePolicy("x")).toThrow(/object/);
    expect(() => parsePolicy({ trusted: [] })).toThrow(/maxOutbound/);
    expect(() => parsePolicy({ maxOutbound: "1" })).toThrow(/trusted/);
    expect(() => parsePolicy({ ...good, extra: 1 })).toThrow(/unknown key.*extra/);
  });

  it("rejects bad trusted entries", () => {
    const e = (entry: unknown) => () => parsePolicy({ trusted: [entry], maxOutbound: "1" });
    expect(() => parsePolicy({ trusted: {}, maxOutbound: "1" })).toThrow(/trusted.*array/);
    expect(e(null)).toThrow(/trusted\[0\]/);
    expect(e({ label: "x", address: A })).toThrow(/kind/);
    expect(e({ label: "x", address: A, kind: "app", note: "y" })).toThrow(/unknown key.*note/);
    expect(e({ label: "", address: A, kind: "app" })).toThrow(/label/);
    expect(e({ label: "   ", address: A, kind: "app" })).toThrow(/label/);
    expect(e({ label: "x".repeat(65), address: A, kind: "app" })).toThrow(/label/);
    expect(e({ label: 5, address: A, kind: "app" })).toThrow(/label/);
    expect(e({ label: "x", address: "0x1234", kind: "app" })).toThrow(/address/);
    expect(e({ label: "x", address: A, kind: "exchange" })).toThrow(/kind/);
  });

  it("rejects duplicate addresses (case-insensitive) and more than 200 entries", () => {
    const dup = { trusted: [{ label: "a", address: A, kind: "app" }, { label: "b", address: A.toUpperCase().replace("0X", "0x"), kind: "wallet" }], maxOutbound: "1" };
    expect(() => parsePolicy(dup)).toThrow(/duplicate/);
    const many = Array.from({ length: 201 }, (_, i) => ({ label: `w${i}`, address: `0x${i.toString(16).padStart(40, "0")}`, kind: "wallet" }));
    expect(() => parsePolicy({ trusted: many, maxOutbound: "1" })).toThrow(/200/);
    expect(parsePolicy({ trusted: many.slice(0, 200), maxOutbound: "1" }).trusted).toHaveLength(200);
  });

  it("rejects a maxOutbound that is not a decimal integer string of at most 78 digits", () => {
    const m = (v: unknown) => () => parsePolicy({ trusted: [], maxOutbound: v });
    expect(m(1000)).toThrow(/maxOutbound/);
    expect(m("1.5")).toThrow(/maxOutbound/);
    expect(m("-1")).toThrow(/maxOutbound/);
    expect(m("")).toThrow(/maxOutbound/);
    expect(m("1".repeat(79))).toThrow(/maxOutbound/);
    expect(m("1".repeat(78))).not.toThrow();
  });
});

describe("policy helpers", () => {
  it("policyFilePath is per owner, lowercase", () => {
    expect(policyFilePath("/d", "0xAbCdEf0000000000000000000000000000000001")).toBe("/d/policy-0xabcdef0000000000000000000000000000000001.json");
    expect(() => policyFilePath("/d", "../../etc" as never)).toThrow(/owner/);
  });

  it("seedPolicy turns ALLOWLIST/MAX_OUTBOUND into a valid policy", () => {
    const s = seedPolicy([A, B], 42n);
    expect(s).toEqual({
      trusted: [{ label: "ALLOWLIST", address: A, kind: "wallet" }, { label: "ALLOWLIST", address: B, kind: "wallet" }],
      maxOutbound: "42",
    });
    expect(parsePolicy(s)).toEqual(s);
    expect(seedPolicy([A, A.toLowerCase() as `0x${string}`], 1n).trusted).toHaveLength(1); // a duplicated env entry never blocks startup
  });

  it("toRulesPolicy maps to the rules.ts Policy", () => {
    expect(toRulesPolicy(VAULT, good)).toEqual({ vault: VAULT, allowlist: [A], maxOutbound: 1000n });
  });
});

describe("createPolicyStore", () => {
  it("writes the seed when the file is missing (mkdir -p, mode 0600)", () => {
    const file = join(tmp(), "nested", "policy.json");
    const store = createPolicyStore({ file, seed: good, log: () => {} });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(good);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(store.get()).toEqual(good);
  });

  it("uses an existing file over the seed", () => {
    const file = join(tmp(), "policy.json");
    writeFileSync(file, JSON.stringify({ trusted: [], maxOutbound: "7" }));
    expect(createPolicyStore({ file, seed: good, log: () => {} }).get()).toEqual({ trusted: [], maxOutbound: "7" });
  });

  it("refuses to start on an invalid file", () => {
    const file = join(tmp(), "policy.json");
    writeFileSync(file, "{not json");
    expect(() => createPolicyStore({ file, seed: good, log: () => {} })).toThrow(/policy/);
    writeFileSync(file, JSON.stringify({ trusted: [], maxOutbound: 7 }));
    expect(() => createPolicyStore({ file, seed: good, log: () => {} })).toThrow(/maxOutbound/);
  });

  it("reloads a changed file; keeps the last good policy (logged once) when it turns invalid or goes missing", () => {
    const file = join(tmp(), "policy.json");
    const lines: string[] = [];
    const store = createPolicyStore({ file, seed: good, log: (l) => void lines.push(l) });
    const next = { trusted: [{ label: "dex", address: B, kind: "app" as const }], maxOutbound: "5" };
    writeFileSync(file, JSON.stringify(next));
    expect(store.get()).toEqual(next);

    writeFileSync(file, "{broken");
    expect(store.get()).toEqual(next);
    expect(store.get()).toEqual(next);
    expect(lines.filter((l) => /invalid/.test(l))).toHaveLength(1);

    writeFileSync(file, JSON.stringify(good, null, 2));
    expect(store.get()).toEqual(good);
  });

  it("set() validates, writes atomically (no temp file left) and returns the stored policy", () => {
    const dir = tmp();
    const file = join(dir, "policy.json");
    const store = createPolicyStore({ file, seed: good, log: () => {} });
    expect(() => store.set({ trusted: "nope", maxOutbound: "1" })).toThrow(/trusted/);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(good); // unchanged
    const stored = store.set({ trusted: [{ label: " x ", address: B, kind: "wallet" }], maxOutbound: "9" });
    expect(stored).toEqual({ trusted: [{ label: "x", address: B, kind: "wallet" }], maxOutbound: "9" });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(stored);
    expect(store.get()).toEqual(stored);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["policy.json"]);
    expect(existsSync(file)).toBe(true);
  });
});
