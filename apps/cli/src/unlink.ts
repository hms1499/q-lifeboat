import { buildUnlinkMsg, loadAgentKey, loadOwner } from "@qday/core";
import { toHex } from "viem";
import { fetchOwnerAuthenticators } from "./abstractaccount";
import { broadcast as chainBroadcast } from "./chain";
import { checkExpectedOwner } from "./window";

type Env = Record<string, string | undefined>;

const USAGE = "usage: unlink [--expect 0xOWNER]";

/** `unlink [--expect 0x…]`. Throws on anything else. */
export function parseUnlinkArgs(args: string[]): { expect?: string } {
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

export { buildUnlinkMsg };

const norm = (hex: string) => hex.replace(/^0x/i, "").toLowerCase();

/** Injectable I/O of `runUnlink`; defaults are the production wiring. */
export type UnlinkDeps = {
  authenticators: typeof fetchOwnerAuthenticators;
  broadcast: typeof chainBroadcast;
  log(line: string): void;
};

const defaultDeps: UnlinkDeps = {
  authenticators: (address) => fetchOwnerAuthenticators(address),
  broadcast: chainBroadcast,
  log: (line) => console.log(line),
};

/**
 * `pnpm cli unlink [--expect 0xOWNER]`: revoke the Guardian's ed25519 key (AGENT_ED25519_SK) on the OWNER_MNEMONIC
 * account, one hybrid tx, no window. Part of "Turn off protection": the agent rescues through the guardian account, so
 * what stops rescues is `approve(vault, 0)` per token (the dashboard); this removes the agent's on-chain permission.
 */
export async function runUnlink(args: string[], env: Env = process.env, deps: Partial<UnlinkDeps> = {}): Promise<void> {
  const d = { ...defaultDeps, ...deps };
  const parsed = parseUnlinkArgs(args);
  const owner = await loadOwner(env);
  checkExpectedOwner(owner.evm, parsed.expect);
  const agent = loadAgentKey(env);
  d.log(`owner ${owner.evm} (${owner.cosmos})`);

  const msg = buildUnlinkMsg(owner, agent, await d.authenticators(owner.cosmos));
  const hash = await d.broadcast(owner, [msg], "qday: unlink guardian");
  d.log(`unlink (revoke the Guardian's key): ${hash}`);

  // Informational only: the tx above already succeeded, so a REST hiccup here must not turn it into an error.
  try {
    const want = norm(toHex(agent.pk));
    const after = (await d.authenticators(owner.cosmos)).filter((a) => norm(a.pubkeyHex) === want);
    d.log(`Guardian key ${want.slice(0, 8)}… read back: revoked: ${after.length > 0 && after.every((a) => a.revoked)}`);
  } catch (e) {
    d.log(`read-back unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }
}
