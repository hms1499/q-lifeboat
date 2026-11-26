import { NETWORK, vaultAbi, WITHDRAW_GAS } from "@qday/core";
import { clearPqcStatusCache, type UnifiedAccount } from "@qorechain/sdk";
import { erc20Abi, zeroAddress, type Hex } from "viem";
import { ownerTx } from "./appWallet";
import { errorText } from "./format";
import { publicClient, readFees, readPqcStatus } from "./chain";
import { checkWithdrawal, signWithdrawalInBrowser, type ParsedWithdrawal, type WithdrawalCheck } from "./withdrawal";

/** Every vault check for a signed withdrawal, against the chain. */
export function checksFor(vault: Hex, w: ParsedWithdrawal, owner: Hex): Promise<WithdrawalCheck[]> {
  return checkWithdrawal(w, {
    vault,
    chainId: BigInt(NETWORK.evmChainId),
    readPqcStatus: () => readPqcStatus(owner),
    readOnChainMessage: (x) => publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "withdrawalMessage", args: [x.to, x.token, x.amount, x.nonce] }),
    readNonce: () => publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "nonce" }),
    readVaultBalance: (token) =>
      token.toLowerCase() === zeroAddress
        ? publicClient.getBalance({ address: vault })
        : publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [vault] }),
  });
}

export class WithdrawFailed extends Error {
  constructor(
    message: string,
    readonly checks?: WithdrawalCheck[],
    readonly hash?: Hex,
  ) {
    super(message);
  }
}

/**
 * Sign the withdrawal in this browser with the recovery-code key (refused unless it is the key registered on chain), run
 * every vault check, then send `vault.withdraw` in a 1-tx window scoped to the vault. Same steps as the old Recover screen.
 */
export async function withdrawFromVault(
  acc: UnifiedAccount,
  p: { owner: Hex; vault: Hex; to: Hex; token: Hex; amount: bigint },
  step: (s: string) => void,
): Promise<{ hash: Hex; windowTx: string; ok: boolean; checks: WithdrawalCheck[] }> {
  step("Reading your key and the vault nonce…");
  clearPqcStatusCache();
  const [status, nonce] = await Promise.all([readPqcStatus(p.owner), publicClient.readContract({ address: p.vault, abi: vaultAbi, functionName: "nonce" })]);
  step("Signing with your recovery-code key…");
  const w = signWithdrawalInBrowser(acc, { vault: p.vault, to: p.to, token: p.token, amount: p.amount, nonce }, status);
  step("Checking it against the vault…");
  const checks = await checksFor(p.vault, w, p.owner);
  if (!checks.every((c) => c.status === "pass")) throw new WithdrawFailed("A check failed, so nothing was sent.", checks);
  const fees = await readFees();
  step("Arming your Guardian, then opening a 1-tx window for the vault…");
  let hash: Hex | null = null;
  try {
    const out = await ownerTx.withOwnerWindow(acc, { txs: 1, scope: [p.vault] }, async (wl) => {
      step("Sending the withdrawal…");
      hash = await wl.writeContract({ address: p.vault, abi: vaultAbi, functionName: "withdraw", args: [w.to, w.token, w.amount, w.sig], gas: WITHDRAW_GAS, ...fees });
      return [hash];
    });
    step("Waiting for the block…");
    const r = await publicClient.waitForTransactionReceipt({ hash: hash! });
    return { hash: hash!, windowTx: out.windowTx, ok: r.status === "success", checks };
  } catch (e) {
    throw new WithdrawFailed(errorText(e), checks, hash ?? undefined);
  }
}
