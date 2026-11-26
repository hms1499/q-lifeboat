import type { OwnerPublicState } from "@qday/core";
import type { UnifiedAccount } from "@qorechain/sdk";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { createOwnerTx, OWNER_WINDOW_BLOCKS, type Msg, type OwnerTxDeps, type OwnerWallet } from "./ownerTx";

const ACC = { evm: "0x0698A02Ea2d4cE6A064Bf9a61b5C6f8dd0879557", cosmos: "qor1q6v2qt4z6n8x5pjtlxnpkhr03hgg092hjgtnek" } as unknown as UnifiedAccount;
const FUSD = "0x8478737e5ac2c2cbf70aad17f459d1b8ab8a7a14" as Hex;
const FETH = "0x0a958bba25f5fddca1b1f9cec44bdf076a8ea6c5" as Hex;
const WALLET = { tag: "wallet" } as unknown as OwnerWallet;

type Call = { kind: string; detail?: unknown };

/** Fake hosted + chain: records every call in order. The window shows live after `liveAfter` reads. */
function fake(stage: OwnerPublicState["stage"], o: { liveAfter?: number; armFails?: boolean; stageFails?: boolean } = {}) {
  const calls: Call[] = [];
  const sent: Msg[][] = [];
  let reads = 0;
  let windowSent = false;
  const deps: OwnerTxDeps = {
    broadcast: async (_acc, msgs, memo) => {
      calls.push({ kind: "broadcast", detail: memo });
      sent.push(msgs);
      if (msgs.some((m) => m.typeUrl.endsWith("MsgOpenEVMWindow"))) windowSent = true;
      return "AB".repeat(32);
    },
    ownerStage: async () => {
      calls.push({ kind: "stage" });
      if (o.stageFails) throw new Error("hosted unreachable");
      return stage;
    },
    arm: async (_acc, blocks) => {
      calls.push({ kind: "arm", detail: blocks });
      if (o.armFails) throw new Error("arm refused (HTTP 404)");
    },
    windowLive: async () => {
      calls.push({ kind: "live" });
      if (!windowSent) return false;
      reads++;
      return reads >= (o.liveAfter ?? 1);
    },
    wallet: () => WALLET,
    sleep: async () => {},
  };
  return { deps, calls, sent };
}

const kinds = (c: Call[]) => c.map((x) => x.kind).filter((k) => k !== "live");
const windowMsg = (msgs: Msg[]) => msgs.find((m) => m.typeUrl.endsWith("MsgOpenEVMWindow"))!.value as Record<string, unknown>;

