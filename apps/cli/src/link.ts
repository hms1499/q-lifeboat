import { loadAgentKey, loadOwner, loadVault, vaultAbi } from "@qday/core";
import type { SpendingRules } from "@qorechain/sdk";
import type { Hex } from "viem";
import { fetchOwnerAuthenticators, fetchOwnerSpendingRules } from "./abstractaccount";
import { broadcast as chainBroadcast, publicClient } from "./chain";
import { buildGuardianLinkMsgs } from "./setup";
import { checkExpectedOwner } from "./window";

type Env = Record<string, string | undefined>;

const USAGE = "usage: link [--expect 0xOWNER]";

/** `link [--expect 0x…]`. Throws on anything else. */
export function parseLinkArgs(args: string[]): { expect?: string } {
  let expect: string | undefined;
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === "--expect" && expect === undefined) {
      const v = args[i + 1];
      if (v === undefined || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`--expect needs the owner's 0x address (${USAGE})`);
      expect = v;
    } else throw new Error(`unexpected "${args[i]}" (${USAGE})`);
  }
  return { expect };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Refuse, before anything is signed, a vault the signer does not own, or one whose immutable guardian is not the
 * configured GUARDIAN_ADDRESS (when set): linking the agent to someone else's vault would point its rule at it.
 */
export function checkLinkTarget(onChain: { owner: string; guardian: string }, want: { owner: string; guardian?: string }): void {
  if (!same(onChain.owner, want.owner)) {
    throw new Error(`vault owner() is ${onChain.owner}, but OWNER_MNEMONIC is ${want.owner}: refusing to link`);
  }
  if (want.guardian !== undefined && !same(onChain.guardian, want.guardian)) {
    throw new Error(`vault guardian() is ${onChain.guardian}, but GUARDIAN_ADDRESS is ${want.guardian}: refusing to link`);
  }
}

/** Injectable I/O of `runLink`; defaults are the production wiring. */
export type LinkDeps = {
  getCode(vault: Hex): Promise<Hex | undefined>;
  readRoles(vault: Hex): Promise<{ owner: Hex; guardian: Hex }>;
  authenticators: typeof fetchOwnerAuthenticators;
  spendingRules(cosmos: string): Promise<Pick<SpendingRules, "rules" | "authenticatorRules">>;
  broadcast: typeof chainBroadcast;
  nowUnix(): number;
  log(line: string): void;
};

const defaultDeps: LinkDeps = {
  getCode: (address) => publicClient.getCode({ address }),
  readRoles: async (vault) => ({
    owner: (await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "owner" })) as Hex,
    guardian: (await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "guardian" })) as Hex,
  }),
  authenticators: (address) => fetchOwnerAuthenticators(address),
  spendingRules: (cosmos) => fetchOwnerSpendingRules(cosmos),
  broadcast: chainBroadcast,
  nowUnix: () => Math.floor(Date.now() / 1000),
  log: (line) => console.log(line),
};

/**
 * `pnpm cli link [--expect 0xOWNER]`: link the Guardian's ed25519 key to the OWNER_MNEMONIC account with the same
 * spending rule `setup` sends, in one hybrid tx and with no window message. The vault the owner deployed from the
 * browser is read on chain first. A browser wallet cannot sign this tx (hybrid), hence the CLI.
 */
export async function runLink(args: string[], env: Env = process.env, deps: Partial<LinkDeps> = {}): Promise<void> {
  const d = { ...defaultDeps, ...deps };
  const parsed = parseLinkArgs(args);
  const owner = await loadOwner(env);
  checkExpectedOwner(owner.evm, parsed.expect);
  const vault = loadVault(env);
  const agent = loadAgentKey(env);
  const guardian = env.GUARDIAN_ADDRESS?.trim() || undefined;
  d.log(`owner ${owner.evm} (${owner.cosmos}), vault ${vault}`);

  const code = await d.getCode(vault);
  if (!code || code === "0x") throw new Error(`VAULT_ADDRESS ${vault} has no contract code on diana`);
  checkLinkTarget(await d.readRoles(vault), { owner: owner.evm, guardian });

  // A fresh owner has no abstractaccount record until this first link: the helper treats that 404 as "none".
  const existing = await d.authenticators(owner.cosmos);
  const msgs = buildGuardianLinkMsgs(owner, vault, agent, existing, d.nowUnix());
  const hash = await d.broadcast(owner, msgs, "qday: link guardian");
  d.log(`link (${msgs.length} msg): ${hash}`);

  // Informational only: the tx above already succeeded, so a REST hiccup here must not turn it into an error.
  try {
    const rule = (await d.spendingRules(owner.cosmos)).rules.find((r) => r.enabled);
    d.log(rule ? `spending rule ${rule.id}: ${rule.allowedEvmCalls.join(", ")} (denoms ${rule.allowedDenoms.join(", ")})` : "no enabled spending rule yet");
  } catch (e) {
    d.log(`spending rule unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }
}
