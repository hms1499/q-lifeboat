import { writeFileSync } from "node:fs";
import { assertRegisteredKey, buildWithdrawal, loadOwner, loadTokens, loadVault, NETWORK, vaultAbi, withdrawalMessage } from "@qday/core";
import { fetchPqcStatus, pqcVerify } from "@qorechain/sdk";
import { bytesToHex, hexToBytes, isAddress, parseUnits, zeroAddress, type Hex } from "viem";
import { publicClient } from "./chain";
import { resolveUserPath } from "./paths";

type Env = Record<string, string | undefined>;

// The withdrawal builder lives in @qday/core (browser-safe); these re-exports keep the CLI's import paths.
export { assertRegisteredKey, buildWithdrawal };
export type { WithdrawalFile } from "@qday/core";

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

/** `pnpm cli sign-withdraw <to> <token> <amount> [--out file]`: the local Guardian Signer. */
export async function runSignWithdraw(args: string[], env: Env = process.env): Promise<void> {
  const outIdx = args.indexOf("--out");
  if (outIdx >= 0 && !args[outIdx + 1]) throw new Error("--out needs a file path");
  const out = resolveUserPath(outIdx >= 0 ? args[outIdx + 1] : "withdrawal.json");
  const pos = args.filter((_, i) => outIdx < 0 || (i !== outIdx && i !== outIdx + 1));
  if (pos.length !== 3) throw new Error("usage: sign-withdraw <to> <token> <amount> [--out file]");
  const [toArg, tokenArg, amountArg] = pos;
  if (!isAddress(toArg, { strict: false })) throw new Error(`invalid recipient address "${toArg}"`);

  const owner = await loadOwner(env);
  const vault = loadVault(env);
  const token = resolveToken(tokenArg, loadTokens(env));
  const amount = parseAmount(amountArg);

  // Refuse to sign with a key the chain would not accept.
  assertRegisteredKey(await fetchPqcStatus({ rest: NETWORK.rest, address: owner.cosmos }), owner.pqc.publicKey);

  const nonce = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "nonce" });

  // Live check that the TS message encoding equals the deployed vault's own encoding.
  const expected = withdrawalMessage({ chainId: BigInt(NETWORK.evmChainId), vault, to: toArg as Hex, token, amount, nonce });
  const onChainMsg = await publicClient.readContract({
    address: vault,
    abi: vaultAbi,
    functionName: "withdrawalMessage",
    args: [toArg as Hex, token, amount, nonce],
  });
  if (onChainMsg.toLowerCase() !== bytesToHex(expected)) {
    throw new Error("withdrawal message mismatch between this CLI and the deployed vault; refusing to sign");
  }

  const w = buildWithdrawal({ vault, to: toArg as Hex, token, amount, nonce }, owner.pqc.secretKey);

  const msg = withdrawalMessage({ chainId: BigInt(NETWORK.evmChainId), vault, to: w.to, token, amount, nonce });
  if (!pqcVerify(owner.pqc.publicKey, msg, hexToBytes(w.sig))) throw new Error("self-check failed: signature does not verify");

  writeFileSync(out, `${JSON.stringify(w, null, 2)}\n`);
  console.log(`wrote ${out}: ${w.amount} base units of ${token} to ${w.to}, vault nonce ${w.nonce}`);
}
