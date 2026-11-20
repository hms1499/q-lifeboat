import { loadOwner, loadTokens, loadVault, NETWORK, vaultAbi } from "@qday/core";
import { evmWindowStatus } from "@qorechain/evm";
import { fetchPqcStatus } from "@qorechain/sdk";
import { erc20Abi, formatUnits, type Hex } from "viem";
import { fetchOwnerAuthenticators, fetchOwnerSpendingRules } from "./abstractaccount";
import { bigintReplacer, publicClient, uqorBalance } from "./chain";

type Env = Record<string, string | undefined>;

/** `pnpm cli status`: read-only snapshot of the owner's window, rules, linked keys, vault nonce and balances. */
export async function runStatus(env: Env = process.env): Promise<void> {
  const owner = await loadOwner(env);
  const vault = loadVault(env);
  const tokens = loadTokens(env);
  const show = (label: string, v: unknown) => console.log(`${label.padEnd(14)} ${typeof v === "string" ? v : JSON.stringify(v, bigintReplacer)}`);

  show("owner", `${owner.cosmos} ${owner.evm}`);
  show("vault", vault);
  show("pqc", await fetchPqcStatus({ rest: NETWORK.rest, address: owner.cosmos }).then((s) => ({ registered: s.registered, possessionProven: s.possessionProven })).catch((e: Error) => e.message));
  show("window", await evmWindowStatus({ rest: NETWORK.rest, address: owner.evm }).catch((e: Error) => e.message));
  show("rules", await fetchOwnerSpendingRules(owner.cosmos).catch((e: Error) => e.message));
  show("authenticators", await fetchOwnerAuthenticators(owner.cosmos).catch((e: Error) => e.message));
  show("vault nonce", String(await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "nonce" })));

  const holders: [string, Hex, string][] = [["owner", owner.evm as Hex, owner.cosmos], ["vault", vault, ""]];
  for (const [label, evm, cosmos] of holders) {
    const parts: string[] = [];
    if (cosmos) parts.push(`QOR ${formatUnits(await uqorBalance(cosmos), 6)}`);
    else parts.push(`QOR ${formatUnits(await publicClient.getBalance({ address: evm }), 18)}`);
    for (const [sym, address] of Object.entries(tokens)) {
      const bal = await publicClient.readContract({ address: address as Hex, abi: erc20Abi, functionName: "balanceOf", args: [evm] });
      parts.push(`${sym} ${formatUnits(bal, 18)}`);
    }
    show(`${label} balances`, parts.join("  "));
  }
}
