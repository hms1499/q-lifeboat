import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_URL, agentBase, fetchHealth, NO_AGENT, onAgentBaseChange, putPolicy, resetAgentBase, setAgentBase, subscribeIncidents, type Policy } from "./agent";

const policy: Policy = { trusted: [{ label: "Alice", address: "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01", kind: "wallet" }], maxOutbound: "0" };

function stubFetch(status: number, body: unknown) {
  const f = vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", f);
  return f;
}

describe("putPolicy", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("PUTs the whole policy as JSON with a timeout and returns the saved policy", async () => {
    const f = stubFetch(200, policy);
    expect(await putPolicy(policy)).toEqual(policy);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${AGENT_URL}/policy`);
    expect(init.method).toBe("PUT");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual(policy);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("throws the server's {error} verbatim on a non-2xx", async () => {
    stubFetch(403, { error: "origin not allowed" });
    await expect(putPolicy(policy)).rejects.toThrow(/^origin not allowed$/);
    stubFetch(400, { error: "policy.trusted[0].address must be a 0x address" });
    await expect(putPolicy(policy)).rejects.toThrow("policy.trusted[0].address must be a 0x address");
  });

  it("throws HTTP <status> when the error body has no {error}", async () => {
    stubFetch(500, "not json");
    await expect(putPolicy(policy)).rejects.toThrow(/^HTTP 500$/);
    stubFetch(404, { nope: true });
    await expect(putPolicy(policy)).rejects.toThrow(/^HTTP 404$/);
  });

  it("refuses a 2xx body that is not a policy", async () => {
    stubFetch(200, { ok: true });
    await expect(putPolicy(policy)).rejects.toThrow(/unexpected body/);
  });
});

describe("agent base (hosted: /api/o/<owner>)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetAgentBase();
  });

  it("defaults to AGENT_URL with no expected owner (a local build)", () => {
    expect(agentBase()).toEqual({ url: AGENT_URL, owner: null });
  });

  it("setAgentBase points every read at the new base, names its owner and tells listeners", async () => {
    const seen: string[] = [];
    const off = onAgentBaseChange((b) => seen.push(b.url));
    setAgentBase("http://h.test/api/o/0xabc/", "0xABC");
    expect(agentBase()).toEqual({ url: "http://h.test/api/o/0xabc", owner: "0xabc" });
    const f = stubFetch(200, { ok: true });
    await fetchHealth();
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("http://h.test/api/o/0xabc/health");
    off();
    setAgentBase("http://h.test/api/o/0xdef", "0xdef");
    expect(seen).toEqual(["http://h.test/api/o/0xabc"]);
  });
});

describe("putPolicy through the hosted gateway", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("with a signer, sends { request, sig } with purpose policy and the policy as body", async () => {
    const f = stubFetch(200, policy);
    const sign = vi.fn((p: Policy) => ({ request: { owner: "0xabc", purpose: "policy", body: p, nonce: "n", expiresAt: 1 }, sig: "0x01" }));
    expect(await putPolicy(policy, sign)).toEqual(policy);
    expect(sign).toHaveBeenCalledWith(policy);
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toEqual({ request: { owner: "0xabc", purpose: "policy", body: policy, nonce: "n", expiresAt: 1 }, sig: "0x01" });
  });
});

describe("no agent (hosted build, no wallet in this browser yet)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetAgentBase();
  });

  it("reads nothing: requests reject without a fetch, and the event stream opens nothing", async () => {
    const f = stubFetch(200, {});
    const es = vi.fn();
    vi.stubGlobal("EventSource", es);
    setAgentBase(NO_AGENT, null);
    expect(agentBase().url).toBe(NO_AGENT);
    await expect(fetchHealth()).rejects.toThrow(/no Guardian/);
    const stop = subscribeIncidents(() => {}, () => {}, () => {});
    stop();
    expect(f).not.toHaveBeenCalled();
    expect(es).not.toHaveBeenCalled();
  });
});
