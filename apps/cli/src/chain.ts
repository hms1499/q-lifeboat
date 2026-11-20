import type { UnifiedAccount } from "@qorechain/sdk";
import { broadcastTx } from "@qday/core";

export { chain, publicClient, bigintReplacer, getJson, uqorBalance } from "@qday/core";

/** Broadcast cosmos messages (hybrid-signed) and return the tx hash. See core `broadcastTx`. */
export async function broadcast(acc: UnifiedAccount, messages: any[], memo: string): Promise<string> {
  return (await broadcastTx(acc, messages, memo)).transactionHash;
}