describe("withOwnerWindow", () => {
  it("arms before opening when active, not before onboarding", async () => {
    const active = fake("active");
    await createOwnerTx(active.deps).withOwnerWindow(ACC, { txs: 2, scope: [FUSD] }, async () => []);
    expect(kinds(active.calls)).toEqual(["stage", "arm", "broadcast"]);
    expect(active.calls.find((c) => c.kind === "arm")!.detail).toBe(OWNER_WINDOW_BLOCKS);
    expect(OWNER_WINDOW_BLOCKS).toBe(600);

    for (const stage of ["none", "starter", "provisioned"] as const) {
      const f = fake(stage);
      await createOwnerTx(f.deps).withOwnerWindow(ACC, { txs: 4, scope: "unscoped" }, async () => []);
      expect(kinds(f.calls)).toEqual(["stage", "broadcast"]);
    }
  });

  it("a retired owner is armed too (the gateway revives its Guardian before the window opens)", async () => {
    const f = fake("retired");
    await createOwnerTx(f.deps).withOwnerWindow(ACC, { txs: 1, scope: [FUSD] }, async () => []);
    expect(kinds(f.calls)).toEqual(["stage", "arm", "broadcast"]);
  });

  it("a failed arm opens no window", async () => {
    const f = fake("active", { armFails: true });
    await expect(createOwnerTx(f.deps).withOwnerWindow(ACC, { txs: 1, scope: [FUSD] }, async () => [])).rejects.toThrow(/arm/);
    expect(f.sent).toEqual([]);
  });

  it("an unreadable owner stage opens no window (it can't tell whether to arm)", async () => {
    const f = fake("active", { stageFails: true });
    await expect(createOwnerTx(f.deps).withOwnerWindow(ACC, { txs: 1, scope: [FUSD] }, async () => [])).rejects.toThrow(/hosted unreachable/);
    expect(f.sent).toEqual([]);
  });

  it("sizes maxTxs to w.txs, 600 blocks", async () => {
    for (const txs of [1, 3, 4]) {
      const f = fake("provisioned");
      await createOwnerTx(f.deps).withOwnerWindow(ACC, { txs, scope: "unscoped" }, async () => []);
      const v = windowMsg(f.sent[0]);
      expect(Number(v.maxTxs)).toBe(txs);
      expect(Number(v.blocks)).toBe(600);
      expect(v.sender).toBe(ACC.cosmos);
    }
  });

  it("unscoped opens with no targets; a scope lists exactly its addresses", async () => {
    const u = fake("provisioned");
    await createOwnerTx(u.deps).withOwnerWindow(ACC, { txs: 4, scope: "unscoped" }, async () => []);
    expect(windowMsg(u.sent[0]).allowedTargets).toEqual([]);

    const s = fake("provisioned");
    await createOwnerTx(s.deps).withOwnerWindow(ACC, { txs: 2, scope: [FUSD, FETH] }, async () => []);
    expect(windowMsg(s.sent[0]).allowedTargets).toEqual([FUSD, FETH]);
  });

  it("the value budget grows with the txs and the top-up", async () => {
    const budget = async (txs: number, topupUqor?: bigint) => {
      const f = fake("provisioned");
      await createOwnerTx(f.deps).withOwnerWindow(ACC, { txs, scope: [FUSD], topupUqor }, async () => []);
      return BigInt(windowMsg(f.sent[0]).maxValue as string);
    };
    const one = await budget(1);
    expect(await budget(3)).toBe(one * 3n);
    expect(await budget(1, 5_000_000n)).toBe(one + 5_000_000n);
  });

  it("an empty scope is refused (it would open an UNSCOPED window), and so is a duplicate", async () => {
    const f = fake("provisioned");
    await expect(createOwnerTx(f.deps).withOwnerWindow(ACC, { txs: 1, scope: [] }, async () => [])).rejects.toThrow(/scope/);
    await expect(createOwnerTx(f.deps).withOwnerWindow(ACC, { txs: 1, scope: [FUSD, FUSD.toUpperCase().replace("0X", "0x") as Hex] }, async () => [])).rejects.toThrow(/duplicate/);
    expect(f.sent).toEqual([]);
  });

  it("txs must be a positive whole number", async () => {
    const f = fake("provisioned");
    for (const txs of [0, -1, 1.5]) {
      await expect(createOwnerTx(f.deps).withOwnerWindow(ACC, { txs, scope: "unscoped" }, async () => [])).rejects.toThrow(/txs/);
    }
    expect(f.sent).toEqual([]);
  });

  it("extra messages ride in the SAME hybrid tx, after the window", async () => {
    const f = fake("provisioned");
    const link: Msg[] = [
      { typeUrl: "/qorechain.abstractaccount.v1.MsgUpdateSpendingRules", value: {} },
      { typeUrl: "/qorechain.abstractaccount.v1.MsgRegisterAuthenticator", value: {} },
    ];
    await createOwnerTx(f.deps).withOwnerWindow(ACC, { txs: 3, scope: [FUSD], extraMsgs: link }, async () => []);
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0].map((m) => m.typeUrl)).toEqual(["/qorechain.pqc.v1.MsgOpenEVMWindow", ...link.map((m) => m.typeUrl)]);
  });

  it("waits until the window is live, then runs with the wallet and returns the hashes", async () => {
    const f = fake("provisioned", { liveAfter: 3 });
    let ranAfterLive = false;
    const out = await createOwnerTx(f.deps).withOwnerWindow(ACC, { txs: 1, scope: "unscoped" }, async (w) => {
      expect(w).toBe(WALLET);
      ranAfterLive = f.calls.filter((c) => c.kind === "live").length >= 3;
      return ["0xaa" as Hex];
    });
    expect(ranAfterLive).toBe(true);
    expect(out).toEqual({ windowTx: "AB".repeat(32), txs: ["0xaa"] });
  });

  it("a window that never shows live is an error and nothing runs", async () => {
    const f = fake("provisioned", { liveAfter: 1_000 });
    let ran = false;
    await expect(
      createOwnerTx(f.deps).withOwnerWindow(ACC, { txs: 1, scope: "unscoped" }, async () => {
        ran = true;
        return [];
      }),
    ).rejects.toThrow(/live/);
    expect(ran).toBe(false);
  });
});

describe("sendHybrid", () => {
  it("broadcasts the messages and returns the tx hash", async () => {
    const f = fake("provisioned");
    const msgs: Msg[] = [{ typeUrl: "/x.Msg", value: {} }];
    expect(await createOwnerTx(f.deps).sendHybrid(ACC, msgs, "memo")).toBe("AB".repeat(32));
    expect(f.sent).toEqual([msgs]);
  });

  it("refuses an empty message list", async () => {
    const f = fake("provisioned");
    await expect(createOwnerTx(f.deps).sendHybrid(ACC, [], "memo")).rejects.toThrow(/no messages/);
  });
});
