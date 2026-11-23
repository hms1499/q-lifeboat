import { loadAgentKey, RESCUE_SELECTOR } from "@qday/core";
import { deriveUnifiedAccount, type UnifiedAccount } from "@qorechain/sdk";
import type { Hex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkLinkTarget, parseLinkArgs, runLink, type LinkDeps } from "../src/link";
import { buildGuardianLinkMsgs, buildSetupRule } from "../src/setup";

const MNEMONIC = "test test test test test test test test test test test junk";
const OTHER_MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const VAULT = "0x00000000000000000000000000000000000000a1" as const;
const GUARDIAN = "0xFf82cAD6638a38d7009D0d5DfB757136B0C03850" as const;
const OTHER = "0x00000000000000000000000000000000000000cf" as const;
const SK = "07".repeat(32);
const NOW = 1_800_000_000;

describe("parseLinkArgs", () => {
  it("accepts no args or --expect 0x<40 hex>, nothing else", () => {
    expect(parseLinkArgs([])).toEqual({ expect: undefined });
    expect(parseLinkArgs(["--expect", OTHER])).toEqual({ expect: OTHER });
    expect(() => parseLinkArgs(["--expect"])).toThrow(/usage/);
    expect(() => parseLinkArgs(["--expect", "0x12"])).toThrow(/--expect needs/);
    expect(() => parseLinkArgs(["--expect", OTHER, "--expect", OTHER])).toThrow(/usage/);
    expect(() => parseLinkArgs(["--vault", OTHER])).toThrow(/usage/);
  });
});

describe("checkLinkTarget", () => {
  const signer = "0xAbC0000000000000000000000000000000000001";
  it("passes when owner() is the signer and guardian() matches or is not configured (any case)", () => {
    expect(() => checkLinkTarget({ owner: signer.toLowerCase(), guardian: GUARDIAN }, { owner: signer })).not.toThrow();
    expect(() => checkLinkTarget({ owner: signer, guardian: GUARDIAN }, { owner: signer, guardian: GUARDIAN.toLowerCase() })).not.toThrow();
  });
  it("refuses a vault whose owner() is another account, naming both", () => {
    expect(() => checkLinkTarget({ owner: OTHER, guardian: GUARDIAN }, { owner: signer })).toThrow(new RegExp(`${OTHER}.*${signer}`));
  });
  it("refuses a vault whose guardian() is not GUARDIAN_ADDRESS, naming both", () => {
    expect(() => checkLinkTarget({ owner: signer, guardian: OTHER }, { owner: signer, guardian: GUARDIAN })).toThrow(
      new RegExp(`${OTHER}.*${GUARDIAN}`),
    );
  });
});

