import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evmWindowCost } from "@qorechain/evm";
import {
  deriveUnifiedAccount,
  MSG_SEND_TYPE_URL,
  openEvmWindowMsg,
  verifyProofOfPossession,
  type PqcStatus,
  type UnifiedAccount,
} from "@qorechain/sdk";
import type { Hex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDeployWindowParams,
  buildFundMsg,
  buildRegisterMsg,
  checkFunderBalance,
  checkVaultRoles,
  DEPLOY_GAS,
  FEE_RESERVE_UQOR,
  freshOwner,
  FRESH_MAX_FEE_PER_GAS,
  loadVaultArtifact,
  MINT_AMOUNT,
  MINT_GAS,
  parseFundUqor,
  type FreshDeps,
  newAgentKeyHex,
} from "../src/fresh";
import { loadAgentKey } from "@qday/core";

const MNEMONIC = "test test test test test test test test test test test junk";
const FUNDER_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const GUARDIAN = "0xFf82cAD6638a38d7009D0d5DfB757136B0C03850" as const;
const FUSD = "0x8478737e5ac2c2cbf70aad17f459d1b8ab8a7a14" as const;
const VAULT = "0x00000000000000000000000000000000000000a1" as const;
const ATTACKER = "0x00000000000000000000000000000000000000ba" as const;
const SAFE = "0x00000000000000000000000000000000000000cf" as const;
/** The per-run agent ed25519 secret key the mocked generator hands out (an authenticator key binds to ONE account). */
const AGENT_SK = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";

describe("parseFundUqor", () => {
  it("defaults to 1.5 QOR and reads FRESH_FUND_UQOR", () => {
    expect(parseFundUqor({})).toBe(1_500_000n);
    expect(parseFundUqor({ FRESH_FUND_UQOR: " 2000000 " })).toBe(2_000_000n);
  });
  it("refuses non-integers and zero", () => {
    expect(() => parseFundUqor({ FRESH_FUND_UQOR: "1.5" })).toThrow(/FRESH_FUND_UQOR/);
    expect(() => parseFundUqor({ FRESH_FUND_UQOR: "0" })).toThrow(/FRESH_FUND_UQOR/);
  });
});

describe("checkFunderBalance", () => {
  it("needs the amount plus a 0.5 QOR fee reserve", () => {
    expect(FEE_RESERVE_UQOR).toBe(500_000n);
    expect(() => checkFunderBalance(2_000_000n, 1_500_000n)).not.toThrow();
    expect(() => checkFunderBalance(1_999_999n, 1_500_000n)).toThrow(/1\.999999 QOR.*2 QOR/);
  });
});

describe("buildFundMsg", () => {
  it("is a bank MsgSend of uqor", () => {
    const m = buildFundMsg("qor1from", "qor1to", 1_500_000n);
    expect(m.typeUrl).toBe(MSG_SEND_TYPE_URL);
    expect(m.value).toEqual({ fromAddress: "qor1from", toAddress: "qor1to", amount: [{ denom: "uqor", amount: "1500000" }] });
  });
});

describe("buildRegisterMsg", () => {
  it("registers the ML-DSA key the Guardian Signer derives from the mnemonic, with a valid proof of possession", async () => {
    // signer.ts signs with loadOwner(env).pqc, i.e. deriveUnifiedAccount(OWNER_MNEMONIC).pqc.
    const acc = await deriveUnifiedAccount(MNEMONIC);
    const signerKey = (await deriveUnifiedAccount(MNEMONIC)).pqc.publicKey;
    const m = buildRegisterMsg(acc, "qorechain-diana");
    expect(m.typeUrl).toBe("/qorechain.pqc.v1.MsgRegisterPQCKeyV2");
    const v = m.value as { sender: string; publicKey: Uint8Array; algorithmId: number; proofOfPossession: Uint8Array };
    expect(v.sender).toBe(acc.cosmos);
    expect(v.algorithmId).toBe(1);
    expect(Buffer.from(v.publicKey).equals(Buffer.from(signerKey))).toBe(true);
    expect(
      verifyProofOfPossession({ chainId: "qorechain-diana", account: acc.cosmos, publicKey: v.publicKey, proof: v.proofOfPossession }),
    ).toBe(true);
  });
});

