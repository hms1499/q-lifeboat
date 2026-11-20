import { writeFileSync } from "node:fs";
import { loadOwner, loadTokens, loadVault, NETWORK, vaultAbi, withdrawalMessage } from "@qday/core";
import { fetchPqcStatus, pqcSign, pqcStatusPublicKey, pqcVerify } from "@qorechain/sdk";
import { bytesToHex, hexToBytes, isAddress, parseUnits, zeroAddress, type Hex } from "viem";
import { publicClient } from "./chain";

type Env = Record<string, string | undefined>;

export interface WithdrawalFile {
  vault: Hex;
  to: Hex;
  token: Hex;
  /** Decimal string, base units. */
  amount: string;
  /** Decimal string. */
  nonce: string;
  sig: Hex;
}

/** Token argument: a 0x address, one of fUSD/fETH/fBTC, or QOR (the zero address). */
export function resolveToken(arg: string, tokens: Record<"fUSD" | "fETH" | "fBTC", Hex>): Hex {
  if (arg === "QOR") return zeroAddress;
  if (arg in tokens) return tokens[arg as keyof typeof tokens];
  if (isAddress(arg, { strict: false })) return arg as Hex;
  throw new Error(`unknown token "${arg}": use a 0x address, fUSD, fETH, fBTC or QOR`);
}

/** Decimal token amount (18 decimals) to base units. */
export function parseAmount(arg: string): bigint {
  let v: bigint;
  try {
    v = parseUnits(arg, 18);
  } catch {
    throw new Error(`invalid amount "${arg}": expected a positive decimal number`);
  }
  if (v <= 0n) throw new Error(`invalid amount "${arg}": must be greater than zero`);
  return v;
}

/** Sign a withdrawal with the ML-DSA secret key and return the JSON object the `withdraw` command submits. */
export function buildWithdrawal(
  p: { vault: Hex; to: Hex; token: Hex; amount: bigint; nonce: bigint },
  pqcSecretKey: Uint8Array,
): WithdrawalFile {
  const msg = withdrawalMessage({ chainId: BigInt(NETWORK.evmChainId), ...p });
  const sig = pqcSign(pqcSecretKey, msg);
  return {
    vault: p.vault,
    to: p.to,
    token: p.token,
    amount: p.amount.toString(),
    nonce: p.nonce.toString(),
    sig: bytesToHex(sig),
  };
}

/** `pnpm cli sign-withdraw <to> <token> <amount> [--out file]`: the local Guardian Signer. */
export async function runSignWithdraw(args: string[], env: Env = process.env): Promise<void> {
  const outIdx = args.indexOf("--out");
  const out = outIdx >= 0 ? args[outIdx + 1] : "withdrawal.json";
  if (outIdx >= 0 && !out) throw new Error("--out needs a file path");
  const pos = args.filter((_, i) => outIdx < 0 || (i !== outIdx && i !== outIdx + 1));
  if (pos.length !== 3) throw new Error("usage: sign-withdraw <to> <token> <amount> [--out file]");
  const [toArg, tokenArg, amountArg] = pos;
  if (!isAddress(toArg, { strict: false })) throw new Error(`invalid recipient address "${toArg}"`);

  const owner = await loadOwner(env);
  const vault = loadVault(env);
  const token = resolveToken(tokenArg, loadTokens(env));
  const amount = parseAmount(amountArg);

  // Refuse to sign with a key the chain does not know: such a signature could never be verified.
  const status = await fetchPqcStatus({ rest: NETWORK.rest, address: owner.cosmos });
  const registered = pqcStatusPublicKey(status);
  if (!status.registered || !registered) throw new Error("the owner has no PQC key registered on-chain");
  if (bytesToHex(registered) !== bytesToHex(owner.pqc.publicKey)) {
    throw new Error("the on-chain PQC key differs from the key derived from OWNER_MNEMONIC; refusing to sign");
  }

  const nonce = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "nonce" });
  const w = buildWithdrawal({ vault, to: toArg as Hex, token, amount, nonce }, owner.pqc.secretKey);

  const msg = withdrawalMessage({ chainId: BigInt(NETWORK.evmChainId), vault, to: w.to, token, amount, nonce });
  if (!pqcVerify(owner.pqc.publicKey, msg, hexToBytes(w.sig))) throw new Error("self-check failed: signature does not verify");

  writeFileSync(out, `${JSON.stringify(w, null, 2)}\n`);
  console.log(`wrote ${out}: ${w.amount} base units of ${token} to ${w.to}, vault nonce ${w.nonce}`);
}
