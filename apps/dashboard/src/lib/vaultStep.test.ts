import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { runVaultStep, type VaultStepDeps } from "./vaultStep";

const VAULT = "0x3333333333333333333333333333333333333333" as Hex;
const H = (n: number) => (`0x${n.toString(16).padStart(64, "0")}`) as Hex;

function fake(o: { located?: Hex | null; locateFails?: boolean; rolesFail?: boolean; mintFailsAt?: string; deployReverts?: boolean } = {}) {
  const calls: string[] = [];
  let n = 0;
  const deps: VaultStepDeps = {
    locate: async () => {
      calls.push("locate");
      if (o.locateFails) throw new Error("RPC down");
      return o.located ?? null;
    },
    withWindow: async (txs, run) => {
      calls.push(`window:${txs}`);
      return { windowTx: "WIN", txs: await run() };
    },
    deploy: async () => (calls.push("deploy"), H(++n)),
    deployed: async () => {
      calls.push("receipt");
      if (o.deployReverts) throw new Error("the vault deploy reverted on chain");
      return VAULT;
    },
    save: (v) => calls.push(`save:${v}`),
    checkRoles: async () => {
      calls.push("roles");
      if (o.rolesFail) throw new Error("the contract does not name this owner and Guardian");
    },
    mint: async (s) => {
      calls.push(`mint:${s}`);
      if (o.mintFailsAt === s) throw new Error(`the ${s} mint reverted`);
      return H(++n);
    },
    progress: () => {},
  };
  return { deps, calls };
}

describe("runVaultStep", () => {
  it("reads the chain fresh first: an existing vault aborts before any window opens", async () => {
    const f = fake({ located: VAULT });
    await expect(runVaultStep(f.deps)).rejects.toThrow(/already has a vault/);
    expect(f.calls).toEqual(["locate"]);
  });

  it("a failed fresh read aborts too (never read as 'no vault')", async () => {
    const f = fake({ locateFails: true });
    await expect(runVaultStep(f.deps)).rejects.toThrow(/RPC down/);
    expect(f.calls).toEqual(["locate"]);
  });

  it("deploys and mints in one 4-tx window; the vault is saved right after the receipt, before the roles check", async () => {
    const f = fake();
    const r = await runVaultStep(f.deps);
    expect(f.calls).toEqual(["locate", "window:4", "deploy", "receipt", `save:${VAULT}`, "roles", "mint:fUSD", "mint:fETH", "mint:fBTC"]);
    expect(r).toEqual({ vault: VAULT, windowTx: "WIN", txs: [H(1), H(2), H(3), H(4)] });
  });

  it("a roles check that fails after the deploy still leaves the vault saved (a retry finds it, no second deploy)", async () => {
    const f = fake({ rolesFail: true });
    await expect(runVaultStep(f.deps)).rejects.toThrow(/does not name/);
    expect(f.calls).toContain(`save:${VAULT}`);
  });

  it("a mint that fails after the deploy keeps the saved vault", async () => {
    const f = fake({ mintFailsAt: "fETH" });
    await expect(runVaultStep(f.deps)).rejects.toThrow(/fETH mint/);
    expect(f.calls.indexOf(`save:${VAULT}`)).toBeLessThan(f.calls.indexOf("mint:fETH"));
  });
});
