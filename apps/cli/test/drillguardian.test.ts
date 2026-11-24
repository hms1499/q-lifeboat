import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { deriveUnifiedAccount, type PqcStatus, type UnifiedAccount } from "@qorechain/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRILL_GUARDIAN_FILE,
  DRILL_GUARDIAN_TARGET_UQOR,
  drillGuardianInit,
  drillGuardianPath,
  runDrillGuardian,
  type DrillGuardianDeps,
} from "../src/drillguardian";
import { FEE_RESERVE_UQOR } from "../src/fresh";

const DRILL_MNEMONIC = "test test test test test test test test test test test junk";
const FUNDER_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

describe("drillGuardianPath", () => {
  it("is ~/.config/qday/drill-guardian.env, never inside the repo", () => {
    expect(DRILL_GUARDIAN_FILE).toBe("drill-guardian.env");
    expect(drillGuardianPath("/home/x")).toBe("/home/x/.config/qday/drill-guardian.env");
    expect(drillGuardianPath()).toBe(join(homedir(), ".config/qday/drill-guardian.env"));
    expect(() => drillGuardianPath(join(__dirname, ".."))).toThrow(/inside the repo/);
  });
});

describe("drillGuardianInit", () => {
  let home: string;
  let drill: UnifiedAccount;
  let funder: UnifiedAccount;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "qday-drill-"));
    drill = await deriveUnifiedAccount(DRILL_MNEMONIC);
    funder = await deriveUnifiedAccount(FUNDER_MNEMONIC);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const env = () => ({ FUNDER_MNEMONIC });
  const registered = (): PqcStatus => ({ registered: true, possessionProven: true, pubkey: drill.pqc.publicKey });
  const none = (): PqcStatus => ({ registered: false });

  function deps(opts: Partial<DrillGuardianDeps> & { drillBalance?: bigint; funderBalance?: bigint; status?: () => PqcStatus } = {}) {
    const { drillBalance, funderBalance, status, ...over } = opts;
    const calls: string[] = [];
    const lines: string[] = [];
    const sent: { to: string; amount: string }[] = [];
    let drillBal = drillBalance ?? 0n;
    let regDone = false;
    const file = drillGuardianPath(home);
    const d: DrillGuardianDeps = {
      home,
      newMnemonic: vi.fn(() => DRILL_MNEMONIC),
      log: (l) => void lines.push(l),
      sleep: async () => {},
      uqorBalance: vi.fn(async (who: string) => (who === funder.cosmos ? (funderBalance ?? 100_000_000n) : drillBal)),
      broadcast: vi.fn(async (acc: UnifiedAccount, msgs: { typeUrl: string; value: unknown }[], _m: string, mode: "hybrid" | "classical") => {
        calls.push(`${existsSync(file) ? "file" : "nofile"}:${msgs.map((m) => m.typeUrl.split(".").pop()).join("+")}:${mode}`);
        for (const m of msgs) {
          if (m.typeUrl.endsWith("MsgSend")) {
            const v = m.value as { toAddress: string; amount: { amount: string }[] };
            sent.push({ to: v.toAddress, amount: v.amount[0].amount });
            drillBal += BigInt(v.amount[0].amount);
          } else regDone = true;
        }
        return `TX${calls.length}`;
      }),
      pqcStatus: vi.fn(async () => (status ? status() : regDone ? registered() : none())),
      ...over,
    };
    return { d, calls, lines, sent, file };
  }

  it("test_createsFileBeforeFunding", async () => {
    const { d, calls, file } = deps();
    const out = await drillGuardianInit(env(), d);
    expect(d.newMnemonic).toHaveBeenCalledTimes(1);
    expect(out.created).toBe(true);
    expect(calls[0]).toMatch(/^file:MsgSend:hybrid$/); // the file existed when the first tx went out
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, "utf8")).toBe(`DRILL_GAS_MNEMONIC="${DRILL_MNEMONIC}"\nDRILL_GUARDIAN_ADDRESS="${drill.evm}"\n`);
    expect(out.address).toBe(drill.evm);
    expect(out.cosmos).toBe(drill.cosmos);
  });

  it("test_reusesExistingFile", async () => {
    await drillGuardianInit(env(), deps().d);
    const { d } = deps({ drillBalance: DRILL_GUARDIAN_TARGET_UQOR, status: registered });
    const out = await drillGuardianInit(env(), d);
    expect(d.newMnemonic).not.toHaveBeenCalled();
    expect(out.created).toBe(false);
    expect(out.fundTx).toBeUndefined();
    expect(out.registerTx).toBeUndefined();
  });

  it("refuses a file whose address does not match its mnemonic", async () => {
    await drillGuardianInit(env(), deps().d);
    const { d } = deps({ drillBalance: DRILL_GUARDIAN_TARGET_UQOR, status: registered });
    const f = drillGuardianPath(home);
    const bad = readFileSync(f, "utf8").replace(/0x[0-9a-fA-F]{40}/, "0x00000000000000000000000000000000000000aa");
    writeFileSync(f, bad, { mode: 0o600 });
    await expect(drillGuardianInit(env(), d)).rejects.toThrow(/does not match/);
    expect(d.broadcast).not.toHaveBeenCalled();
  });

  it("refuses a reused file that is looser than 0600", async () => {
    await drillGuardianInit(env(), deps().d);
    chmodSync(drillGuardianPath(home), 0o644);
    const { d } = deps({ drillBalance: DRILL_GUARDIAN_TARGET_UQOR, status: registered });
    await expect(drillGuardianInit(env(), d)).rejects.toThrow(/0600/);
    expect(d.broadcast).not.toHaveBeenCalled();
  });

  it("test_topsUpOnlyBelowTarget", async () => {
    await drillGuardianInit(env(), deps().d);
    const hi = deps({ drillBalance: 2_100_000n, status: registered });
    await drillGuardianInit(env(), hi.d);
    expect(hi.sent).toEqual([]);
    const lo = deps({ drillBalance: 300_000n, status: registered });
    const out = await drillGuardianInit(env(), lo.d);
    expect(lo.sent).toEqual([{ to: drill.cosmos, amount: "1700000" }]);
    expect(out.fundTx).toBe("TX1");
  });

  it("test_registersOnlyWhenUnregistered", async () => {
    const a = deps({ drillBalance: DRILL_GUARDIAN_TARGET_UQOR, status: registered });
    const outA = await drillGuardianInit(env(), a.d);
    expect(outA.registerTx).toBeUndefined();
    expect(a.calls).toEqual([]);
    rmSync(drillGuardianPath(home));
    const b = deps({ drillBalance: DRILL_GUARDIAN_TARGET_UQOR });
    const outB = await drillGuardianInit(env(), b.d);
    expect(b.calls).toEqual(["file:MsgRegisterPQCKeyV2:classical"]);
    expect(outB.registerTx).toBe("TX1");
  });

  it("refuses a registered key that differs from the derived one", async () => {
    const { d } = deps({ drillBalance: DRILL_GUARDIAN_TARGET_UQOR, status: () => ({ registered: true, possessionProven: true, pubkey: funder.pqc.publicKey }) });
    await expect(drillGuardianInit(env(), d)).rejects.toThrow(/differs/);
  });

  it("test_refusesWhenGuardianIsAnotherRoleAccount", async () => {
    for (const name of ["GAS_MNEMONIC", "OWNER_MNEMONIC", "FUNDER_MNEMONIC"]) {
      const { d } = deps();
      await expect(drillGuardianInit({ FUNDER_MNEMONIC, [name]: DRILL_MNEMONIC }, d)).rejects.toThrow(new RegExp(name));
      expect(d.broadcast).not.toHaveBeenCalled();
      expect(existsSync(drillGuardianPath(home))).toBe(false);
    }
  });

  it("test_refusesWhenFunderShort", async () => {
    const { d } = deps({ funderBalance: DRILL_GUARDIAN_TARGET_UQOR + FEE_RESERVE_UQOR - 1n });
    await expect(drillGuardianInit(env(), d)).rejects.toThrow(/funder has/);
    expect(d.broadcast).not.toHaveBeenCalled();
  });

  it("test_neverLogsMnemonic", async () => {
    const { d, lines } = deps();
    await drillGuardianInit(env(), d);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(DRILL_MNEMONIC);
    expect(lines.join("\n")).not.toContain("test test test");
  });
});

describe("runDrillGuardian", () => {
  it("refuses anything but init", async () => {
    await expect(runDrillGuardian(["bogus"])).rejects.toThrow("usage: drill-guardian init");
    await expect(runDrillGuardian([])).rejects.toThrow("usage: drill-guardian init");
    await expect(runDrillGuardian(["init", "x"])).rejects.toThrow("usage: drill-guardian init");
  });
});
