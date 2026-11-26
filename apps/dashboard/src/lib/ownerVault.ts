import type { Hex } from "viem";

/**
 * The owner's vault for Recover with the in-app wallet, read from the chain rather than the agent's /config (a stopped
 * or retired Guardian must never keep an owner from their funds): the first candidate (the service's record, then the
 * browser's saved vault) whose on-chain `owner()` is this owner. A read error propagates.
 */
export async function ownerVault(
  owner: Hex,
  candidates: (string | null | undefined)[],
  roles: (vault: Hex) => Promise<{ owner: Hex; guardian: Hex } | null>,
): Promise<Hex | null> {
  const seen = new Set<string>();
  for (const c of candidates) {
    if (!c || !/^0x[0-9a-fA-F]{40}$/.test(c) || seen.has(c.toLowerCase())) continue;
    seen.add(c.toLowerCase());
    const r = await roles(c as Hex);
    if (r && r.owner.toLowerCase() === owner.toLowerCase()) return c as Hex;
  }
  return null;
}
