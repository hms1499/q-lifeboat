import { NETWORK, withdrawalMessage } from "@qday/core";
import { normalizeRecoveryCode, pqcStatusPublicKey, type PqcStatus } from "@qorechain/sdk";
import { getContractAddress, type Hex } from "viem";
import { VAULT_PROBE_NONCES } from "./onboard";
import type { ParsedWithdrawal } from "./withdrawal";

/**
 * Restoring access from the recovery code alone (no wallet in this browser). Pure helpers only: the screen does the
 * account derivation, signing and sending. Nothing here writes to `appSession` and nothing stores the code.
 */

const ADDR = /^0x[0-9a-fA-F]{40}$/;

/** The account and recovery code from the `.txt` Setup downloaded (`recoveryFile` in ./setup). */
export function parseRecoveryTxt(text: string): { account: Hex; code: string } {
  const account = /^\s*Account:\s*(0x[0-9a-fA-F]{40})\s*$/im.exec(text)?.[1];
  if (!account) throw new Error('this file has no "Account: 0x…" line');
  const raw = /QRC1(?:[-\s][A-Za-z0-9]+)+/i.exec(text)?.[0];
  if (!raw) throw new Error("this file has no QRC1-… recovery code");
  let code: string;
  try {
    code = normalizeRecoveryCode(raw);
  } catch {
    throw new Error("the recovery code in this file is malformed");
  }
  return { account: account as Hex, code };
}

export type RestoreCheckId = "key" | "vault" | "account";
export type RestoreCheck = { id: RestoreCheckId; title: string; status: "pass" | "fail"; detail: string };

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The three checks that stand between a stranger and a signature, each read from the chain: the code's key is the one
 * registered for this account, a vault belongs to it, and that vault names this account as its owner.
 */
export function restoreChecks(i: {
  account: Hex;
  /** The public key derived from the recovery code for this account. */
  derived: Uint8Array;
  status: PqcStatus;
  roles: { owner: Hex } | null;
}): RestoreCheck[] {
  const onChain = pqcStatusPublicKey(i.status);
  const key: RestoreCheck = !i.status.registered
    ? { id: "key", title: "This account has a post-quantum key on chain", status: "fail", detail: "no ML-DSA-87 key is registered for this account" }
    : !onChain
      ? { id: "key", title: "This account has a post-quantum key on chain", status: "fail", detail: "the chain returned no readable public key" }
      : !sameBytes(onChain, i.derived)
        ? { id: "key", title: "The code belongs to this account", status: "fail", detail: "the key this code makes is not the key registered for this account" }
        : { id: "key", title: "The code belongs to this account", status: "pass", detail: "its key is the one registered on chain" };
  const vault: RestoreCheck = i.roles
    ? { id: "vault", title: "A vault belongs to this account", status: "pass", detail: "found its GuardianVault on chain" }
    : { id: "vault", title: "A vault belongs to this account", status: "fail", detail: "no GuardianVault was found for this account" };
  const account: RestoreCheck = !i.roles
    ? { id: "account", title: "The vault names this account as its owner", status: "fail", detail: "there is no vault to read" }
    : i.roles.owner.toLowerCase() === i.account.toLowerCase()
      ? { id: "account", title: "The vault names this account as its owner", status: "pass", detail: i.account }
      : { id: "account", title: "The vault names this account as its owner", status: "fail", detail: `the vault's owner is ${i.roles.owner}` };
  return [key, vault, account];
}

export type VaultLookup = { address: Hex; roles: { owner: Hex; guardian: Hex } };

/**
 * The vault that belongs to `account`, found without knowing its guardian (a restore does not): the address the
 * service recorded first, then the creation-address probe `locateVault` uses, capped at `VAULT_PROBE_NONCES`. A read
 * that throws propagates: "could not read" must never look like "no vault".
 */
export async function findOwnerVault(
  account: Hex,
  deps: { txCount(a: Hex): Promise<number>; roles(a: Hex): Promise<{ owner: Hex; guardian: Hex } | null> },
  known?: string | null,
): Promise<VaultLookup | null> {
  const tries: string[] = [];
  if (known && ADDR.test(known)) tries.push(known.toLowerCase());
  const n = Math.min(await deps.txCount(account), VAULT_PROBE_NONCES);
  for (let nonce = 0; nonce < n; nonce++) tries.push(getContractAddress({ from: account, nonce: BigInt(nonce) }));
  const seen = new Set<string>();
  for (const a of tries) {
    if (seen.has(a)) continue;
    seen.add(a);
    const r = await deps.roles(a as Hex);
    if (r && r.owner.toLowerCase() === account.toLowerCase()) return { address: a as Hex, roles: r };
  }
  return null;
}

/** The six fields `withdrawal.json` carries (`parseWithdrawalJson`), as the doc everyone can re-verify. */
export function signedFile(w: ParsedWithdrawal): string {
  return `${JSON.stringify(
    { vault: w.vault, to: w.to, token: w.token, amount: w.amount.toString(), nonce: w.nonce.toString(), sig: w.sig },
    null,
    2,
  )}\n`;
}

/** `POST /api/recover/submit`: the same six fields plus the account the vault is checked against. */
export function sponsorBody(w: ParsedWithdrawal, owner: Hex): Record<string, string> {
  return { owner, vault: w.vault, to: w.to, token: w.token, amount: w.amount.toString(), nonce: w.nonce.toString(), sig: w.sig };
}

/** The local encoding of a withdrawal's signed message, for the "what this signature binds" panel. */
export function withdrawalBytes(w: ParsedWithdrawal): Uint8Array {
  return withdrawalMessage({ chainId: BigInt(NETWORK.evmChainId), vault: w.vault, to: w.to, token: w.token, amount: w.amount, nonce: w.nonce });
}
