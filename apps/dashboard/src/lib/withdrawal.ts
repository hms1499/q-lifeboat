import { assertRegisteredKey, buildWithdrawal, withdrawalMessage } from "@qday/core";
import { ML_DSA_87_SIGNATURE_LENGTH, pqcStatusPublicKey, pqcVerify, type PqcStatus, type UnifiedAccount } from "@qorechain/sdk";
import { bytesToHex, hexToBytes, isAddress, type Hex } from "viem";
import type { CheckStatus } from "./verify";

/** A `withdrawal.json` written by `pnpm cli sign-withdraw`, parsed. */
export type ParsedWithdrawal = { vault: Hex; to: Hex; token: Hex; amount: bigint; nonce: bigint; sig: Hex };

export type WithdrawalCheckId = "vault" | "key" | "signature" | "message" | "nonce" | "balance";
export type WithdrawalCheck = { id: WithdrawalCheckId; title: string; status: CheckStatus; detail: string };

const KEYS = ["vault", "to", "token", "amount", "nonce", "sig"];

/** Parse strictly: exactly the six keys, all strings; 0x addresses; decimal integers (amount > 0); a 4627-byte sig. */
export function parseWithdrawalJson(text: string): ParsedWithdrawal {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error("the file is not valid JSON");
  }
  if (typeof j !== "object" || j === null || Array.isArray(j)) throw new Error("the file must hold one JSON object");
  const o = j as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !KEYS.includes(k));
  if (extra.length) throw new Error(`unexpected key(s): ${extra.join(", ")}`);
  const str = (k: string) => {
    const v = o[k];
    if (typeof v !== "string" || !v) throw new Error(`missing or non-string "${k}"`);
    return v;
  };
  const addr = (k: string) => {
    const v = str(k);
    // Strict: a mixed-case address must carry a valid EIP-55 checksum (a typo in it is caught here).
    if (!/^0x[0-9a-fA-F]{40}$/.test(v) || !isAddress(v)) throw new Error(`"${k}" is not a 0x 20-byte address (or its checksum is wrong)`);
    return v as Hex;
  };
  const dec = (k: string) => {
    const v = str(k);
    if (!/^\d{1,78}$/.test(v)) throw new Error(`"${k}" must be a decimal integer string`);
    return BigInt(v);
  };
  const vault = addr("vault");
  const to = addr("to");
  if (/^0x0{40}$/.test(to)) throw new Error(`"to" is the zero address: the funds would be burned`);
  const token = addr("token");
  const amount = dec("amount");
  if (amount === 0n) throw new Error(`"amount" must be greater than zero`);
  const nonce = dec("nonce");
  const sig = str("sig");
  if (!/^0x([0-9a-fA-F]{2})+$/.test(sig) || (sig.length - 2) / 2 !== ML_DSA_87_SIGNATURE_LENGTH) {
    throw new Error(`"sig" must be 0x hex of exactly ${ML_DSA_87_SIGNATURE_LENGTH} bytes`);
  }
  return { vault, to, token, amount, nonce, sig: sig as Hex };
}

export type WithdrawalDeps = {
  /** The configured vault (checked against the chain). */
  vault: Hex;
  chainId: bigint;
  /** The owner's PQC registration (`fetchPqcStatus`). */
  readPqcStatus: () => Promise<PqcStatus>;
  /** `vault.withdrawalMessage(to, token, amount, nonce)` on chain. */
  readOnChainMessage: (w: ParsedWithdrawal) => Promise<Hex>;
  readNonce: () => Promise<bigint>;
  /** ERC-20 `balanceOf(vault)`, or the vault's native balance for the zero address (QOR). */
  readVaultBalance: (token: Hex) => Promise<bigint>;
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function guard(id: WithdrawalCheckId, title: string, run: () => Promise<[boolean, string]>): Promise<WithdrawalCheck> {
  try {
    const [ok, detail] = await run();
    return { id, title, status: ok ? "pass" : "fail", detail };
  } catch (e) {
    return { id, title, status: "fail", detail: errorText(e) };
  }
}

/**
 * Everything the vault will check, checked first in the browser, so a doomed withdraw is never sent. Each check
 * stands alone (a failing reader fails only its own check). Submit only when every check passes.
 */
export async function checkWithdrawal(w: ParsedWithdrawal, deps: WithdrawalDeps): Promise<WithdrawalCheck[]> {
  // Encoding can only throw on values the parser already refuses; if it ever does, the two checks that need it fail.
  const encoded = (() => {
    try {
      return withdrawalMessage({ chainId: deps.chainId, vault: w.vault, to: w.to, token: w.token, amount: w.amount, nonce: w.nonce });
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  })();
  const msg = () => {
    if (encoded instanceof Error) throw new Error(`could not encode the withdrawal message: ${encoded.message}`);
    return encoded;
  };
  const status = deps.readPqcStatus();
  status.catch(() => {}); // read once; each check reports its own failure

  return Promise.all([
    guard("vault", "The withdrawal is for your vault", async () =>
      w.vault.toLowerCase() === deps.vault.toLowerCase() ? [true, `vault ${deps.vault}`] : [false, `the file names vault ${w.vault}, yours is ${deps.vault}`],
    ),
    guard("key", "Your ML-DSA-87 key is registered and proven on chain", async () => {
      const s = await status;
      if (!s.registered) return [false, "the owner has no PQC key registered"];
      if (s.possessionProven !== true) return [false, "the key has no proof of possession: the vault reverts KeyNotProven"];
      if (!pqcStatusPublicKey(s)) return [false, "the chain returned no readable public key"];
      return [true, "registered, possession proven"];
    }),
    guard("signature", "The ML-DSA-87 signature is valid for these exact values", async () => {
      const pk = pqcStatusPublicKey(await status);
      if (!pk) return [false, "no registered public key to verify against"];
      return pqcVerify(pk, msg(), hexToBytes(w.sig))
        ? [true, "pqcVerify(registered key, withdrawalMessage, sig)"]
        : [false, "the signature does not verify with the registered key (wrong key, or the file was edited)"];
    }),
    guard("message", "Message bytes match vault.withdrawalMessage", async () => {
      const onChain = (await deps.readOnChainMessage(w)).toLowerCase();
      const local = msg();
      return onChain === bytesToHex(local).toLowerCase() ? [true, `${local.length} bytes, identical`] : [false, "the vault encodes a different message"];
    }),
    guard("nonce", "Nonce matches the vault", async () => {
      const n = await deps.readNonce();
      return n === w.nonce ? [true, `nonce ${n}`] : [false, `the file has nonce ${w.nonce}, the vault is at ${n}: run sign-withdraw again`];
    }),
    guard("balance", "Amount is within the vault balance", async () => {
      const b = await deps.readVaultBalance(w.token);
      return w.amount <= b ? [true, `vault holds ${b}`] : [false, `amount ${w.amount} is above the vault balance ${b}`];
    }),
  ]);
}

/**
 * Sign a withdrawal in the browser with the session's post-quantum key (from the recovery code). Refuses, before
 * anything is signed, unless `status` (read fresh from chain) shows that exact key registered and proven.
 */
export function signWithdrawalInBrowser(
  acc: Pick<UnifiedAccount, "pqc">,
  p: { vault: Hex; to: Hex; token: Hex; amount: bigint; nonce: bigint },
  status: PqcStatus,
): ParsedWithdrawal {
  assertRegisteredKey(status, acc.pqc.publicKey);
  const f = buildWithdrawal(p, acc.pqc.secretKey);
  return { vault: f.vault, to: f.to, token: f.token, amount: BigInt(f.amount), nonce: BigInt(f.nonce), sig: f.sig };
}