describe("runLink", () => {
  let owner: UnifiedAccount;
  beforeEach(async () => {
    owner = await deriveUnifiedAccount(MNEMONIC);
  });
  const env = () => ({ OWNER_MNEMONIC: MNEMONIC, VAULT_ADDRESS: VAULT, AGENT_ED25519_SK: SK, GUARDIAN_ADDRESS: GUARDIAN });

  function deps(over: Partial<LinkDeps> = {}) {
    const lines: string[] = [];
    const d: LinkDeps = {
      getCode: vi.fn(async () => "0x6080" as Hex),
      readRoles: vi.fn(async () => ({ owner: owner.evm as Hex, guardian: GUARDIAN as Hex })),
      authenticators: vi.fn(async () => []),
      spendingRules: vi.fn(async () => ({
        rules: [
          {
            id: "guardian",
            enabled: true,
            perTxLimit: 1_000_000n,
            dailyLimit: 3_000_000n,
            denomLimits: [],
            allowedDenoms: ["uqor"],
            allowedEvmCalls: [`${VAULT}/${RESCUE_SELECTOR}`],
          },
        ],
        authenticatorRules: [],
      })),
      broadcast: vi.fn(async () => "HASH1"),
      nowUnix: () => NOW,
      log: (l) => void lines.push(l),
      ...over,
    };
    return { d, lines };
  }

  it("refuses --expect naming another owner before any chain read or broadcast", async () => {
    const { d } = deps();
    await expect(runLink(["--expect", OTHER], env(), d)).rejects.toThrow(/refusing to sign/);
    expect(d.getCode).not.toHaveBeenCalled();
    expect(d.readRoles).not.toHaveBeenCalled();
    expect(d.authenticators).not.toHaveBeenCalled();
    expect(d.broadcast).not.toHaveBeenCalled();
  });

  it("refuses a vault address with no code, without broadcasting", async () => {
    const { d } = deps({ getCode: vi.fn(async () => "0x" as Hex) });
    await expect(runLink([], env(), d)).rejects.toThrow(/no contract code/);
    expect(d.readRoles).not.toHaveBeenCalled();
    expect(d.broadcast).not.toHaveBeenCalled();
  });

  it("refuses when owner() is not the signer or guardian() is not GUARDIAN_ADDRESS, without broadcasting", async () => {
    const a = deps({ readRoles: vi.fn(async () => ({ owner: OTHER as Hex, guardian: GUARDIAN as Hex })) });
    await expect(runLink([], env(), a.d)).rejects.toThrow(/owner/);
    expect(a.d.broadcast).not.toHaveBeenCalled();
    const b = deps({ readRoles: vi.fn(async () => ({ owner: owner.evm as Hex, guardian: OTHER as Hex })) });
    await expect(runLink([], env(), b.d)).rejects.toThrow(/guardian/);
    expect(b.d.broadcast).not.toHaveBeenCalled();
  });

  it("does not need GUARDIAN_ADDRESS (a demo run.env has none)", async () => {
    const { d } = deps();
    const { GUARDIAN_ADDRESS: _g, ...noGuardian } = env();
    await runLink([], noGuardian, d);
    expect(d.broadcast).toHaveBeenCalledTimes(1);
  });

  it("broadcasts ONE hybrid tx of exactly the setup link messages (no window message) and prints the hash", async () => {
    const { d, lines } = deps();
    await runLink(["--expect", owner.evm], env(), d);
    expect(d.broadcast).toHaveBeenCalledTimes(1);
    const [acc, msgs, memo, mode] = vi.mocked(d.broadcast).mock.calls[0];
    expect(acc.cosmos).toBe(owner.cosmos);
    expect(memo).toBe("qday: link guardian");
    expect(mode ?? "hybrid").toBe("hybrid");
    const want = buildGuardianLinkMsgs(owner, VAULT, loadAgentKey({ AGENT_ED25519_SK: SK }), [], NOW);
    expect(msgs).toEqual(want);
    expect(msgs.some((m: { typeUrl: string }) => m.typeUrl.endsWith("MsgOpenEVMWindow"))).toBe(false);
    const rule = (msgs.find((m: { typeUrl: string }) => m.typeUrl.endsWith("MsgUpdateSpendingRules")).value as { rules: Record<string, unknown>[] }).rules[0];
    const expected = buildSetupRule(VAULT);
    expect(rule.allowedEvmCalls).toEqual(expected.allowedEvmCalls);
    expect(rule.allowedDenoms).toEqual(expected.allowedDenoms);
    expect(lines).toContain(`link (${msgs.length} msg): HASH1`);
  });

  it("sends only the rules update when the key is already linked", async () => {
    const pk = loadAgentKey({ AGENT_ED25519_SK: SK }).pk;
    const hex = Buffer.from(pk).toString("hex");
    const { d, lines } = deps({ authenticators: vi.fn(async () => [{ pubkeyHex: hex, revoked: false, expiryUnix: BigInt(NOW + 86_400) }] as never) });
    await runLink([], env(), d);
    const msgs = vi.mocked(d.broadcast).mock.calls[0][1];
    expect(msgs).toHaveLength(1);
    expect(lines).toContain("link (1 msg): HASH1");
  });

  it("prints the stored rule after the link, and a REST failure there is printed, not thrown", async () => {
    const ok = deps();
    await runLink([], env(), ok.d);
    expect(ok.lines.join("\n")).toContain(`${VAULT}/${RESCUE_SELECTOR}`);
    const bad = deps({ spendingRules: vi.fn(async () => { throw new Error("HTTP 500"); }) });
    await expect(runLink([], env(), bad.d)).resolves.toBeUndefined();
    expect(bad.lines.join("\n")).toMatch(/spending rule unavailable: HTTP 500/);
    expect(bad.lines).toContain("link (2 msg): HASH1");
  });

  it("never logs a secret", async () => {
    const { d, lines } = deps();
    await runLink([], { ...env(), OWNER_MNEMONIC: MNEMONIC }, d);
    expect(lines.join("\n")).not.toContain(MNEMONIC);
    expect(lines.join("\n")).not.toContain(SK);
    expect(lines.join("\n")).not.toContain(OTHER_MNEMONIC);
  });
});
