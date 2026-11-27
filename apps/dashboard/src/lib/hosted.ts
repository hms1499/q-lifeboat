import {
  decodeLinkProof,
  signOwnerRequest,
  type AgentLinkProof,
  type AgentLinkProofJson,
  type HostedStatus,
  type OwnerPublicState,
  type OwnerPurpose,
  type OwnerRequest,
  type SignedOwnerRequest,
} from "@qday/core";
import type { UnifiedAccount } from "@qorechain/sdk";
import type { Hex } from "viem";

/** A signed request lives this long; the service refuses more than 300 s (OWNER_REQUEST_MAX_TTL). */
export const SIGNED_TTL_SECONDS = 120;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** What the service's error codes mean, in words a stranger can act on. */
const PLAIN: Record<string, string> = {
  "no-starter": "take the starter pack first",
  "owner-used": "this account already received its starter pack",
  "ip-limit": "too many starter packs went to your network today; try again tomorrow",
  "daily-cap": "today's starter packs are all handed out; try again tomorrow (UTC)",
  "funder-low": "the service is low on testnet QOR; onboarding is paused",
  "topup-used": "this account already had its one top-up",
  "balance-sufficient": "you still hold enough QOR; a top-up is only for less than 0.5 QOR",
  expired: "the signed request expired; check your computer's clock and try again",
  "too-far": "the signed request expires too far ahead; check your computer's clock",
  "not-registered": "register your post-quantum key first",
  "not-proven": "your post-quantum key has no proof of possession",
  "bad-signature": "the service could not verify your post-quantum signature",
  "nonce-reused": "that request was already used; try again",
  "wrong-purpose": "the request was signed for another action",
  "not-provisioned": "your Guardian is not provisioned yet",
  "already-active": "your Guardian is already active with another vault",
  "vault-unreadable": "no vault could be read at that address",
  "vault-owner-mismatch": "the vault's owner is not this account",
  "vault-guardian-mismatch": "the vault's guardian is not your Guardian",
  "agent-not-linked": "your Guardian's key is not linked on chain yet",
  "rule-not-exact": "the Guardian's rule on chain is not exactly vault.rescue",
  "chain unreachable": "the service could not reach the diana testnet",
  "guardian provisioning failed": "the service could not set up your Guardian; try again",
  "recover-vault": "that vault does not name this account as its owner",
  "recover-message": "the vault encodes a different withdrawal message (the values were changed)",
  "recover-signature": "the signature does not verify with the key registered on chain",
  "recover-nonce": "this withdrawal was already used, or another one came first: sign it again",
  "recover-balance": "the vault does not hold that much",
  "recover-cap": "too many sponsored withdrawals today; try again tomorrow (UTC)",
  "not-active": "this account's Guardian is not active with the service",
};

/** A refusal from the hosted service: the HTTP status, its error code, and a plain message. */
export class HostedError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    what: string,
  ) {
    // A body without an `error` code (a proxy's error page) carries no code: say the status once.
    super(code === `HTTP ${status}` ? `${what}: the service answered HTTP ${status}` : `${what}: ${PLAIN[code] ?? code} (${code}, HTTP ${status})`);
    this.name = "HostedError";
  }
}

export type HostedDeps = {
  fetchImpl?: typeof fetch;
  /** Same origin by default: the hosted service (or Vite's /api proxy in dev) serves /api. */
  base?: string;
  /** The session's unlocked account; null while the post-quantum key is not provided. */
  account: () => UnifiedAccount | null;
  /** Milliseconds. */
  now?: () => number;
  uuid?: () => string;
};

/** The hosted service's API, plus `signed`, which builds the ML-DSA-signed requests its writes need. */
export function createHosted(deps: HostedDeps) {
  const f = deps.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const base = (deps.base ?? "").replace(/\/+$/, "");
  const now = deps.now ?? Date.now;
  const uuid = deps.uuid ?? (() => crypto.randomUUID());
  const lc = (owner: string) => owner.toLowerCase();

  async function call<T>(what: string, method: "GET" | "POST" | "PUT", path: string, body?: unknown): Promise<T> {
    const res = await f(`${base}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    let json: unknown = undefined;
    try {
      json = await res.json();
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const code = typeof (json as { error?: unknown } | undefined)?.error === "string" ? (json as { error: string }).error : `HTTP ${res.status}`;
      throw new HostedError(res.status, code, what);
    }
    if (json === undefined) throw new Error(`${what}: the service answered HTTP ${res.status} with no JSON`);
    return json as T;
  }

  return {
    /** `GET /api/status`: whether onboarding is open. */
    status: () => call<HostedStatus>("status", "GET", "/api/status"),

    /** `GET /api/owner/<owner>`: the owner's stage, guardian and vault as the service records them. */
    owner: (owner: string) => call<OwnerPublicState>("owner state", "GET", `/api/owner/${lc(owner)}`),

    /** `POST /api/starter {owner}`: unsigned (a new account has no key yet), capped per owner, IP and day. */
    starter: (owner: string) => call<{ tx: string }>("starter pack", "POST", "/api/starter", { owner: lc(owner) }),

    topup: (signed: SignedOwnerRequest) => call<{ tx: string }>("top-up", "POST", "/api/topup", signed),

    /** `POST /api/onboard` → the owner's guardian and a fresh possession proof of its agent key (decoded). */
    async onboard(signed: SignedOwnerRequest): Promise<{ guardian: Hex; linkProof: AgentLinkProof }> {
      const r = await call<{ guardian?: unknown; linkProof?: AgentLinkProofJson }>("Guardian", "POST", "/api/onboard", signed);
      if (typeof r.guardian !== "string" || !ADDRESS_RE.test(r.guardian)) throw new Error("the service named no valid guardian address");
      if (!r.linkProof || typeof r.linkProof !== "object") throw new Error("the service sent no link proof for the Guardian");
      return { guardian: r.guardian as Hex, linkProof: decodeLinkProof(r.linkProof) };
    },

    activate: (signed: SignedOwnerRequest) => call<{ ok: true }>("activate", "POST", "/api/activate", signed),

    /**
     * `POST /api/recover/submit`: the service pays the gas for a withdrawal signed with the recovery code's key (a
     * browser that lost its wallet has no funded account of its own). The signature, not this request, is the authority.
     */
    submitWithdrawal: (body: Record<string, string>) => call<{ hash: string; status: string }>("sponsored withdrawal", "POST", "/api/recover/submit", body),

    /** `POST /api/o/<owner>/arm`: answers once the Guardian's own window is live (`tx` null when it already was). */
    arm: (owner: string, signed: SignedOwnerRequest) => call<{ tx: string | null }>("arm the Guardian", "POST", `/api/o/${lc(owner)}/arm`, signed),

    policy: (owner: string, signed: SignedOwnerRequest) => call<unknown>("policy", "PUT", `/api/o/${lc(owner)}/policy`, signed),

    /** An `OwnerRequest` for the session's account, signed with its ML-DSA-87 key (the recovery code's). */
    signed(purpose: OwnerPurpose, body: unknown): SignedOwnerRequest {
      const acc = deps.account();
      if (!acc) throw new Error("enter your recovery code first: this request needs your post-quantum signature");
      const request: OwnerRequest = {
        owner: lc(acc.evm) as Hex,
        purpose,
        body,
        nonce: uuid(),
        expiresAt: Math.floor(now() / 1000) + SIGNED_TTL_SECONDS,
      };
      return signOwnerRequest(request, acc.pqc.secretKey);
    },
  };
}

export type Hosted = ReturnType<typeof createHosted>;
