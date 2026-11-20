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
    hash: "0xabc0000000000000000000000000000000000000000000000000000000000001",
    block: 123n,
    token: T,
    to: "0x2222222222222222222222222222222222222222",
    amount: 5n * 10n ** 18n,
  },
  reason: "recipient not in allowlist",
  rescues: [{ token: T, hash: "ABCD", amount: 7n, success: true }],
  summary: "The agent rescued funds.",
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

  it("returns false (never throws) on malformed hex", () => {
    const signed = signIncident(body, sk);
    expect(verifyIncident({ ...signed, sig: "zz" })).toBe(false);
    expect(verifyIncident({ ...signed, agentPubkey: "nothex" })).toBe(false);
    expect(verifyIncident({ ...signed, sig: "" })).toBe(false);
  });
});
