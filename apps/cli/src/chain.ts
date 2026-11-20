import type { UnifiedAccount } from "@qorechain/sdk";
import { broadcastTx } from "@qday/core/chain";

export { chain, publicClient, bigintReplacer, getJson, uqorBalance } from "@qday/core/chain";

/** Broadcast cosmos messages (hybrid-signed unless `signMode` says otherwise) and return the tx hash. See core `broadcastTx`. */
export async function broadcast(
  acc: UnifiedAccount,
  messages: any[],
  memo: string,
  signMode: "hybrid" | "classical" = "hybrid",
): Promise<string> {
  return (await broadcastTx(acc, messages, memo, { signMode })).transactionHash;
}
