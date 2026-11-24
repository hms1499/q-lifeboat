import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex, hexToBytes, type Hex } from "viem";

/**
 * An outbound event from the owner account.
 * - `kind: "transfer"`: an ERC-20 `Transfer(from=owner)` or a native QOR tx (token is the zero address).
 *   `to` is the recipient, `amount` the value moved.
 * - `kind: "approval"`: an ERC-20 `Approval(owner, spender, value)`. `to` is the spender, `amount` the approved value.
 */
export type OutboundTx = { kind: "transfer" | "approval"; hash: Hex; block: bigint; token: Hex; to: Hex; amount: bigint };

/**
 * One rescue attempt. `amount` is what the vault actually moved (sum of its `Rescued` logs in the tx's
 * block, 0 when none was found); `expected` is the agent's pre-read estimate, min(balance, allowance).
 */
export type RescueRecord = { token: Hex; hash: string; amount: bigint; expected: bigint; success: boolean; error?: string };

export type IncidentBody = {
  id: string;
  /** ISO-8601 time the trigger was seen. */
  detectedAt: string;
  trigger: OutboundTx;
  reason: string;
  rescues: RescueRecord[];
  summary: string;
  /** Who wrote `summary`: the LLM, or the deterministic template fallback. */
  summarySource: "llm" | "template";
  /** `qor1` account that co-signed the report with QoreSign (the vault's guardian). Covered by both signatures. */
  guardian?: string;
};

/**
 * A QoreSign message signature (`@qorechain/qoresign` `MessageSignature`): the signer's classical key over the ADR-36 sign
 * document and its ML-DSA-87 key over `"qorechain-msg-v1|" + chainId + "|" + data`. Declared here so core needs no QoreSign
 * dependency; the agent signs and the dashboard verifies with QoreSign itself.
 */
export type GuardianSignature = {
  signatureType: "ml-dsa-87-hybrid" | "secp256k1";
  classical: { keyType: string; publicKey: string; signature: string };
  pq?: { algorithmId: number; signature: string };
};

export type Incident = IncidentBody & {
  /** Agent ed25519 public key, 32-byte hex without 0x. */
  agentPubkey: string;
  /** ed25519 signature over `incidentSigningBytes`, 64-byte hex without 0x. */
  sig: string;
  /** The guardian's QoreSign signature over the same `incidentSigningBytes` (submission gap 3). Absent on older reports. */
  guardianSig?: GuardianSignature;
};

const DOMAIN = "QDAY-GUARDIAN-INCIDENT-V1\n";

/** Deterministic JSON: object keys sorted recursively, bigint as decimal string, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(o)
        .filter((k) => o[k] !== undefined)
        .sort()
        .map((k) => [k, sortKeys(o[k])]),
    );
  }
  return v;
}

/** The bytes that get signed: the domain tag plus the canonical JSON of the incident without `sig` and `guardianSig`. */
export function incidentSigningBytes(i: IncidentBody & { agentPubkey: string; sig?: string; guardianSig?: GuardianSignature }): Uint8Array {
  const { sig: _sig, guardianSig: _guardianSig, ...rest } = i;
  return new TextEncoder().encode(DOMAIN + canonicalJson(rest));
}

const strip0x = (h: string) => (h.startsWith("0x") ? h.slice(2) : h);

/** Co-signs an incident's signing bytes as `guardian` (QoreSign, in the agent). A throw leaves a plain ed25519 report. */
export type GuardianCoSigner = { guardian: string; sign(bytes: Uint8Array): GuardianSignature; onError?: (e: unknown) => void };

/**
 * Sign an incident body with the agent key. Sets `agentPubkey` and `sig`, and with a co-signer also `guardian` (inside the
 * signed bytes) and `guardianSig` (outside them). A co-signer failure never blocks the report: it is reported through
 * `onError` and the report goes out with the ed25519 signature only, exactly as it would without a co-signer.
 */
export function signIncident(body: IncidentBody, sk: Uint8Array, coSigner?: GuardianCoSigner): Incident {
  const agentPubkey = strip0x(bytesToHex(ed25519.getPublicKey(sk)));
  let signedBody: IncidentBody = body;
  let guardianSig: GuardianSignature | undefined;
  if (coSigner) {
    try {
      const withGuardian = { ...body, guardian: coSigner.guardian };
      guardianSig = coSigner.sign(incidentSigningBytes({ ...withGuardian, agentPubkey }));
      signedBody = withGuardian;
    } catch (e) {
      coSigner.onError?.(e);
    }
  }
  const sig = strip0x(bytesToHex(ed25519.sign(incidentSigningBytes({ ...signedBody, agentPubkey }), sk)));
  return guardianSig ? { ...signedBody, agentPubkey, sig, guardianSig } : { ...signedBody, agentPubkey, sig };
}

/** True when `sig` is a valid signature by `agentPubkey` over the incident. Never throws. */
export function verifyIncident(i: Incident): boolean {
  try {
    if (!/^[0-9a-fA-F]{128}$/.test(i.sig) || !/^[0-9a-fA-F]{64}$/.test(i.agentPubkey)) return false;
    return ed25519.verify(
      hexToBytes(`0x${i.sig}` as Hex),
      incidentSigningBytes(i),
      hexToBytes(`0x${i.agentPubkey}` as Hex),
    );
  } catch {
    return false;
  }
}
