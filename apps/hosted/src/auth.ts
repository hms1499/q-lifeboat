import { OWNER_REQUEST_MAX_TTL, verifyOwnerRequest, type OwnerPurpose, type SignedOwnerRequest } from "@qday/core";
import { addressesFrom20, type PqcStatus } from "@qorechain/sdk";
import { hexToBytes, isHex, type Hex } from "viem";
import { isOwnerAddress } from "./store.ts";

/** A signed request's `(owner, nonce)` is refused again for this long. */
export const NONCE_TTL_MS = 10 * 60 * 1000;
const MAX_NONCE_LENGTH = 128;

export type Reply = { code: number; body: unknown };
export type Authorized = { ok: true; owner: Hex; ownerCosmos: string; body: unknown } | { ok: false; reply: Reply };

const err = (code: number, error: string): Reply => ({ code, body: { error } });
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export const cosmosOf = (owner: Hex) => addressesFrom20(hexToBytes(owner)).cosmos;

/** The shape checks a signed request must pass before any chain read. */
export function parseSigned(x: unknown): SignedOwnerRequest | null {
  if (!x || typeof x !== "object") return null;
  const { request, sig } = x as Partial<SignedOwnerRequest>;
  if (!request || typeof request !== "object" || typeof sig !== "string" || !isHex(sig)) return null;
  const r = request as Partial<SignedOwnerRequest["request"]>;
  if (typeof r.owner !== "string" || !isOwnerAddress(r.owner)) return null;
  if (typeof r.purpose !== "string") return null;
  if (typeof r.nonce !== "string" || r.nonce.length === 0 || r.nonce.length > MAX_NONCE_LENGTH) return null;
  if (!Number.isSafeInteger(r.expiresAt)) return null;
  if (!("body" in r)) return null;
  return x as SignedOwnerRequest;
}

export type OwnerAuthDeps = {
  /** The PQC status of a native (qor1…) account, read from the chain. */
  pqcStatus(cosmos: string): Promise<PqcStatus>;
  /** Milliseconds. */
  now(): number;
  log?(line: string): void;
};

/**
 * ML-DSA-87 owner-request verification shared by the provisioner and the gateway: shape, purpose, expiry, the
 * owner's registered key read for `request.owner`, then a one-time nonce. One instance holds one replay set.
 */
export function createOwnerAuth(deps: OwnerAuthDeps) {
  const log = deps.log ?? (() => {});
  const nowSec = () => Math.floor(deps.now() / 1000);
  // Seen (owner, nonce) pairs and when they may be reused.
  const nonces = new Map<string, number>();

  return {
    async authorize(x: unknown, purpose: OwnerPurpose): Promise<Authorized> {
      const signed = parseSigned(x);
      if (!signed) return { ok: false, reply: err(400, "malformed signed request") };
      const { request } = signed;
      if (request.purpose !== purpose) return { ok: false, reply: err(401, "wrong-purpose") };
      const t = nowSec();
      // Cheap refusals first: no chain read for a stale or over-long request.
      if (request.expiresAt < t) return { ok: false, reply: err(401, "expired") };
      if (request.expiresAt > t + OWNER_REQUEST_MAX_TTL) return { ok: false, reply: err(401, "too-far") };
      const owner = request.owner.toLowerCase() as Hex;
      const ownerCosmos = cosmosOf(owner);
      let status: PqcStatus;
      try {
        // The status fetched for request.owner: verifyOwnerRequest does not bind the owner to the key.
        status = await deps.pqcStatus(ownerCosmos);
      } catch (e) {
        log(`pqc status for ${owner} unreadable: ${errorText(e)}`);
        return { ok: false, reply: err(502, "chain unreachable") };
      }
      const v = verifyOwnerRequest(signed, status, nowSec());
      if (!v.ok) return { ok: false, reply: err(401, v.reason) };
      // Synchronous from here: check and record the nonce with no await in between.
      const now = deps.now();
      for (const [k, until] of nonces) if (until <= now) nonces.delete(k);
      const key = `${owner}\n${request.nonce}`;
      if (nonces.has(key)) return { ok: false, reply: err(409, "nonce-reused") };
      nonces.set(key, now + NONCE_TTL_MS);
      return { ok: true, owner, ownerCosmos, body: request.body };
    },
  };
}

export type OwnerAuth = ReturnType<typeof createOwnerAuth>;