describe("buildDeployWindowParams", () => {
  const p = buildDeployWindowParams("qor1fresh");

  it("is UNSCOPED (a window with targets refuses contract creation), 600 blocks, 3 txs", () => {
    expect(p.sender).toBe("qor1fresh");
    expect(p.blocks).toBe(600);
    expect(p.maxTxs).toBe(3);
    expect("allowedTargets" in p).toBe(false);
    const msg = openEvmWindowMsg(p);
    expect((msg.value as { allowedTargets: string[] }).allowedTargets).toEqual([]);
  });

  it("budgets exactly the deploy and the mint at the fee cap they are sent with", () => {
    expect(DEPLOY_GAS).toBe(950_000n);
    const want =
      evmWindowCost({ gas: DEPLOY_GAS, maxFeePerGas: FRESH_MAX_FEE_PER_GAS }) + evmWindowCost({ gas: MINT_GAS, maxFeePerGas: FRESH_MAX_FEE_PER_GAS });
    expect(p.maxValue).toBe(want.toString());
  });
});

describe("checkVaultRoles", () => {
  it("accepts the expected owner and guardian in any case", () => {
    expect(() => checkVaultRoles({ owner: "0xAbC0000000000000000000000000000000000001", guardian: GUARDIAN }, { owner: "0xabc0000000000000000000000000000000000001", guardian: GUARDIAN.toLowerCase() as Hex })).not.toThrow();
  });
  it("refuses a mismatch", () => {
    expect(() => checkVaultRoles({ owner: VAULT, guardian: GUARDIAN }, { owner: SAFE, guardian: GUARDIAN })).toThrow(/owner/);
    expect(() => checkVaultRoles({ owner: SAFE, guardian: VAULT }, { owner: SAFE, guardian: GUARDIAN })).toThrow(/guardian/);
  });
});

describe("loadVaultArtifact", () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), "qday-art-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads abi + creation bytecode of a (owner, guardian) constructor", () => {
    const f = join(dir, "GuardianVault.json");
    const abi = [{ type: "constructor", inputs: [{ name: "owner_", type: "address" }, { name: "guardian_", type: "address" }] }];
    writeFileSync(f, JSON.stringify({ abi, bytecode: { object: "0x6080" } }));
    expect(loadVaultArtifact(f)).toEqual({ abi, bytecode: "0x6080" });
  });

  it("explains how to build a missing artifact, and refuses a wrong constructor", () => {
    expect(() => loadVaultArtifact(join(dir, "nope.json"))).toThrow(/forge build/);
    const f = join(dir, "Old.json");
    writeFileSync(f, JSON.stringify({ abi: [{ type: "constructor", inputs: [{ name: "owner_", type: "address" }] }], bytecode: { object: "0x6080" } }));
    expect(() => loadVaultArtifact(f)).toThrow(/constructor/);
  });
});

