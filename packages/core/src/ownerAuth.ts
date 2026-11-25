import { pqcSign, pqcStatusPublicKey, pqcVerify, type PqcStatus } from "@qorechain/sdk";
import { canonicalJson } from "./incident";
import { bytesToHex, hexToBytes, isHex, sha256, type Hex } from "viem";

export type OwnerPurpose = "onboard" | "activate" | "policy" | "arm" | "stop" | "topup";

export type OwnerRequest = {
  owner: Hex;
  purpose: OwnerPurpose;
  body: unknown;
  nonce: string;
  expiresAt: number;
};

export type SignedOwnerRequest = { request: OwnerRequest; sig: Hex };

export type VerifyOwnerResult =
  | { ok: true }
  | { ok: false; reason: "expired" | "too-far" | "not-registered" | "not-proven" | "bad-signature" };

/** Hosted API shapes shared by apps/hosted and the dashboard. */
export type OwnerStage = "starter" | "provisioned" | "active" | "retired";
export type OwnerPublicState = { stage: OwnerStage | "none"; guardian?: Hex; vault?: Hex };
export type HostedStatus = { onboarding: "open" | "paused"; reason?: string; activeGuardians: number };

/** Longest allowed lifetime of a signed request, in seconds. */
export const OWNER_REQUEST_MAX_TTL = 300;

const PREFIX = "qlifeboat-owner-request-v1\n";

/** The exact bytes an owner signs. */
export function ownerRequestBytes(r: OwnerRequest): Uint8Array {
  const bodySha256 = sha256(new TextEncoder().encode(canonicalJson(r.body))).slice(2);
  const text =
    PREFIX +
    JSON.stringify({
      owner: r.owner.toLowerCase(),
      purpose: r.purpose,
      bodySha256,
      nonce: r.nonce,
      expiresAt: r.expiresAt,
    });
  return new TextEncoder().encode(text);
}

export function signOwnerRequest(r: OwnerRequest, pqcSecretKey: Uint8Array): SignedOwnerRequest {
  return { request: r, sig: bytesToHex(pqcSign(pqcSecretKey, ownerRequestBytes(r))) };
}

export function verifyOwnerRequest(
  signed: SignedOwnerRequest,
  registered: PqcStatus,
  nowUnix: number,
): VerifyOwnerResult {
  const { request, sig } = signed;
  if (request.expiresAt < nowUnix) return { ok: false, reason: "expired" };
  if (request.expiresAt > nowUnix + OWNER_REQUEST_MAX_TTL) return { ok: false, reason: "too-far" };
  if (!registered.registered) return { ok: false, reason: "not-registered" };
  if (registered.possessionProven !== true) return { ok: false, reason: "not-proven" };
  // pqcStatusPublicKey decodes bytes, hex and base64 (diana's REST returns base64).
  const pub = pqcStatusPublicKey(registered);
  if (!pub || !isHex(sig)) return { ok: false, reason: "bad-signature" };
  let ok = false;
  try {
    ok = pqcVerify(pub, ownerRequestBytes(request), hexToBytes(sig));
  } catch {
    ok = false;
  }
  return ok ? { ok: true } : { ok: false, reason: "bad-signature" };
}
