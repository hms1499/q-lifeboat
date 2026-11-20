import { readFileSync } from "node:fs";
import { loadOwner, loadVault, vaultAbi } from "@qday/core";
import { deriveUnifiedAccount } from "@qorechain/sdk";
import { createWalletClient, erc20Abi, formatUnits, http, isAddress, zeroAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain, publicClient } from "./chain";

type Env = Record<string, string | undefined>;

export interface ParsedWithdrawal {
  vault: Hex;
  to: Hex;
  token: Hex;
  amount: bigint;
  nonce: bigint;
  sig: Hex;
}

const WITHDRAW_GAS = 1_000_000n;

/** Validate the shape of a withdrawal.json and return typed values. */
export function parseWithdrawalFile(text: string): ParsedWithdrawal {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error("withdrawal file is not valid JSON");
  }
  const str = (k: string): string => {
    const v = j?.[k];
    if (typeof v !== "string" || !v) throw new Error(`withdrawal file: missing or non-string "${k}"`);
    return v;
  };
  const addr = (k: string): Hex => {
    const v = str(k);
    if (!isAddress(v, { strict: false })) throw new Error(`withdrawal file: "${k}" is not a 20-byte address`);
    return v as Hex;
  };
  const dec = (k: string): bigint => {
    const v = str(k);
    if (!/^\d+$/.test(v)) throw new Error(`withdrawal file: "${k}" must be a decimal integer string`);
    return BigInt(v);
  };
  const sig = str("sig");
  if (!/^0x([0-9a-fA-F]{2})+$/.test(sig)) throw new Error('withdrawal file: "sig" must be 0x hex');
  return { vault: addr("vault"), to: addr("to"), token: addr("token"), amount: dec("amount"), nonce: dec("nonce"), sig: sig as Hex };
}

/** Refuse a file for another vault or one whose nonce is no longer the vault's current nonce. */
export function checkWithdrawalFile(w: ParsedWithdrawal, vault: Hex, currentNonce: bigint): void {
  if (w.vault.toLowerCase() !== vault.toLowerCase()) {
    throw new Error(`withdrawal file is for vault ${w.vault}, but VAULT_ADDRESS is ${vault}`);
  }
  if (w.nonce !== currentNonce) {
    throw new Error(
      `stale or mismatched signature: file nonce ${w.nonce}, vault nonce ${currentNonce}. Run sign-withdraw again.`,
    );
  }
}

async function balanceOf(token: Hex, who: Hex): Promise<bigint> {
  if (token === zeroAddress) return publicClient.getBalance({ address: who });
  return publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
}

/** `pnpm cli withdraw <file>`: any funded wallet can submit the Guardian Signer's output. */
export async function runWithdraw(args: string[], env: Env = process.env): Promise<void> {
  const file = args[0];
  if (!file) throw new Error("usage: withdraw <withdrawal.json>");
  const w = parseWithdrawalFile(readFileSync(file, "utf8"));
  const vault = loadVault(env);

  const relayerMnemonic = env.RELAYER_MNEMONIC?.trim();
  const submitter = relayerMnemonic
    ? await deriveUnifiedAccount(relayerMnemonic).catch(() => {
        throw new Error("RELAYER_MNEMONIC could not be used to derive an account");
      })
    : await loadOwner(env);
  const account = privateKeyToAccount(submitter.privateKey as Hex);

  const current = await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "nonce" });
  checkWithdrawalFile(w, vault, current);

  const before = await balanceOf(w.token, w.to);
  try {
    const { request } = await publicClient.simulateContract({
      account,
      address: vault,
      abi: vaultAbi,
      functionName: "withdraw",
      args: [w.to, w.token, w.amount, w.sig],
      gas: WITHDRAW_GAS,
    });
    const wallet = createWalletClient({ account, chain, transport: http() });
    const hash = await wallet.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    const after = await balanceOf(w.token, w.to);
    console.log(`tx ${hash}`);
    console.log(`status ${receipt.status}, gasUsed ${receipt.gasUsed}`);
    console.log(`to balance: ${formatUnits(before, 18)} -> ${formatUnits(after, 18)}`);
    if (receipt.status !== "success") throw new Error("withdraw reverted on-chain");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/window|authori[sz]/i.test(msg)) {
      console.error("hint: the submitting account needs a live EVM window (open one with `pnpm cli setup`).");
    }
    throw e;
  }
}
