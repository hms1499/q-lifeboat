import { isAddress, parseUnits, zeroAddress } from "viem";
import { fmtAmount } from "./format";

/** What is wrong with a withdraw form, per field; an empty object means it can go to review. */
export function checkWithdraw(i: { amount: string; balance: bigint | undefined; to: string; owner: string; vault: string }): { amount?: string; to?: string } {
  const out: { amount?: string; to?: string } = {};
  const a = i.amount.trim();
  if (!a) out.amount = "Enter an amount.";
  else {
    let wei: bigint | null = null;
    try {
      wei = parseUnits(a, 18);
    } catch {
      out.amount = "Not a number.";
    }
    if (wei !== null) {
      if (wei <= 0n) out.amount = "The amount must be above zero.";
      else if (i.balance === undefined) out.amount = "Reading your vault balance…";
      else if (wei > i.balance) out.amount = `Your vault holds ${fmtAmount(i.balance)}.`;
    }
  }
  const to = i.to.trim();
  if (!to) out.to = "Enter the address to send to.";
  else if (!isAddress(to, { strict: false })) out.to = "That is not a 0x address.";
  else if (to.toLowerCase() === zeroAddress) out.to = "That is the zero address: tokens sent there are lost.";
  else if (to.toLowerCase() === i.owner.toLowerCase()) out.to = "This is the account whose key may have leaked. Choose a fresh address.";
  else if (to.toLowerCase() === i.vault.toLowerCase()) out.to = "That is your vault itself.";
  return out;
}
