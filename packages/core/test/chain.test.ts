import { afterEach, describe, expect, it, vi } from "vitest";
import { bigintReplacer, chain, configureEndpoints, endpoints, getJson } from "../src/chain";
import { NETWORK } from "../src/config";

describe("chain helpers", () => {
  it("renders bigint as a decimal string in JSON", () => {
    expect(JSON.stringify({ a: 10n ** 21n, b: 1 }, bigintReplacer)).toBe('{"a":"1000000000000000000000","b":1}');
  });
  it("targets diana's EVM chain id", () => {
    expect(chain.id).toBe(9800);
  });
});

describe("configurable endpoints", () => {
  afterEach(() => {
    configureEndpoints({});
    vi.unstubAllGlobals();
  });

  it("getJson uses the configured REST base", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    configureEndpoints({ rest: "/qore-rest" });
    await getJson("/x");
    expect(fetchMock).toHaveBeenCalledWith("/qore-rest/x");
  });

  it("defaults to NETWORK.rest and NETWORK.rpc after configureEndpoints({})", () => {
    configureEndpoints({ rest: "/other", rpc: "/other-rpc" });
    configureEndpoints({});
    expect(endpoints()).toEqual({ rest: NETWORK.rest, rpc: NETWORK.rpc });
  });

  it("overrides rpc independently of rest", () => {
    configureEndpoints({ rpc: "/qore-rpc" });
    expect(endpoints()).toEqual({ rest: NETWORK.rest, rpc: "/qore-rpc" });
  });
});
