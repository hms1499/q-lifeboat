import { describe, expect, it } from "vitest";
import { decide, type OutboundTx } from "../src/rules";

const VAULT = "0x17d867860a0A0Ff528dF655439ff59176b061B3C" as const;
const FRIEND = "0x1111111111111111111111111111111111111111" as const;
const STRANGER = "0x9999999999999999999999999999999999999999" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const policy = { vault: VAULT, allowlist: [FRIEND], maxOutbound: 1000n };

const tx = (over: Partial<OutboundTx> = {}): OutboundTx => ({
  hash: "0xabc0000000000000000000000000000000000000000000000000000000000001",
  block: 1n,
  token: ZERO,
  to: STRANGER,
  amount: 10n,
  ...over,
});

describe("decide", () => {
  it("test_rescueOnUnknownRecipient", () => {
    const d = decide(tx({ to: STRANGER }), policy);
    expect(d.rescue).toBe(true);
    expect(d.reason).toMatch(/allowlist/i);
  });

  it("test_noRescueForAllowlistedRecipient", () => {
    expect(decide(tx({ to: FRIEND, amount: 1000n }), policy).rescue).toBe(false);
  });

  it("test_rescueOnAmountAboveMax", () => {
    const d = decide(tx({ to: FRIEND, amount: 1001n }), policy);
    expect(d.rescue).toBe(true);
    expect(d.reason).toMatch(/max/i);
  });

  it("test_noRescueForTransferIntoVault", () => {
    // The agent's own rescue moves owner -> vault and must never re-trigger it, whatever the amount.
    expect(decide(tx({ to: VAULT, amount: 10n ** 30n }), policy).rescue).toBe(false);
  });

  it("test_addressCompareIsCaseInsensitive", () => {
    expect(decide(tx({ to: FRIEND.toUpperCase().replace("0X", "0x") as `0x${string}` }), policy).rescue).toBe(false);
    expect(decide(tx({ to: VAULT.toLowerCase() as `0x${string}` }), policy).rescue).toBe(false);
  });

  it("rescues when the allowlist is empty", () => {
    expect(decide(tx({ to: FRIEND }), { ...policy, allowlist: [] }).rescue).toBe(true);
  });
});
