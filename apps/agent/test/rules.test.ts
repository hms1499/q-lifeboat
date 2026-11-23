import { describe, expect, it } from "vitest";
import { decide, type OutboundTx } from "../src/rules";

const VAULT = "0x17d867860a0A0Ff528dF655439ff59176b061B3C" as const;
const FRIEND = "0x1111111111111111111111111111111111111111" as const;
const STRANGER = "0x9999999999999999999999999999999999999999" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const DAPP = "0x2222222222222222222222222222222222222222" as const;
const FUSD = "0x00000000000000000000000000000000000000a1" as const;
const MAX = 2n ** 256n - 1n;
const GUARDIAN = "0xFf82cAD6638a38d7009D0d5DfB757136B0C03850" as const;
const policy = { vault: VAULT, guardian: GUARDIAN, allowlist: [FRIEND, DAPP], maxOutbound: 1000n };

const tx = (over: Partial<OutboundTx> = {}): OutboundTx => ({
  kind: "transfer",
  hash: "0xabc0000000000000000000000000000000000000000000000000000000000001",
  block: 1n,
  token: ZERO,
  to: STRANGER,
  amount: 10n,
  ...over,
});

describe("decide", () => {
  it("test_nativeTopUpToGuardianDoesNotTrigger (also above maxOutbound)", () => {
    for (const amount of [10n, 100_000_000_000_000_000n]) {
      const d = decide(tx({ token: ZERO, to: GUARDIAN.toLowerCase() as `0x${string}`, amount }), policy);
      expect(d).toEqual({ rescue: false, alert: false, reason: "gas tank top-up to the guardian" });
    }
    expect(100_000_000_000_000_000n > policy.maxOutbound).toBe(true);
  });

  it("test_tokenTransferToGuardianStillTriggers", () => {
    const d = decide(tx({ token: FUSD, to: GUARDIAN, amount: 10n }), policy);
    expect(d.rescue).toBe(true);
    expect(d.reason).toMatch(/allowlist/i);
    expect(decide(tx({ token: FUSD, to: GUARDIAN, amount: 10n }), { ...policy, allowlist: [GUARDIAN] }).rescue).toBe(false);
  });

  it("test_approvalToGuardianStillTriggers", () => {
    const approve = (amount: bigint): OutboundTx => ({ ...tx({ token: FUSD, to: GUARDIAN, amount }), kind: "approval" });
    expect(decide(approve(MAX), policy).rescue).toBe(true);
    expect(decide(approve(5n), policy).rescue).toBe(true);
    expect(decide(approve(5n), { ...policy, allowlist: [GUARDIAN] }).rescue).toBe(false);
  });

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

  it("test_transferToTrustedAppDoesNotTrigger", () => {
    const d = decide(tx({ to: DAPP, amount: 1000n }), policy);
    expect(d).toEqual({ rescue: false, alert: false, reason: expect.stringMatching(/trusted/i) });
  });

  it("a transfer never raises an alert-only incident", () => {
    for (const to of [STRANGER, FRIEND, VAULT]) expect(decide(tx({ to }), policy).alert).toBe(false);
  });
});

describe("decide: approvals", () => {
  const approval = (over: Partial<OutboundTx> = {}): OutboundTx => tx({ kind: "approval", token: FUSD, ...over });

  it("test_approvalToUntrustedSpenderTriggersRescue", () => {
    const d = decide(approval({ to: STRANGER, amount: 1n }), policy);
    expect(d.rescue).toBe(true);
    expect(d.alert).toBe(false);
    expect(d.reason).toMatch(/approval/i);
    expect(d.reason).toContain(STRANGER);
  });

  it("an unlimited approval to an untrusted spender triggers a rescue", () => {
    expect(decide(approval({ to: STRANGER, amount: MAX }), policy)).toMatchObject({ rescue: true, alert: false });
  });

  it("test_approvalToTrustedAppDoesNotTrigger", () => {
    // dApps usually ask for an unlimited allowance: maxOutbound applies to transfers only.
    const d = decide(approval({ to: DAPP, amount: MAX }), policy);
    expect(d).toEqual({ rescue: false, alert: false, reason: expect.stringMatching(/approval/i) });
    expect(decide(approval({ to: DAPP.toUpperCase().replace("0X", "0x") as `0x${string}`, amount: 5n }), policy).rescue).toBe(false);
  });

  it("test_zeroApprovalToOtherSpenderDoesNotTrigger", () => {
    // A revoke: it removes a spender's power to move funds.
    const d = decide(approval({ to: STRANGER, amount: 0n }), policy);
    expect(d).toEqual({ rescue: false, alert: false, reason: expect.stringMatching(/revoke/i) });
  });

  it("test_zeroApprovalToVaultRaisesAlertOnly", () => {
    // Review Focus 7: an attacker with the ECDSA key revokes the vault's allowance so rescue() can no longer pull.
    const d = decide(approval({ to: VAULT, amount: 0n }), policy);
    expect(d.rescue).toBe(false);
    expect(d.alert).toBe(true);
    expect(d.reason).toMatch(/revoked/i);
    expect(d.reason).toMatch(/vault allowance was lowered to 0\b/i);
    expect(decide(approval({ to: VAULT.toLowerCase() as `0x${string}`, amount: 0n }), policy).alert).toBe(true);
  });

  it("test_lowApprovalToVaultRaisesAlertOnly", () => {
    // Review Focus 7 bypass: lowering the vault allowance to 1 (not 0) starves rescue() just the same.
    const d = decide(approval({ to: VAULT, amount: 1n }), policy);
    expect(d.rescue).toBe(false);
    expect(d.alert).toBe(true);
    expect(d.reason).toMatch(/vault allowance was lowered to 1\b/i);
    expect(decide(approval({ to: VAULT, amount: MAX - 1n }), policy)).toMatchObject({ rescue: false, alert: true });
  });

  it("an unlimited approval to the vault (the owner's own setup, maxUint256) does nothing", () => {
    expect(decide(approval({ to: VAULT, amount: MAX }), policy)).toEqual({ rescue: false, alert: false, reason: expect.stringMatching(/vault/i) });
  });

  it("an approval to an untrusted spender triggers even with an empty allowlist and a tiny value", () => {
    expect(decide(approval({ to: FRIEND, amount: 1n }), { ...policy, allowlist: [] }).rescue).toBe(true);
  });
});
