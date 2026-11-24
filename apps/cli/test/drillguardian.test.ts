import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { deriveUnifiedAccount, type PqcStatus, type UnifiedAccount } from "@qorechain/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRILL_GUARDIAN_FILE,
  DRILL_GUARDIAN_MIN_UQOR,
  DRILL_GUARDIAN_TARGET_UQOR,
  drillGuardianCheck,
  drillGuardianInit,
  drillGuardianPath,
  runDrillGuardian,
  type DrillGuardianDeps,
} from "../src/drillguardian";
import { FEE_RESERVE_UQOR } from "../src/fresh";

const DRILL_MNEMONIC = "test test test test test test test test test test test junk";
const FUNDER_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const OTHER_MNEMONIC = "legal winner thank year wave sausage worth useful legal winner thank yellow";

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

  it("test_refusesWithoutFunderMnemonic: never falls back to OWNER_MNEMONIC (the watched owner)", async () => {
    for (const e of [{ OWNER_MNEMONIC: OTHER_MNEMONIC }, { FUNDER_MNEMONIC: "  ", OWNER_MNEMONIC: OTHER_MNEMONIC }, {}]) {
      const { d } = deps();
      await expect(drillGuardianInit(e, d)).rejects.toThrow(/FUNDER_MNEMONIC is not set/);
      expect(d.broadcast).not.toHaveBeenCalled();
      expect(existsSync(drillGuardianPath(home))).toBe(false);
    }
  });

  it("test_refusesWhenFunderIsWatchedOwner: OWNER_EVM_ADDRESS (any case) or the OWNER_MNEMONIC account", async () => {
    for (const e of [
      { FUNDER_MNEMONIC, OWNER_EVM_ADDRESS: funder.evm.toUpperCase().replace("0X", "0x") },
      { FUNDER_MNEMONIC, OWNER_MNEMONIC: FUNDER_MNEMONIC },
    ]) {
      const { d } = deps();
      await expect(drillGuardianInit(e, d)).rejects.toThrow(/watched owner/);
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

describe("drillGuardianCheck", () => {
  let home: string;
  let drill: UnifiedAccount;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "qday-drillcheck-"));
    drill = await deriveUnifiedAccount(DRILL_MNEMONIC);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  function writeDrillFile(address: string = drill.evm, mode = 0o600) {
    const file = drillGuardianPath(home);
    mkdirSync(join(home, ".config", "qday"), { recursive: true, mode: 0o700 });
    writeFileSync(file, `DRILL_GAS_MNEMONIC="${DRILL_MNEMONIC}"\nDRILL_GUARDIAN_ADDRESS="${address}"\n`, { mode });
    chmodSync(file, mode);
  }
  function deps(balance: bigint) {
    const lines: string[] = [];
    return { lines, d: { home, log: (l: string) => void lines.push(l), uqorBalance: vi.fn(async () => balance) } };
  }
  const env = { FUNDER_MNEMONIC };

  it("is 0.5 QOR", () => {
    expect(DRILL_GUARDIAN_MIN_UQOR).toBe(500_000n);
  });

  it("test_checkPassesAtOrAboveMin: reads the drill guardian's balance, logs no secret", async () => {
    writeDrillFile();
    const { d, lines } = deps(DRILL_GUARDIAN_MIN_UQOR);
    const out = await drillGuardianCheck(env, d);
    expect(d.uqorBalance).toHaveBeenCalledWith(drill.cosmos);
    expect(out).toEqual({ address: drill.evm, cosmos: drill.cosmos, balance: DRILL_GUARDIAN_MIN_UQOR });
    expect(lines.join("\n")).toContain(drill.evm);
    expect(lines.join("\n")).toContain("0.5 QOR");
    expect(lines.join("\n")).not.toContain("test test");
  });

  it("test_checkFailsBelowMin with the init hint", async () => {
    writeDrillFile();
    const { d, lines } = deps(DRILL_GUARDIAN_MIN_UQOR - 1n);
    await expect(drillGuardianCheck(env, d)).rejects.toThrow(
      "drill guardian has 0.499999 QOR, needs at least 0.5 QOR: run pnpm cli drill-guardian init",
    );
    expect(lines.join("\n")).not.toContain("test test");
  });

  it("refuses a missing file, a loose file and a file whose address does not match", async () => {
    await expect(drillGuardianCheck(env, deps(DRILL_GUARDIAN_TARGET_UQOR).d)).rejects.toThrow(/no drill guardian file .*pnpm cli drill-guardian init/);
    writeDrillFile(drill.evm, 0o644);
    await expect(drillGuardianCheck(env, deps(DRILL_GUARDIAN_TARGET_UQOR).d)).rejects.toThrow(/0600/);
    writeDrillFile("0x00000000000000000000000000000000000000aa");
    const { d } = deps(DRILL_GUARDIAN_TARGET_UQOR);
    await expect(drillGuardianCheck(env, d)).rejects.toThrow(/does not match/);
    expect(d.uqorBalance).not.toHaveBeenCalled();
  });

  it("test_checkRefusesFunderProblems: no FUNDER_MNEMONIC, or the funder is the watched owner", async () => {
    writeDrillFile();
    const funder = await deriveUnifiedAccount(FUNDER_MNEMONIC);
    for (const [e, re] of [
      [{ OWNER_MNEMONIC: OTHER_MNEMONIC }, /FUNDER_MNEMONIC is not set/],
      [{ FUNDER_MNEMONIC, OWNER_EVM_ADDRESS: funder.evm.toLowerCase() }, /watched owner/],
      [{ FUNDER_MNEMONIC, OWNER_MNEMONIC: FUNDER_MNEMONIC }, /watched owner/],
    ] as const) {
      const { d } = deps(DRILL_GUARDIAN_TARGET_UQOR);
      await expect(drillGuardianCheck(e, d)).rejects.toThrow(re);
      expect(d.uqorBalance).not.toHaveBeenCalled();
    }
    // A different watched owner is fine.
    await expect(drillGuardianCheck({ FUNDER_MNEMONIC, OWNER_MNEMONIC: OTHER_MNEMONIC }, deps(DRILL_GUARDIAN_TARGET_UQOR).d)).resolves.toBeDefined();
  });
});

describe("runDrillGuardian", () => {
  it("refuses anything but init or check", async () => {
    await expect(runDrillGuardian(["bogus"])).rejects.toThrow("usage: drill-guardian init|check");
    await expect(runDrillGuardian([])).rejects.toThrow("usage: drill-guardian init|check");
    await expect(runDrillGuardian(["init", "x"])).rejects.toThrow("usage: drill-guardian init|check");
    await expect(runDrillGuardian(["check", "x"])).rejects.toThrow("usage: drill-guardian init|check");
  });
});
