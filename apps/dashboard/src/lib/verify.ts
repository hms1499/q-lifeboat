import { vaultAbi, verifyIncident, type Incident } from "@qday/core";
import { decodeEventLog, type Hex } from "viem";

/**
 * Review Focus 5: the dashboard does not take a report on the agent's word. A valid ed25519 signature only proves that
 * SOME key signed it; the report is trusted only when that key is a linked, live authenticator of the owner, and every
 * rescue it claims is a successful tx to the vault whose `Rescued` log matches the recorded token and amount.
 */

export type CheckStatus = "pass" | "fail" | "n/a";
export type CheckId = "config" | "signature" | "linked" | "active" | "rescues";
export type Check = { id: CheckId; title: string; status: CheckStatus; detail: string };

/** The fields of the SDK's `AuthenticatorView` this check reads. */
export type AuthenticatorLike = { scheme: string; pubkeyHex: string; revoked: boolean; expiryUnix: bigint };

export type ReceiptLike = {
  status: "success" | "reverted";
  to: Hex | null;
  blockNumber: bigint;
  logs: readonly { address: Hex; topics: readonly Hex[]; data: Hex }[];
};

export type VerifyContext = {
  /** The configured owner's linked keys (`fetchAuthenticators`), revoked ones included. */
  authenticators: readonly AuthenticatorLike[];
  nowUnix: number;
  /** The configured vault (whose `owner()` / `guardian()` were checked on chain). */
  vault: Hex;
  /** null when the chain has no receipt for the hash. */
  readReceipt: (hash: Hex) => Promise<ReceiptLike | null>;
  /** The config-vs-chain check (`checkConfigOnChain`). When given, it is the first check and can fail the report. */
  config?: { ok: boolean; detail: string };
};

export type VerifyResult = { ok: boolean; checks: Check[] };

const norm = (hex: unknown) => (typeof hex === "string" ? hex.replace(/^0x/i, "").toLowerCase() : "");
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const short = (h: string) => (h.length > 14 ? `${h.slice(0, 10)}…${h.slice(-4)}` : h);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function toBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  throw new Error(`not a non-negative integer: ${String(v)}`);
}

function signatureCheck(incident: Incident): Check {
  let valid = false;
  try {
    valid = verifyIncident(incident);
  } catch {
    valid = false;
  }
  return {
    id: "signature",
    title: "Signature is valid",
    status: valid ? "pass" : "fail",
    detail: valid ? "ed25519 over the canonical report JSON" : "the ed25519 signature does not match the report body",
  };
}

function keyChecks(incident: Incident, ctx: VerifyContext): [Check, Check] {
  const want = norm(incident?.agentPubkey);
  const entries = want ? ctx.authenticators.filter((a) => norm(a.scheme) === "ed25519" && norm(a.pubkeyHex) === want) : [];
  const linked: Check = {
    id: "linked",
    title: "The key is linked to your account",
    status: entries.length ? "pass" : "fail",
    detail: entries.length
      ? `fetchAuthenticators lists ed25519 key ${short(want)}`
      : `ed25519 key ${short(want) || "(none)"} is not among the owner's ${ctx.authenticators.length} linked key(s)`,
  };
  if (!entries.length) {
    return [linked, { id: "active", title: "The key is not revoked or expired", status: "fail", detail: "the key is not linked" }];
  }
  const live = entries.find((a) => !a.revoked && a.expiryUnix > BigInt(ctx.nowUnix));
  if (live) {
    return [linked, { id: "active", title: "The key is not revoked or expired", status: "pass", detail: `active until ${new Date(Number(live.expiryUnix) * 1000).toISOString()}` }];
  }
  const why = entries.every((a) => a.revoked) ? "revoked" : "expired";
  return [linked, { id: "active", title: "The key is not revoked or expired", status: "fail", detail: `the linked key is ${why}` }];
}

