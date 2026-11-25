import type { Incident } from "@qday/core";
import { getAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { ATTACK_AMOUNT, attackOutcome, attackTarget, fusdRescue, incidentFor } from "./attack";

const T1 = "0x1111111111111111111111111111111111111111";
const H = (n: number) => (`0x${n.toString(16).padStart(64, "0")}`) as Hex;

describe("attackTarget", () => {
  it("is a fresh checksummed address on every call", () => {
    const a = attackTarget();
    const b = attackTarget();
    expect(a).not.toBe(b);
    expect(getAddress(a)).toBe(a);
  });

  it("is never in the trusted list (nor the zero address): drawn again until it is not", () => {
    const draws = [new Uint8Array(20).fill(0x11), new Uint8Array(20), new Uint8Array(20).fill(0x22)];
    const t = attackTarget([T1.toUpperCase().replace("0X", "0x")], (buf) => (buf.set(draws.shift()!), buf));
    expect(t).toBe(getAddress("0x2222222222222222222222222222222222222222"));
  });

  it("sends 10 fUSD", () => {
    expect(ATTACK_AMOUNT).toBe(10n * 10n ** 18n);
  });
});

const FETH = "0x2222222222222222222222222222222222222222" as Hex;
const incident = (hash: Hex, rescues: { hash: string; amount: bigint; success: boolean; token?: Hex }[]): Incident =>
  ({
    id: `i-${hash.slice(-4)}`,
    trigger: { kind: "transfer", hash, block: 100n, token: T1 as Hex, to: T1 as Hex, amount: ATTACK_AMOUNT },
    rescues: rescues.map((r) => ({ expected: r.amount, ...r, token: r.token ?? (T1 as Hex) })),
  }) as unknown as Incident;

describe("incidentFor", () => {
  it("the incident whose trigger is this transfer (any hex case)", () => {
    const list = [incident(H(1), []), incident(H(2), [])];
    expect(incidentFor(list, H(2).toUpperCase().replace("0X", "0x") as Hex)?.id).toBe(list[1]!.id);
    expect(incidentFor(list, H(3))).toBeUndefined();
  });
});

describe("attackOutcome", () => {
  it("blocks between the transfer and the rescue, and the share of the balance kept", () => {
    const i = incident(H(1), [{ hash: H(9), amount: 90n * 10n ** 18n, success: true }]);
    expect(attackOutcome(i, { token: T1 as Hex, transferBlock: 100n, rescueBlock: 101n, balanceBefore: 100n * 10n ** 18n })).toEqual({
      rescued: 90n * 10n ** 18n,
      blocksLater: 1n,
      keptPct: 90,
    });
  });

  it("reads amounts as the agent sends them (decimal strings in JSON)", () => {
    const i = JSON.parse(JSON.stringify(incident(H(1), [{ hash: H(9), amount: 90n * 10n ** 18n, success: true }]), (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    expect(attackOutcome(i, { token: T1 as Hex, transferBlock: 100n, rescueBlock: 102n, balanceBefore: 100n * 10n ** 18n })).toEqual({ rescued: 90n * 10n ** 18n, blocksLater: 2n, keptPct: 90 });
  });

  it("counts only the attacked token: fETH and fBTC rescued in the same incident are not fUSD", () => {
    const i = incident(H(1), [
      { hash: H(8), amount: 100n * 10n ** 18n, success: true, token: FETH },
      { hash: H(9), amount: 90n * 10n ** 18n, success: true },
    ]);
    expect(attackOutcome(i, { token: T1 as Hex, transferBlock: 100n, rescueBlock: 102n, balanceBefore: 100n * 10n ** 18n })).toMatchObject({ rescued: 90n * 10n ** 18n, keptPct: 90 });
    expect(fusdRescue(i, T1.toUpperCase().replace("0X", "0x") as Hex)?.hash).toBe(H(9));
    expect(fusdRescue(incident(H(1), [{ hash: H(8), amount: 1n, success: true, token: FETH }]), T1 as Hex)).toBeUndefined();
  });

  it("a failed rescue moves nothing", () => {
    const i = incident(H(1), [{ hash: H(9), amount: 0n, success: false }]);
    expect(attackOutcome(i, { token: T1 as Hex, transferBlock: 100n, rescueBlock: undefined, balanceBefore: 100n })).toEqual({ rescued: 0n, blocksLater: undefined, keptPct: 0 });
  });
});
