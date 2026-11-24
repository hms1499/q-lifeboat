import { loadAgentKey } from "@qday/core";
import { deriveUnifiedAccount, type UnifiedAccount } from "@qorechain/sdk";
import { toHex } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildUnlinkMsg, parseUnlinkArgs, runUnlink, type UnlinkDeps } from "../src/unlink";

const MNEMONIC = "test test test test test test test test test test test junk";
const OTHER = "0x00000000000000000000000000000000000000cf" as const;
const SK = "07".repeat(32);
const NOW = 1_800_000_000;

const agentPkHex = () => toHex(loadAgentKey({ AGENT_ED25519_SK: SK }).pk).slice(2);
const view = (over: Partial<{ pubkeyHex: string; revoked: boolean; expiryUnix: bigint; scheme: string }> = {}) => ({
  scheme: "ed25519",
  pubkeyHex: agentPkHex(),
  permissions: ["evm"],
  expiryUnix: BigInt(NOW + 3600),
  label: "qday-guardian agent",
  createdAtUnix: BigInt(NOW - 3600),
  revoked: false,
  hasSpendRule: false,
  ...over,
});

describe("parseUnlinkArgs", () => {
  it("accepts no args or --expect 0x<40 hex>, nothing else", () => {
    expect(parseUnlinkArgs([])).toEqual({ expect: undefined });
    expect(parseUnlinkArgs(["--expect", OTHER])).toEqual({ expect: OTHER });
    expect(() => parseUnlinkArgs(["--expect"])).toThrow(/usage/);
    expect(() => parseUnlinkArgs(["--expect", "0x12"])).toThrow(/--expect needs/);
    expect(() => parseUnlinkArgs(["--expect", OTHER, "--expect", OTHER])).toThrow(/usage/);
    expect(() => parseUnlinkArgs(["now"])).toThrow(/usage/);
  });
});

describe("buildUnlinkMsg", () => {
  let owner: UnifiedAccount;
  beforeEach(async () => {
    owner = await deriveUnifiedAccount(MNEMONIC);
  });

  it("revokes exactly the Guardian's ed25519 key on the owner's account", () => {
    const agent = loadAgentKey({ AGENT_ED25519_SK: SK });
    const msg = buildUnlinkMsg(owner, agent, [view()]);
    expect(msg.typeUrl).toMatch(/MsgRevokeAuthenticator$/);
    const v = msg.value as { owner: string; accountAddress: string; scheme: string; pubkey: Uint8Array };
    expect(v.owner).toBe(owner.cosmos);
    expect(v.accountAddress).toBe(owner.cosmos);
    expect(v.scheme).toBe("ed25519");
    expect(toHex(v.pubkey)).toBe(toHex(agent.pk));
  });

  it("matches the linked key whatever the case or 0x prefix of pubkey_hex", () => {
    const agent = loadAgentKey({ AGENT_ED25519_SK: SK });
    expect(() => buildUnlinkMsg(owner, agent, [view({ pubkeyHex: `0x${agentPkHex().toUpperCase()}` })])).not.toThrow();
  });

  it("revokes an expired (not yet revoked) key: it would be live again after a re-link", () => {
    const agent = loadAgentKey({ AGENT_ED25519_SK: SK });
    expect(() => buildUnlinkMsg(owner, agent, [view({ expiryUnix: BigInt(NOW - 10) })])).not.toThrow();
  });

  it("sends when one entry for the key is revoked and another is live (an old link, then a re-link)", () => {
    const agent = loadAgentKey({ AGENT_ED25519_SK: SK });
    expect(() => buildUnlinkMsg(owner, agent, [view({ revoked: true }), view()])).not.toThrow();
  });

  it("refuses when the Guardian's key is not linked, or only revoked entries remain", () => {
    const agent = loadAgentKey({ AGENT_ED25519_SK: SK });
    expect(() => buildUnlinkMsg(owner, agent, [])).toThrow(/not linked/);
    expect(() => buildUnlinkMsg(owner, agent, [view({ pubkeyHex: "ab".repeat(32) })])).toThrow(/not linked/);
    expect(() => buildUnlinkMsg(owner, agent, [view({ revoked: true })])).toThrow(/already revoked/);
  });
});

describe("runUnlink", () => {
  let owner: UnifiedAccount;
  beforeEach(async () => {
    owner = await deriveUnifiedAccount(MNEMONIC);
  });
  const env = () => ({ OWNER_MNEMONIC: MNEMONIC, AGENT_ED25519_SK: SK });

  function deps(over: Partial<UnlinkDeps> = {}) {
    const lines: string[] = [];
    const d: UnlinkDeps = {
      authenticators: vi.fn(async () => [view()]),
      broadcast: vi.fn(async () => "HASH1"),
      log: (l) => void lines.push(l),
      ...over,
    };
    return { d, lines };
  }

  it("refuses --expect naming another owner before any chain read or broadcast", async () => {
    const { d } = deps();
    await expect(runUnlink(["--expect", OTHER], env(), d)).rejects.toThrow(/refusing to sign/);
    expect(d.authenticators).not.toHaveBeenCalled();
    expect(d.broadcast).not.toHaveBeenCalled();
  });

  it("sends one hybrid tx with the revoke message and logs its hash", async () => {
    const { d, lines } = deps();
    await runUnlink(["--expect", owner.evm], env(), d);
    expect(d.authenticators).toHaveBeenCalledWith(owner.cosmos);
    expect(d.broadcast).toHaveBeenCalledTimes(1);
    const [acc, msgs, memo] = (d.broadcast as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((acc as UnifiedAccount).evm).toBe(owner.evm);
    expect(msgs).toHaveLength(1);
    expect((msgs as { typeUrl: string }[])[0]!.typeUrl).toMatch(/MsgRevokeAuthenticator$/);
    expect(memo).toMatch(/unlink/);
    expect(lines.join("\n")).toMatch(/HASH1/);
  });

  it("reads the key back after the tx and logs whether it is revoked; a failed read-back is not an error", async () => {
    const reads = [[view()], [view({ revoked: true })]];
    const { d, lines } = deps({ authenticators: vi.fn(async () => reads.shift()!) });
    await runUnlink([], env(), d);
    expect(d.authenticators).toHaveBeenCalledTimes(2);
    expect(lines.join("\n")).toMatch(/revoked: true/);

    const once = [[view()]];
    const failing = deps({
      authenticators: vi.fn(async () => {
        const next = once.shift();
        if (!next) throw new Error("REST down");
        return next;
      }),
    });
    await expect(runUnlink([], env(), failing.d)).resolves.toBeUndefined();
    expect(failing.lines.join("\n")).toMatch(/read-back unavailable: REST down/);
  });

  it("broadcasts nothing when the key is not linked", async () => {
    const { d } = deps({ authenticators: vi.fn(async () => []) });
    await expect(runUnlink([], env(), d)).rejects.toThrow(/not linked/);
    expect(d.broadcast).not.toHaveBeenCalled();
  });

  it("needs AGENT_ED25519_SK (the key to revoke)", async () => {
    const { d } = deps();
    await expect(runUnlink([], { OWNER_MNEMONIC: MNEMONIC }, d)).rejects.toThrow(/AGENT_ED25519_SK/);
    expect(d.broadcast).not.toHaveBeenCalled();
  });
});
