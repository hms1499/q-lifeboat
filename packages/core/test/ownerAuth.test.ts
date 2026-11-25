import { generatePqcKeypair, type PqcStatus } from "@qorechain/sdk";
import { bytesToHex } from "viem";
import { canonicalJson } from "../src/incident";
import { describe, expect, it } from "vitest";
import {
  ownerRequestBytes,
  signOwnerRequest,
  verifyOwnerRequest,
  type OwnerRequest,
} from "../src/ownerAuth";

const NOW = 1_800_000_000;
const kp = generatePqcKeypair(new Uint8Array(32).fill(7));
const other = generatePqcKeypair(new Uint8Array(32).fill(9));
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));

const req = (over: Partial<OwnerRequest> = {}): OwnerRequest => ({
  owner: "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01",
  purpose: "policy",
  body: { b: 1, a: { d: 2, c: 3 }, big: 5n },
  nonce: "n-1",
  expiresAt: NOW + 60,
  ...over,
});
const reg = (over: Partial<PqcStatus> = {}): PqcStatus => ({
  registered: true,
  pubkey: kp.publicKey,
  possessionProven: true,
  ...over,
});

describe("canonicalJson", () => {
  it("sorts keys recursively", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
  it("renders bigint as a decimal string", () => {
    expect(canonicalJson({ x: 10n })).toBe('{"x":"10"}');
  });
});

describe("ownerRequestBytes", () => {
  it("has the versioned prefix and a lowercase owner", () => {
    const text = new TextDecoder().decode(ownerRequestBytes(req()));
    expect(text.startsWith("qlifeboat-owner-request-v1\n{")).toBe(true);
    expect(text).toContain('"owner":"0xabcdef0123456789abcdef0123456789abcdef01"');
    expect(text.indexOf('"owner"')).toBeLessThan(text.indexOf('"purpose"'));
    expect(text.indexOf('"bodySha256"')).toBeLessThan(text.indexOf('"nonce"'));
  });
});

describe("verifyOwnerRequest", () => {
  it("accepts a valid request (bytes pubkey)", () => {
    const s = signOwnerRequest(req(), kp.secretKey);
    expect(verifyOwnerRequest(s, reg(), NOW)).toEqual({ ok: true });
  });
  it("accepts a base64 and a hex pubkey", () => {
    const s = signOwnerRequest(req(), kp.secretKey);
    expect(verifyOwnerRequest(s, reg({ pubkey: b64(kp.publicKey) }), NOW)).toEqual({ ok: true });
    expect(verifyOwnerRequest(s, reg({ pubkey: bytesToHex(kp.publicKey) }), NOW)).toEqual({ ok: true });
  });
  it("rejects a body changed after signing", () => {
    const s = signOwnerRequest(req(), kp.secretKey);
    const tampered = { ...s, request: { ...s.request, body: { a: 1 } } };
    expect(verifyOwnerRequest(tampered, reg(), NOW)).toEqual({ ok: false, reason: "bad-signature" });
  });
  it("rejects a signature by another keypair", () => {
    const s = signOwnerRequest(req(), other.secretKey);
    expect(verifyOwnerRequest(s, reg(), NOW)).toEqual({ ok: false, reason: "bad-signature" });
  });
  it("rejects expired and too-far requests", () => {
    const expired = signOwnerRequest(req({ expiresAt: NOW - 1 }), kp.secretKey);
    expect(verifyOwnerRequest(expired, reg(), NOW)).toEqual({ ok: false, reason: "expired" });
    const far = signOwnerRequest(req({ expiresAt: NOW + 301 }), kp.secretKey);
    expect(verifyOwnerRequest(far, reg(), NOW)).toEqual({ ok: false, reason: "too-far" });
    const edge = signOwnerRequest(req({ expiresAt: NOW + 300 }), kp.secretKey);
    expect(verifyOwnerRequest(edge, reg(), NOW)).toEqual({ ok: true });
  });
  it("rejects an unregistered or unproven key", () => {
    const s = signOwnerRequest(req(), kp.secretKey);
    expect(verifyOwnerRequest(s, reg({ registered: false }), NOW)).toEqual({ ok: false, reason: "not-registered" });
    expect(verifyOwnerRequest(s, reg({ possessionProven: false }), NOW)).toEqual({ ok: false, reason: "not-proven" });
  });
  it("rejects a malformed signature without throwing", () => {
    const s = signOwnerRequest(req(), kp.secretKey);
    expect(verifyOwnerRequest({ ...s, sig: "0x1234" }, reg(), NOW)).toEqual({ ok: false, reason: "bad-signature" });
  });
});
