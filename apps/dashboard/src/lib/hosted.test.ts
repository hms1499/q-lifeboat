import { encodeLinkProof, verifyOwnerRequest, type SignedOwnerRequest } from "@qday/core";
import { generatePqcRecoveryCode, signAuthenticatorLinkEd25519, unifiedAccountFromSeed, type PqcStatus } from "@qorechain/sdk";
import { bytesToHex } from "viem";
import { describe, expect, it } from "vitest";
import { createHosted, HostedError, SIGNED_TTL_SECONDS } from "./hosted";

const acc = unifiedAccountFromSeed(new Uint8Array(32).fill(7), { recoveryCode: generatePqcRecoveryCode() });
const OWNER = acc.evm.toLowerCase();
const NOW = 1_800_000_000_000;

type Req = { url: string; method: string; body: unknown };

/** A fetch that records requests and answers from `reply(url)`. */
function fakeFetch(reply: (url: string, method: string) => { status: number; body: unknown }) {
  const reqs: Req[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    reqs.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
    const r = reply(url, method);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, reqs };
}

const mk = (reply: Parameters<typeof fakeFetch>[0], account: () => typeof acc | null = () => acc) => {
  const ff = fakeFetch(reply);
  let n = 0;
  const h = createHosted({ fetchImpl: ff.f, account, now: () => NOW, uuid: () => `nonce-${++n}` });
  return { h, reqs: ff.reqs };
};

const registered: PqcStatus = { registered: true, possessionProven: true, pubkey: btoa(String.fromCharCode(...acc.pqc.publicKey)) };

describe("signed", () => {
  it("builds an OwnerRequest for the session's account: random nonce, expiresAt = now + 120, ML-DSA signed", () => {
    const { h } = mk(() => ({ status: 200, body: {} }));
    const s = h.signed("arm", { blocks: 600 });
    expect(SIGNED_TTL_SECONDS).toBe(120);
    expect(s.request).toEqual({ owner: OWNER, purpose: "arm", body: { blocks: 600 }, nonce: "nonce-1", expiresAt: NOW / 1000 + 120 });
    expect(verifyOwnerRequest(s, registered, NOW / 1000)).toEqual({ ok: true });
    expect(h.signed("arm", { blocks: 600 }).request.nonce).toBe("nonce-2");
  });

  it("refuses to sign while the post-quantum key is not unlocked", () => {
    const { h } = mk(() => ({ status: 200, body: {} }), () => null);
    expect(() => h.signed("onboard", {})).toThrow(/recovery code/);
  });

  it("the default nonce is a UUID", () => {
    const h = createHosted({ fetchImpl: fakeFetch(() => ({ status: 200, body: {} })).f, account: () => acc });
    expect(h.signed("onboard", {}).request.nonce).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("routes", () => {
  it("status, owner state and starter", async () => {
    const { h, reqs } = mk((url) =>
      url.endsWith("/api/status")
        ? { status: 200, body: { onboarding: "open", activeGuardians: 2 } }
        : url.includes("/api/owner/")
          ? { status: 200, body: { stage: "starter" } }
          : { status: 200, body: { tx: "AB".repeat(32) } },
    );
    expect(await h.status()).toEqual({ onboarding: "open", activeGuardians: 2 });
    expect(await h.owner(acc.evm)).toEqual({ stage: "starter" });
    expect(await h.starter(acc.evm)).toEqual({ tx: "AB".repeat(32) });
    expect(reqs.map((r) => `${r.method} ${r.url}`)).toEqual([`GET /api/status`, `GET /api/owner/${OWNER}`, `POST /api/starter`]);
    expect(reqs[2].body).toEqual({ owner: OWNER });
  });

  it("onboard decodes the hex link proof", async () => {
    const proof = signAuthenticatorLinkEd25519({ chainId: "qorechain-diana", account: acc.cosmos, privateKey: new Uint8Array(32).fill(9) });
    const json = encodeLinkProof({ ...proof, agentPubKeyHex: bytesToHex(proof.pubkey) });
    const guardian = "0x1111111111111111111111111111111111111111";
    const { h, reqs } = mk(() => ({ status: 200, body: { guardian, linkProof: json } }));
    const s = h.signed("onboard", {});
    const r = await h.onboard(s);
    expect(r.guardian).toBe(guardian);
    expect(r.linkProof.pubkey).toEqual(proof.pubkey);
    expect(r.linkProof.possessionProof).toEqual(proof.possessionProof);
    expect(reqs[0]).toMatchObject({ method: "POST", url: "/api/onboard", body: s });
  });

  it("onboard refuses a reply without a guardian address", async () => {
    const { h } = mk(() => ({ status: 200, body: { guardian: "nope", linkProof: {} } }));
    await expect(h.onboard(h.signed("onboard", {}))).rejects.toThrow(/guardian/);
  });

  it("activate, topup, arm and policy post the signed request to their routes", async () => {
    const { h, reqs } = mk((url) => (url.endsWith("/arm") ? { status: 200, body: { tx: null } } : { status: 200, body: { ok: true, tx: "T" } }));
    const s = (p: SignedOwnerRequest["request"]["purpose"]) => h.signed(p, {});
    await h.activate(s("activate"));
    await h.topup(s("topup"));
    expect(await h.arm(acc.evm, s("arm"))).toEqual({ tx: null });
    await h.policy(acc.evm, s("policy"));
    expect(reqs.map((r) => `${r.method} ${r.url}`)).toEqual([
      "POST /api/activate",
      "POST /api/topup",
      `POST /api/o/${OWNER}/arm`,
      `PUT /api/o/${OWNER}/policy`,
    ]);
  });

  it("a refusal throws HostedError with the status, the code and a plain message", async () => {
    const { h } = mk(() => ({ status: 429, body: { error: "ip-limit" } }));
    const e = await h.starter(acc.evm).catch((x) => x);
    expect(e).toBeInstanceOf(HostedError);
    expect(e.status).toBe(429);
    expect(e.code).toBe("ip-limit");
    expect(e.message).toMatch(/network/);
  });

  it("a 404 from the gateway is an error, not swallowed", async () => {
    const { h } = mk(() => ({ status: 404, body: { error: "not found" } }));
    const e = await h.arm(acc.evm, h.signed("arm", { blocks: 600 })).catch((x) => x);
    expect(e).toBeInstanceOf(HostedError);
    expect(e.status).toBe(404);
  });

  it("a non-JSON error body still throws with the status", async () => {
    const f = (async () => new Response("<html>bad gateway</html>", { status: 502 })) as typeof fetch;
    const h = createHosted({ fetchImpl: f, account: () => acc });
    await expect(h.status()).rejects.toThrow(/502/);
  });
});
