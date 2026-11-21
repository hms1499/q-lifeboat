import { NETWORK } from "@qday/core";
import { describe, expect, it } from "vitest";
import { DIANA_REST, REST_PROXY_PATH as VITE_PROXY_PATH, restProxyRewrite } from "../../vite.config";
import { REST_PROXY_PATH } from "./chain";
import { checkConfigOnChain, loadCachedConfig, parseAgentConfig, saveCachedConfig, type AgentConfig } from "./config";

const A: `0x${string}` = "0x1111111111111111111111111111111111111111";
const B: `0x${string}` = "0x2222222222222222222222222222222222222222";
const C: `0x${string}` = "0x3333333333333333333333333333333333333333";
const good: AgentConfig = { owner: A, vault: B, guardian: C, tokens: { fUSD: A, fETH: B, fBTC: C }, evmChainId: 9800 };

describe("parseAgentConfig", () => {
  it("accepts the agent's GET /config body", () => {
    expect(parseAgentConfig(good)).toEqual(good);
  });

  it("rejects a missing or malformed address, a missing token, extra keys and another chain", () => {
    expect(() => parseAgentConfig({ ...good, owner: "0x12" })).toThrow(/owner/);
    expect(() => parseAgentConfig({ ...good, tokens: { fUSD: A, fETH: B } })).toThrow(/fBTC/);
    expect(() => parseAgentConfig({ ...good, evmChainId: 1 })).toThrow(/9800/);
    expect(() => parseAgentConfig({ ...good, mnemonic: "x" })).toThrow(/mnemonic/);
    expect(() => parseAgentConfig(null)).toThrow();
  });
});

describe("checkConfigOnChain", () => {
  it("passes when vault.owner() and vault.guardian() match (any case)", () => {
    expect(checkConfigOnChain(good, { owner: A.toUpperCase().replace("0X", "0x"), guardian: C }).ok).toBe(true);
  });

  it("fails naming the field that differs", () => {
    const o = checkConfigOnChain(good, { owner: B, guardian: C });
    expect(o.ok).toBe(false);
    expect(o.detail).toMatch(/owner/);
    const g = checkConfigOnChain(good, { owner: A, guardian: A });
    expect(g.ok).toBe(false);
    expect(g.detail).toMatch(/guardian/);
  });
});

describe("config cache", () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };

  it("round-trips the last good config, and ignores a corrupt entry", () => {
    const s = mem();
    expect(loadCachedConfig(s)).toBeNull();
    saveCachedConfig(s, good);
    expect(loadCachedConfig(s)).toEqual(good);
    s.setItem("qday.dashboard.config.v1", "{bad");
    expect(loadCachedConfig(s)).toBeNull();
  });
});

describe("REST proxy target", () => {
  it("vite.config's DIANA_REST is NETWORK.rest, and the browser uses the proxy path vite serves", () => {
    expect(DIANA_REST).toBe(NETWORK.rest);
    expect(REST_PROXY_PATH).toBe(VITE_PROXY_PATH);
  });
});

describe("restProxyRewrite", () => {
  it("strips /qore-rest only as a whole path segment", () => {
    expect(restProxyRewrite("/qore-rest/qorechain/pqc/v1/evm_window/qor1x")).toBe("/qorechain/pqc/v1/evm_window/qor1x");
    expect(restProxyRewrite("/qore-rest")).toBe("/");
    expect(restProxyRewrite("/qore-rest?x=1")).toBe("/?x=1");
    expect(restProxyRewrite("/qore-restx/y")).toBe("/qore-restx/y");
  });
});
