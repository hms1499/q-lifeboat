import { maxUint256, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import type { AgentConfig } from "./config";
import { describeIncident } from "./explain";

const USD = "0x1111111111111111111111111111111111111111";
const ETH = "0x2222222222222222222222222222222222222222";
const BTC = "0x3333333333333333333333333333333333333333";
const VAULT = "0x77690000000000000000000000000000000071e6";
const GUARD = "0xff820000000000000000000000000000000f3850";
const cfg = { tokens: { fUSD: USD, fETH: ETH, fBTC: BTC }, vault: VAULT, guardian: GUARD } as unknown as AgentConfig;
const E18 = 10n ** 18n;

const make = (trigger: Record<string, unknown>, rescues: unknown[] = []) =>
  ({
    id: "x",
    detectedAt: "2026-11-21T10:00:00.000Z",
    trigger: { kind: "transfer", hash: `0x${"cc".repeat(32)}`, block: "100", token: USD, to: "0xe256aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa59f3", amount: String(10n * E18), ...trigger },
    reason: "r",
    rescues,
    summary: "s",
    summarySource: "template",
  }) as never;
const rescue = (token: string, amt: bigint, success = true) => ({ token, hash: "0xaa", amount: String(amt * E18), expected: String(amt * E18), success });

describe("describeIncident", () => {
  it("transfer with a rescue", () => {
    const d = describeIncident(make({}, [rescue(USD, 90n)]), cfg);
    expect(d.headline).toBe("10 fUSD left your account to 0xe256…59f3, which you don't trust");
    expect(d.detail).toBe("The Guardian reports it moved 90 fUSD into your vault.");
  });
  it("joins several tokens with ' + ' and sums per token", () => {
    const d = describeIncident(make({}, [rescue(ETH, 50n), rescue(ETH, 47n), rescue(BTC, 100n)]), cfg);
    expect(d.detail).toBe("The Guardian reports it moved 97 fETH + 100 fBTC into your vault.");
  });
  it("ignores failed rescues; nothing moved", () => {
    expect(describeIncident(make({}, [rescue(USD, 90n, false)]), cfg).detail).toBe("The Guardian reports it tried a rescue but nothing moved.");
  });
  it("approval, limited and unlimited", () => {
    const to = "0x5555555555555555555555555555555555555555";
    expect(describeIncident(make({ kind: "approval", to, amount: maxUint256.toString() }, [rescue(USD, 1n)]), cfg).headline).toBe(
      "Your account approved 0x5555…5555 to spend unlimited fUSD",
    );
    expect(describeIncident(make({ kind: "approval", to, amount: String(5n * E18) }), cfg).headline).toBe("Your account approved 0x5555…5555 to spend 5 fUSD");
  });
  it("alert without rescues", () => {
    expect(describeIncident(make({ kind: "approval" }), cfg).detail).toBe("No rescue: the rules flag this for you, but moving funds would not undo it.");
  });
  it("native QOR", () => {
    expect(describeIncident(make({ token: zeroAddress }), cfg).headline).toBe("10 QOR left your account to 0xe256…59f3, which you don't trust");
  });

  it("transfer to the guardian or the vault is not 'untrusted'", () => {
    const tenth = String(E18 / 10n);
    expect(describeIncident(make({ token: zeroAddress, to: GUARD.toUpperCase().replace("0X", "0x"), amount: tenth }), cfg).headline).toBe("0.1 QOR left your account to your Guardian (0xFF82…3850)");
    expect(describeIncident(make({ to: VAULT }), cfg).headline).toBe("10 fUSD left your account to your vault (0x7769…71e6)");
  });
  it("approval to the vault: allowance lowered / set to unlimited", () => {
    const lowered = describeIncident(make({ kind: "approval", to: VAULT, amount: String(5n * E18) }), cfg);
    expect(lowered.headline).toBe("Your vault's fUSD allowance was lowered to 5");
    expect(lowered.detail).toBe("No rescue: the Guardian can now rescue at most that much fUSD. Re-approve the vault to restore full cover.");
    expect(describeIncident(make({ kind: "approval", to: VAULT, amount: maxUint256.toString() }), cfg).headline).toBe("Your vault's fUSD allowance was set to unlimited");
  });
  it("approval to the guardian", () => {
    expect(describeIncident(make({ kind: "approval", to: GUARD, amount: String(2n * E18) }), cfg).headline).toBe("Your account approved your Guardian (0xff82…3850) to spend 2 fUSD");
  });
});
