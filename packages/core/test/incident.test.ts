import { ed25519 } from "@noble/curves/ed25519";
import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  incidentSigningBytes,
  signIncident,
  verifyIncident,
  type IncidentBody,
} from "../src/incident";

const sk = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const T = "0x1111111111111111111111111111111111111111" as const;
const body: IncidentBody = {
  id: "inc-1",
  detectedAt: "2026-11-20T10:00:00.000Z",
  trigger: {
    kind: "transfer",
    hash: "0xabc0000000000000000000000000000000000000000000000000000000000001",
    block: 123n,
    token: T,
    to: "0x2222222222222222222222222222222222222222",
    amount: 5n * 10n ** 18n,
  },
  reason: "recipient not in allowlist",
  rescues: [{ token: T, hash: "ABCD", amount: 7n, expected: 8n, success: true }],
  summary: "The agent rescued funds.",
  summarySource: "template",
};

describe("canonicalJson", () => {
  it("sorts keys recursively, stringifies bigint, has no whitespace", () => {
    expect(canonicalJson({ b: 1n, a: { d: [2n, { z: 1, y: 2 }], c: "x" } })).toBe(
      '{"a":{"c":"x","d":["2",{"y":2,"z":1}]},"b":"1"}',
    );
  });
});

describe("incident signing", () => {
  it("test_signedIncidentVerifies", () => {
    const signed = signIncident(body, sk);
    expect(signed.agentPubkey).toBe(Buffer.from(ed25519.getPublicKey(sk)).toString("hex"));
    expect(signed.sig).toMatch(/^[0-9a-f]{128}$/);
    expect(verifyIncident(signed)).toBe(true);
  });

  it("signing bytes carry the domain tag and exclude sig", () => {
    const signed = signIncident(body, sk);
    const text = new TextDecoder().decode(incidentSigningBytes(signed));
    expect(text.startsWith("QDAY-GUARDIAN-INCIDENT-V1\n{")).toBe(true);
    expect(text).not.toContain(signed.sig);
  });

  it("is independent of key order", () => {
    const signed = signIncident(body, sk);
    const shuffled = JSON.parse(JSON.stringify(signed, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
    // Rebuild with reversed key order; bigints become decimal strings, which canonicalise identically.
    const reversed = Object.fromEntries(Object.entries(shuffled).reverse());
    expect(verifyIncident(reversed as never)).toBe(true);
  });

  it("test_tamperedIncidentFails", () => {
    const signed = signIncident(body, sk);
    expect(verifyIncident({ ...signed, reason: "something else" })).toBe(false);
    expect(verifyIncident({ ...signed, rescues: [{ ...signed.rescues[0], amount: 8n }] })).toBe(false);
    expect(verifyIncident({ ...signed, summary: "x" })).toBe(false);
    const otherPk = Buffer.from(ed25519.getPublicKey(Uint8Array.from({ length: 32 }, () => 9))).toString("hex");
    expect(verifyIncident({ ...signed, agentPubkey: otherPk })).toBe(false);
  });

  it("signs the trigger kind: flipping it fails verification", () => {
    const signed = signIncident(body, sk);
    expect(verifyIncident({ ...signed, trigger: { ...signed.trigger, kind: "approval" } })).toBe(false);
  });

  it("an old incident whose trigger has no kind still signs and verifies (no default is added)", () => {
    const { kind: _kind, ...oldTrigger } = body.trigger;
    const signed = signIncident({ ...body, trigger: oldTrigger } as never, sk);
    expect(new TextDecoder().decode(incidentSigningBytes(signed))).not.toContain('"kind"');
    expect(verifyIncident(signed)).toBe(true);
  });

  it("returns false (never throws) on malformed hex", () => {
    const signed = signIncident(body, sk);
    expect(verifyIncident({ ...signed, sig: "zz" })).toBe(false);
    expect(verifyIncident({ ...signed, agentPubkey: "nothex" })).toBe(false);
    expect(verifyIncident({ ...signed, sig: "" })).toBe(false);
  });
});

describe("guardian co-signature (submission gap 3)", () => {
  const G = "qor1l7pv44nr3gudwqyap4wlkat3x6cvqwzsvtm0pt";
  const fakeSig = (bytes: Uint8Array) => ({
    signatureType: "ml-dsa-87-hybrid" as const,
    classical: { keyType: "eth_secp256k1", publicKey: "PK", signature: Buffer.from(bytes).toString("base64").slice(0, 16) },
    pq: { algorithmId: 1, signature: "PQ" },
  });

  it("co-signs the same bytes the ed25519 key signs, with `guardian` inside them and both signatures outside", () => {
    let seen: Uint8Array | undefined;
    const signed = signIncident(body, sk, { guardian: G, sign: (b) => ((seen = b), fakeSig(b)) });
    expect(signed.guardian).toBe(G);
    expect(signed.guardianSig?.signatureType).toBe("ml-dsa-87-hybrid");
    expect(verifyIncident(signed)).toBe(true);
    expect(Buffer.from(seen!).equals(Buffer.from(incidentSigningBytes(signed)))).toBe(true);
    const text = new TextDecoder().decode(incidentSigningBytes(signed));
    expect(text).toContain(`"guardian":"${G}"`);
    expect(text).not.toContain("guardianSig");
    expect(text).not.toContain(signed.sig);
  });

  it("adding or changing guardianSig does not touch the ed25519 bytes", () => {
    const signed = signIncident(body, sk, { guardian: G, sign: fakeSig });
    const swapped = { ...signed, guardianSig: { ...signed.guardianSig!, pq: { algorithmId: 1, signature: "OTHER" } } };
    expect(verifyIncident(swapped)).toBe(true);
    const { guardianSig: _g, ...without } = signed;
    expect(verifyIncident(without)).toBe(true);
  });

  it("the ed25519 signature covers `guardian`: changing it fails", () => {
    const signed = signIncident(body, sk, { guardian: G, sign: fakeSig });
    expect(verifyIncident({ ...signed, guardian: "qor1other" })).toBe(false);
  });

  it("a co-signer that throws leaves a plain ed25519 report (no guardian field) and reports the error", () => {
    const errors: unknown[] = [];
    const signed = signIncident(body, sk, {
      guardian: G,
      sign: () => {
        throw new Error("pq key unavailable");
      },
      onError: (e) => void errors.push(e),
    });
    expect(signed.guardian).toBeUndefined();
    expect(signed.guardianSig).toBeUndefined();
    expect(verifyIncident(signed)).toBe(true);
    expect(String(errors[0])).toMatch(/pq key unavailable/);
    expect(new TextDecoder().decode(incidentSigningBytes(signed))).toBe(new TextDecoder().decode(incidentSigningBytes(signIncident(body, sk))));
  });
});