/** Sum of the `Rescued(token, amount)` logs the vault itself emitted in a receipt, for one token. */
function rescuedInReceipt(receipt: ReceiptLike, vault: Hex, token: Hex): { count: number; sum: bigint } {
  let count = 0;
  let sum = 0n;
  for (const log of receipt.logs) {
    if (norm(log.address) !== norm(vault)) continue;
    try {
      const ev = decodeEventLog({ abi: vaultAbi, eventName: "Rescued", topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
      if (norm(ev.args.token) !== norm(token)) continue;
      count += 1;
      sum += ev.args.amount;
    } catch {
      // another event from the vault
    }
  }
  return { count, sum };
}

async function rescueCheck(incident: Incident, ctx: VerifyContext): Promise<Check> {
  const title = "Rescue txs exist on chain";
  const fail = (detail: string): Check => ({ id: "rescues", title, status: "fail", detail });
  const rescues: unknown = incident?.rescues;
  if (!Array.isArray(rescues)) return fail("the report has no rescue list");
  const done = rescues.filter((r) => r && r.success === true);
  if (!rescues.length) return { id: "rescues", title, status: "n/a", detail: "alert only: no rescue was attempted" };
  if (!done.length) return { id: "rescues", title, status: "n/a", detail: `no rescue succeeded (${rescues.length} failed attempt(s)), nothing moved to prove` };

  const seen = new Set<string>();
  for (const r of done) {
    const hash = String(r.hash ?? "");
    if (!HASH_RE.test(hash)) return fail(`rescue hash ${short(hash) || "(empty)"} is not an EVM tx hash`);
    const key = `${norm(hash)}/${norm(r.token)}`;
    if (seen.has(key)) return fail(`rescue ${short(hash)} is listed twice for the same token`);
    seen.add(key);
    let amount: bigint;
    try {
      amount = toBigInt(r.amount);
    } catch {
      return fail(`rescue ${short(hash)} has no valid amount`);
    }
    let receipt: ReceiptLike | null;
    try {
      receipt = await ctx.readReceipt(hash as Hex);
    } catch (e) {
      return fail(`could not read the receipt of ${short(hash)}: ${errorText(e)}`);
    }
    if (!receipt) return fail(`no receipt on chain for ${short(hash)}`);
    if (receipt.status !== "success") return fail(`rescue ${short(hash)} reverted on chain`);
    if (norm(receipt.to) !== norm(ctx.vault)) return fail(`rescue ${short(hash)} was sent to ${receipt.to ?? "(contract creation)"}, not the vault`);
    const got = rescuedInReceipt(receipt, ctx.vault, r.token as Hex);
    if (!got.count) return fail(`no Rescued log from the vault for token ${short(String(r.token))} in ${short(hash)}`);
    if (got.sum !== amount) return fail(`Rescued amount ${got.sum} in ${short(hash)} differs from the reported amount ${amount}`);
  }
  return { id: "rescues", title, status: "pass", detail: `${done.length} Rescued event(s) from vault ${short(ctx.vault)} match the report` };
}

/** Run every check against the chain data in `ctx`. Never throws; `ok` only when no check fails. */
export async function verifyReport(incident: Incident, ctx: VerifyContext): Promise<VerifyResult> {
  const checks: Check[] = [];
  if (ctx.config) {
    checks.push({
      id: "config",
      title: "Agent config matches the vault on chain",
      status: ctx.config.ok ? "pass" : "fail",
      detail: ctx.config.detail,
    });
  }
  checks.push(signatureCheck(incident));
  try {
    checks.push(...keyChecks(incident, ctx));
  } catch (e) {
    checks.push({ id: "linked", title: "The key is linked to your account", status: "fail", detail: errorText(e) });
  }
  try {
    checks.push(await rescueCheck(incident, ctx));
  } catch (e) {
    checks.push({ id: "rescues", title: "Rescue txs exist on chain", status: "fail", detail: errorText(e) });
  }
  return { ok: checks.every((c) => c.status !== "fail"), checks };
}
