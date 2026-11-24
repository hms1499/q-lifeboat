import type { Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import { parsePhishArgs, phish, phishVerdict, type PhishDeps } from "../src/phish";

const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const E = 10n ** 18n;
const DRAINER = "0x00000000000000000000000000000000000000d1" as const;

type Bal = { owner: bigint; vault: bigint; drainer: bigint };

function makeDeps(after: Bal, over: Partial<PhishDeps> = {}) {
  const order: string[] = [];
  let reads = 0;
  const deps: PhishDeps = {
    log: () => {},
    drainer: DRAINER,
    balances: vi.fn(async () => (reads++ === 0 ? { owner: 100n * E, vault: 0n, drainer: 5n * E } : after)),
    openDrainerWindow: vi.fn(async () => {
      order.push("window");
      return "WINDOW";
    }),
    sendApprove: vi.fn(async () => {
      order.push("approve");
      return h(1);
    }),
    sendTransferFrom: vi.fn(async (amount: bigint) => {
      order.push(`transferFrom:${amount}`);
      return h(2);
    }),
    waitReceipt: vi.fn(async (hash: Hex) => {
      order.push(`wait${Number(BigInt(hash))}`);
      return hash === h(1) ? { status: "success" as const, blockNumber: 500n } : { status: "reverted" as const, blockNumber: 501n };
    }),
    findRescue: vi.fn(async () => ({ hash: h(3), block: 501n })),
    settle: vi.fn(async () => {}),
    waitBlock: vi.fn(async (n: bigint) => {
      order.push(`block>=${n}`);
    }),
    ...over,
  };
  return { deps, order };
}

describe("phish", () => {
  it("opens the drainer's window first, then the owner's approve, then the drainer's transferFrom of the whole balance at once", async () => {
    const { deps, order } = makeDeps({ owner: 0n, vault: 100n * E, drainer: 5n * E });
    await phish(deps);
    expect(order).toEqual(["window", "approve", "wait1", `transferFrom:${100n * E}`, "wait2"]);
    expect(deps.settle).toHaveBeenCalledWith(500n);
    expect(deps.findRescue).toHaveBeenCalledWith(500n);
  });

  it("PASS: the Guardian rescued first, the drainer's transferFrom reverted and it gained nothing", async () => {
    const { deps } = makeDeps({ owner: 0n, vault: 100n * E, drainer: 5n * E });
    const r = await phish(deps);
    expect(r.approve).toMatchObject({ hash: h(1), block: "500", status: "success" });
    expect(r.transferFrom).toMatchObject({ hash: h(2), block: "501", status: "reverted" });
    expect(r.rescue).toEqual({ hash: h(3), block: "501" });
    expect(r.verdict).toMatchObject({ pass: true, drained: "0", rescued: (100n * E).toString(), blocks: "1" });
  });

  it("FAIL, reported as is: the drainer won the race", async () => {
    const { deps } = makeDeps(
      { owner: 0n, vault: 0n, drainer: 105n * E },
      {
        waitReceipt: vi.fn(async () => ({ status: "success" as const, blockNumber: 500n })),
        findRescue: vi.fn(async () => null),
      },
    );
    const r = await phish(deps);
    expect(r.verdict.pass).toBe(false);
    expect(r.verdict.drained).toBe((100n * E).toString());
    expect(r.verdict.failures.join()).toMatch(/drainer took/);
    expect(r.verdict.failures.join()).toMatch(/no rescue/);
  });

  it("FAIL, never a false PASS, when the drainer's transferFrom was not sent or not mined", async () => {
    const after = { owner: 0n, vault: 100n * E, drainer: 5n * E };
    const thrown = makeDeps(after, { sendTransferFrom: vi.fn(async () => Promise.reject(new Error("no open EVM authorisation window"))) });
    const r1 = await phish(thrown.deps);
    expect(r1.verdict.pass).toBe(false);
    expect(r1.verdict.failures.join()).toMatch(/transferFrom was not mined/);
    const timedOut = makeDeps(after, {
      waitReceipt: vi.fn(async (hash: Hex) => {
        if (hash === h(1)) return { status: "success" as const, blockNumber: 500n };
        throw new Error("timed out");
      }),
    });
    const r2 = await phish(timedOut.deps);
    expect(r2.verdict.pass).toBe(false);
    expect(r2.verdict.failures.join()).toMatch(/transferFrom was not mined \(timed out\)/);
  });

  it("an approve that reverts stops before any drain", async () => {
    const { deps } = makeDeps(
      { owner: 100n * E, vault: 0n, drainer: 5n * E },
      { waitReceipt: vi.fn(async () => ({ status: "reverted" as const, blockNumber: 500n })) },
    );
    const r = await phish(deps);
    expect(deps.sendTransferFrom).not.toHaveBeenCalled();
    expect(r.verdict.failures.join()).toMatch(/approve did not land \(reverted\)/);
  });

  it("stops before any drain when the owner's approve did not land", async () => {
    const { deps } = makeDeps({ owner: 100n * E, vault: 0n, drainer: 5n * E }, { sendApprove: vi.fn(async () => Promise.reject(new Error("no open EVM authorisation window"))) });
    const r = await phish(deps);
    expect(deps.sendTransferFrom).not.toHaveBeenCalled();
    expect(r.verdict.pass).toBe(false);
    expect(r.verdict.failures.join()).toMatch(/approve did not land/);
  });

  it("refuses to start when the owner holds nothing to phish", async () => {
    const { deps } = makeDeps({ owner: 0n, vault: 0n, drainer: 0n }, { balances: vi.fn(async () => ({ owner: 0n, vault: 0n, drainer: 0n })) });
    await expect(phish(deps)).rejects.toThrow(/no fUSD/);
    expect(deps.openDrainerWindow).not.toHaveBeenCalled();
  });
});

describe("drainer delay", () => {
  it("0 (default): no wait between the approval and the drain", async () => {
    const { deps, order } = makeDeps({ owner: 0n, vault: 100n * E, drainer: 5n * E });
    const r = await phish(deps);
    expect(deps.waitBlock).not.toHaveBeenCalled();
    expect(r.drainerDelayBlocks).toBe(0);
    expect(order).toContain(`transferFrom:${100n * E}`);
  });
  it("N blocks: the drainer waits until the approval block + N, then pulls; recorded in the result", async () => {
    const { deps, order } = makeDeps({ owner: 0n, vault: 100n * E, drainer: 5n * E });
    const r = await phish(deps, { drainerDelayBlocks: 2 });
    expect(order).toEqual(["window", "approve", "wait1", "block>=502", `transferFrom:${100n * E}`, "wait2"]);
    expect(r.drainerDelayBlocks).toBe(2);
  });
  it("parsePhishArgs: nothing, or --drainer-delay 0..20", () => {
    expect(parsePhishArgs([])).toEqual({ drainerDelayBlocks: 0 });
    expect(parsePhishArgs(["--drainer-delay", "2"])).toEqual({ drainerDelayBlocks: 2 });
    expect(() => parsePhishArgs(["--drainer-delay"])).toThrow(/usage/);
    expect(() => parsePhishArgs(["--drainer-delay", "21"])).toThrow(/0 to 20/);
    expect(() => parsePhishArgs(["--drainer-delay", "-1"])).toThrow(/usage/);
    expect(() => parsePhishArgs(["--fast"])).toThrow(/usage/);
  });
});

describe("phishVerdict", () => {
  const before = { owner: 100n * E, vault: 0n, drainer: 0n };
  it("needs the rescue within 3 blocks of the approval and at least 80% kept", () => {
    const slow = phishVerdict(before, { owner: 0n, vault: 100n * E, drainer: 0n }, 500n, 505n);
    expect(slow.pass).toBe(false);
    expect(slow.failures.join()).toMatch(/5 blocks/);
    const partial = phishVerdict(before, { owner: 0n, vault: 70n * E, drainer: 0n }, 500n, 501n);
    expect(partial.pass).toBe(false);
    expect(partial.failures.join()).toMatch(/70.00% kept/);
  });
});


describe("checkDrainer", () => {
  const OWNER = "0x00000000000000000000000000000000000000aa";
  it("refuses a drainer the agent trusts (any case) or the owner itself", async () => {
    const { checkDrainer } = await import("../src/phish");
    expect(() => checkDrainer(DRAINER, OWNER, [])).not.toThrow();
    expect(() => checkDrainer(DRAINER, OWNER, [{ address: DRAINER.toUpperCase().replace("0X", "0x") }])).toThrow(/trusted list/);
    expect(() => checkDrainer(OWNER, OWNER, [])).toThrow(/is the owner/);
  });
});

describe("checkAgentOwner", () => {
  it("refuses an agent on AGENT_PORT that watches another owner (an approval would go unseen)", async () => {
    const { checkAgentOwner } = await import("../src/phish");
    const OWNER = "0x00000000000000000000000000000000000000aa";
    expect(() => checkAgentOwner(OWNER.toUpperCase().replace("0X", "0x"), OWNER)).not.toThrow();
    expect(() => checkAgentOwner(DRAINER, OWNER)).toThrow(/watches .* not this run's owner/);
  });
});
