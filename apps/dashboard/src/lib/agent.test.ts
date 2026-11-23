import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_URL, putPolicy, type Policy } from "./agent";

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