describe("freshOwner", () => {
  let home: string;
  let funder: UnifiedAccount;
  let fresh: UnifiedAccount;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "qday-home-"));
    funder = await deriveUnifiedAccount(FUNDER_MNEMONIC);
    fresh = await deriveUnifiedAccount(MNEMONIC);
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const env = { FUNDER_MNEMONIC, GUARDIAN_ADDRESS: GUARDIAN, FUSD_ADDRESS: FUSD };
  const proven = (): PqcStatus => ({ registered: true, possessionProven: true, pubkey: fresh.pqc.publicKey });

  function deps(over: Partial<FreshDeps> = {}) {
    const calls: string[] = [];
    const lines: string[] = [];
    let nonce = 0;
    const d: FreshDeps = {
      home,
      now: () => new Date("2026-11-20T08:05:09Z"),
      newMnemonic: () => MNEMONIC,
      newAgentKey: () => AGENT_SK,
      randomAddress: vi.fn().mockReturnValueOnce(ATTACKER).mockReturnValueOnce(SAFE),
      log: (l) => void lines.push(l),
      sleep: async () => {},
      uqorBalance: vi.fn(async (who: string) => (who === funder.cosmos ? 10_000_000n : 1_500_000n)),
      broadcast: vi.fn(async (acc: UnifiedAccount, msgs: { typeUrl: string }[], _memo: string, mode: "hybrid" | "classical") => {
        calls.push(`${acc.cosmos === funder.cosmos ? "funder" : "fresh"}:${msgs.map((m) => m.typeUrl.split(".").pop()).join("+")}:${mode}`);
        nonce += 1;
        return `TX${calls.length}`;
      }),
      pqcStatus: vi.fn(async () => proven()),
      windowLive: vi.fn(async () => true),
      evmNonce: vi.fn(async () => nonce),
      deployVault: vi.fn(async (_acc: UnifiedAccount, owner: Hex, guardian: Hex) => {
        calls.push(`deploy:${owner}:${guardian}`);
        return { hash: "0xdeploy" as Hex, address: VAULT };
      }),
      readRoles: vi.fn(async () => ({ owner: fresh.evm as Hex, guardian: GUARDIAN as Hex })),
      mint: vi.fn(async (_acc: UnifiedAccount, token: Hex, to: Hex, amount: bigint) => {
        calls.push(`mint:${token}:${to}:${amount}`);
        return "0xmint" as Hex;
      }),
      ...over,
    };
    return { d, calls, lines };
  }

  it("funds, registers (own classical tx), opens an unscoped window, deploys, checks roles, mints, then completes run.env", async () => {
    const { d, calls, lines } = deps();
    const out = await freshOwner(env, d);
    expect(calls).toEqual([
      "funder:MsgSend:hybrid",
      "fresh:MsgRegisterPQCKeyV2:classical",
      "fresh:MsgOpenEVMWindow:hybrid",
      `deploy:${fresh.evm}:${GUARDIAN}`,
      `mint:${FUSD}:${fresh.evm}:${MINT_AMOUNT}`,
    ]);
    expect(MINT_AMOUNT).toBe(100n * 10n ** 18n);
    expect(out.runEnv).toBe(join(home, ".config/qday/runs/20261120T080509Z/run.env"));
    const text = readFileSync(out.runEnv, "utf8");
    expect(text).toBe(
      [
        'RUN_ID="20261120T080509Z"',
        `OWNER_MNEMONIC="${MNEMONIC}"`,
        `OWNER_EVM_ADDRESS="${fresh.evm}"`,
        `AGENT_ED25519_SK="${AGENT_SK}"`,
        `VAULT_ADDRESS="${VAULT}"`,
        `ATTACKER_ADDR="${ATTACKER}"`,
        `SAFE_ADDR="${SAFE}"`,
        'RUN_COMPLETE="1"',
        "",
      ].join("\n"),
    );
    expect(statSync(out.runEnv).mode & 0o777).toBe(0o600);
    expect(lines.join("\n")).not.toContain(MNEMONIC);
    expect(lines.join("\n")).not.toContain(fresh.privateKey.slice(2));
    expect(lines.join("\n")).not.toContain(AGENT_SK); // the per-run agent key is never logged
    expect(lines).toContain(`RUN_ENV=${out.runEnv}`);
    expect(lines.some((l) => l.includes("TX1"))).toBe(true); // each step logs its tx hash
  });

  describe("noVault (onboarded from the dashboard's Protect screen)", () => {
    const envNoGuardian = { FUNDER_MNEMONIC, FUSD_ADDRESS: FUSD };

    it("funds, registers, opens the deploy window and mints, never deploys or reads roles, needs no GUARDIAN_ADDRESS", async () => {
      const { d, calls } = deps();
      await freshOwner(envNoGuardian, d, { noVault: true });
      expect(calls).toEqual([
        "funder:MsgSend:hybrid",
        "fresh:MsgRegisterPQCKeyV2:classical",
        "fresh:MsgOpenEVMWindow:hybrid",
        `mint:${FUSD}:${fresh.evm}:${MINT_AMOUNT}`,
      ]);
      expect(d.deployVault).not.toHaveBeenCalled();
      expect(d.readRoles).not.toHaveBeenCalled();
    });

    it("writes a complete run.env WITHOUT VAULT_ADDRESS, prints RUN_ENV= and the Protect next step, never the mnemonic", async () => {
      const { d, lines } = deps();
      const out = await freshOwner(envNoGuardian, d, { noVault: true });
      expect(readFileSync(out.runEnv, "utf8")).toBe(
        [
          'RUN_ID="20261120T080509Z"',
          `OWNER_MNEMONIC="${MNEMONIC}"`,
          `OWNER_EVM_ADDRESS="${fresh.evm}"`,
          `AGENT_ED25519_SK="${AGENT_SK}"`,
          `ATTACKER_ADDR="${ATTACKER}"`,
          `SAFE_ADDR="${SAFE}"`,
          'RUN_COMPLETE="1"',
          "",
        ].join("\n"),
      );
      expect(out.vault).toBeUndefined();
      expect(lines).toContain(`RUN_ENV=${out.runEnv}`);
      const next = lines.find((l) => l.includes("http://127.0.0.1:5173/#/protect"));
      expect(next).toBeDefined();
      expect(next).toContain("OWNER_MNEMONIC");
      expect(next).toContain(out.runEnv);
      const all = lines.join("\n");
      expect(all).toMatch(/unscoped deploy window stays open \(~14 min, 600 blocks\).*pnpm cli window close/);
      expect(all).toMatch(/pnpm agent` can run with the root \.env now.*guardian address/);
      expect(all).toMatch(/pnpm cli link.*pnpm agent.*run\.env loaded.*VAULT_ADDRESS=<vault> exported/);
      expect(all).not.toContain(MNEMONIC);
    });

    it("without noVault, GUARDIAN_ADDRESS is still required and the vault is deployed", async () => {
      const { d } = deps();
      await expect(freshOwner(envNoGuardian, d)).rejects.toThrow(/GUARDIAN_ADDRESS/);
      expect(d.deployVault).not.toHaveBeenCalled();
    });
  });

  it("writes a valid per-run agent key that differs between two runs (the real generator) and never logs it", async () => {
    const keys: string[] = [];
    const logged: string[] = [];
    for (const minute of ["05", "06"]) {
      const { d, lines } = deps({ newAgentKey: newAgentKeyHex, now: () => new Date(`2026-11-20T08:${minute}:09Z`) });
      d.randomAddress = vi.fn().mockReturnValueOnce(ATTACKER).mockReturnValueOnce(SAFE);
      const out = await freshOwner(env, d);
      const sk = /^AGENT_ED25519_SK="([0-9a-f]+)"$/m.exec(readFileSync(out.runEnv, "utf8"))?.[1];
      expect(sk).toBeDefined();
      expect(() => loadAgentKey({ AGENT_ED25519_SK: sk })).not.toThrow(); // the format setup, agent and (b) read
      keys.push(sk!);
      logged.push(...lines);
    }
    expect(keys[0]).not.toBe(keys[1]);
    for (const k of keys) expect(logged.join("\n")).not.toContain(k);
  });

  it("newAgentKeyHex gives 32 random bytes as 64 lowercase hex characters", () => {
    const a = newAgentKeyHex();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(newAgentKeyHex()).not.toBe(a);
  });

  it("refuses before broadcasting when the funder cannot cover the amount plus fees", async () => {
    const { d } = deps({ uqorBalance: vi.fn(async () => 1_000_000n) });
    await expect(freshOwner(env, d)).rejects.toThrow(/funder/i);
    expect(d.broadcast).not.toHaveBeenCalled();
  });

  it("never overwrites an existing run.env (same-second run id) and funds nothing", async () => {
    const { d } = deps();
    const dir = join(home, ".config/qday/runs/20261120T080509Z");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "run.env"), 'OWNER_MNEMONIC="funded earlier"\n');
    await expect(freshOwner(env, d)).rejects.toThrow(/EEXIST/);
    expect(d.broadcast).not.toHaveBeenCalled();
    expect(readFileSync(join(dir, "run.env"), "utf8")).toBe('OWNER_MNEMONIC="funded earlier"\n');
  });

  it("defaults the funder to OWNER_MNEMONIC", async () => {
    const { d, calls } = deps();
    await freshOwner({ OWNER_MNEMONIC: FUNDER_MNEMONIC, GUARDIAN_ADDRESS: GUARDIAN, FUSD_ADDRESS: FUSD }, d);
    expect(calls[0]).toBe("funder:MsgSend:hybrid");
  });

  it("requires GUARDIAN_ADDRESS", async () => {
    const { d } = deps();
    await expect(freshOwner({ FUNDER_MNEMONIC, FUSD_ADDRESS: FUSD }, d)).rejects.toThrow(/GUARDIAN_ADDRESS/);
  });

  it("fails loudly with the chain's message when the registration is refused, and stops", async () => {
    const { d } = deps();
    vi.mocked(d.broadcast).mockImplementation(async (_a, msgs) => {
      if (msgs[0].typeUrl.endsWith("MsgRegisterPQCKeyV2")) throw new Error("tx ABC refused, code 4: account not found");
      return "TX";
    });
    await expect(freshOwner(env, d)).rejects.toThrow(/register.*ML-DSA.*account not found/);
    expect(d.deployVault).not.toHaveBeenCalled();
  });

  it("refuses to continue when the registered key has no proof of possession (the signer would refuse)", async () => {
    const { d } = deps({ pqcStatus: vi.fn(async () => ({ ...proven(), possessionProven: false })) });
    await expect(freshOwner(env, d)).rejects.toThrow(/possession/);
    expect(d.deployVault).not.toHaveBeenCalled();
  });

  it("refuses to continue when the chain holds another key than the one the signer derives", async () => {
    const { d } = deps({ pqcStatus: vi.fn(async () => ({ ...proven(), pubkey: funder.pqc.publicKey })) });
    await expect(freshOwner(env, d)).rejects.toThrow(/differs/);
    expect(d.deployVault).not.toHaveBeenCalled();
  });

  const RUN_ENV = () => join(home, ".config/qday/runs/20261120T080509Z/run.env");
  const INCOMPLETE = () =>
    [
      'RUN_ID="20261120T080509Z"',
      `OWNER_MNEMONIC="${MNEMONIC}"`,
      `OWNER_EVM_ADDRESS="${fresh.evm}"`,
      `AGENT_ED25519_SK="${AGENT_SK}"`,
      'RUN_COMPLETE="0"',
      "",
    ].join("\n");

  it("refuses to continue (no mint) when the deployed vault's roles do not match, leaving run.env incomplete with the key", async () => {
    const { d, lines } = deps({ readRoles: vi.fn(async () => ({ owner: fresh.evm as Hex, guardian: SAFE as Hex })) });
    await expect(freshOwner(env, d)).rejects.toThrow(/guardian/);
    expect(d.mint).not.toHaveBeenCalled();
    expect(readFileSync(RUN_ENV(), "utf8")).toBe(INCOMPLETE()); // RUN_COMPLETE=0, mnemonic kept to recover the QOR
    expect(statSync(RUN_ENV()).mode & 0o777).toBe(0o600);
    expect(lines.some((l) => l.startsWith("RUN_ENV="))).toBe(false); // demo.sh only picks up a complete run
    expect(lines.join("\n")).toContain(`incomplete run: ${join(home, ".config/qday/runs/20261120T080509Z")}`);
    expect(lines.join("\n")).not.toContain(MNEMONIC);
  });

  it("writes run.env (0600, dir 0700, RUN_COMPLETE=0, mnemonic present) BEFORE the fund tx", async () => {
    const seen: { text: string; mode: number; dirMode: number }[] = [];
    const { d } = deps();
    const inner = d.broadcast;
    d.broadcast = vi.fn(async (...a: Parameters<FreshDeps["broadcast"]>) => {
      if (a[1][0].typeUrl === MSG_SEND_TYPE_URL) {
        seen.push({
          text: readFileSync(RUN_ENV(), "utf8"),
          mode: statSync(RUN_ENV()).mode & 0o777,
          dirMode: statSync(join(home, ".config/qday/runs/20261120T080509Z")).mode & 0o777,
        });
      }
      return inner(...a);
    });
    await freshOwner(env, d);
    expect(seen).toEqual([{ text: INCOMPLETE(), mode: 0o600, dirMode: 0o700 }]);
  });

  it("does not write anything when it refuses before the fund tx (funder too poor)", async () => {
    const { d } = deps({ uqorBalance: vi.fn(async () => 1_000_000n) });
    await expect(freshOwner(env, d)).rejects.toThrow(/funder/i);
    expect(() => statSync(RUN_ENV())).toThrow();
  });
});
