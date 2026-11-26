import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { signAuthenticatorLinkEd25519, toHex, type UnifiedAccount } from "@qorechain/sdk";
import { describe, expect, it } from "vitest";
import { loadAgentKey } from "../src/accounts";
import { RESCUE_SELECTOR } from "../src/abi";
import { NETWORK } from "../src/config";
import {
  AGENT_TTL_SECONDS,
  buildGuardianLinkMsgs,
  buildGuardianLinkMsgsFromProof,
  buildOnboardWindowParams,
  buildOwnerWindowParams,
  buildSetupRule,
  buildUnlinkMsg,
  decodeLinkProof,
  encodeLinkProof,
  newAgentKeyHex,
  ruleIsExact,
  selectLinkMsgs,
} from "../src/msgs";

const VAULT = "0x17d867860a0A0Ff528dF655439ff59176b061B3C";
const NOW = 1_800_000_000;
const owner = { cosmos: "qor1owner" } as UnifiedAccount;
const agent = loadAgentKey({ AGENT_ED25519_SK: "07".repeat(32) });

describe("buildGuardianLinkMsgsFromProof", () => {
  const proof = {
    ...signAuthenticatorLinkEd25519({ chainId: NETWORK.chainId, account: owner.cosmos, privateKey: agent.sk }),
    agentPubKeyHex: toHex(agent.pk),
  };

  it("equals buildGuardianLinkMsgs for the same key and nowUnix", () => {
    expect(buildGuardianLinkMsgsFromProof(owner, VAULT, proof, [], NOW)).toEqual(buildGuardianLinkMsgs(owner, VAULT, agent, [], NOW));
  });

  it("sends only the rules update when the key is already linked and live", () => {
    const live = [{ pubkeyHex: toHex(agent.pk), revoked: false, expiryUnix: BigInt(NOW + AGENT_TTL_SECONDS) }];
    const msgs = buildGuardianLinkMsgsFromProof(owner, VAULT, proof, live, NOW);
    expect(msgs.map((m) => m.typeUrl)).toEqual([expect.stringMatching(/MsgUpdateSpendingRules$/)]);
  });
});

describe("link proof JSON", () => {
  const proof = {
    ...signAuthenticatorLinkEd25519({ chainId: NETWORK.chainId, account: owner.cosmos, privateKey: agent.sk }),
    agentPubKeyHex: toHex(agent.pk),
  };

  it("round-trips through JSON as 0x hex and builds the same link messages", () => {
    const wire = JSON.parse(JSON.stringify(encodeLinkProof(proof)));
    expect(wire.pubkey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(wire.possessionProof).toMatch(/^0x[0-9a-f]{128}$/);
    const back = decodeLinkProof(wire);
    expect(back).toEqual(proof);
    expect(buildGuardianLinkMsgsFromProof(owner, VAULT, back, [], NOW)).toEqual(buildGuardianLinkMsgsFromProof(owner, VAULT, proof, [], NOW));
  });
});

describe("moved builders", () => {
  it("AGENT_TTL_SECONDS is 30 days", () => expect(AGENT_TTL_SECONDS).toBe(30 * 24 * 3600));

  it("buildSetupRule is exactly vault.rescue + uqor", () => {
    const rule = buildSetupRule(VAULT);
    expect(rule.allowedEvmCalls).toEqual([`${VAULT.toLowerCase()}/${RESCUE_SELECTOR}`]);
    expect(rule.allowedDenoms).toEqual(["uqor"]);
  });

  it("ruleIsExact accepts the setup rule and rejects extras", () => {
    const rule = { ...buildSetupRule(VAULT), denomLimits: [] };
    expect(ruleIsExact({ rules: [rule] } as never, VAULT)).toBe(true);
    expect(ruleIsExact({ rules: [{ ...rule, allowedDenoms: ["uqor", "erc20/0x1"] }] } as never, VAULT)).toBe(false);
    expect(ruleIsExact({ rules: [{ ...rule, enabled: false }] } as never, VAULT)).toBe(false);
  });

  it("selectLinkMsgs passes everything for an unlinked key", () => {
    const all = [{ typeUrl: "a.MsgUpdateSpendingRules" }, { typeUrl: "b.Reg" }];
    expect(selectLinkMsgs(all, [], agent.pk, NOW)).toEqual(all);
  });

  it("buildUnlinkMsg refuses an unlinked key", () => {
    expect(() => buildUnlinkMsg(owner, agent, [])).toThrow(/not linked/);
  });

  it("window params: owner window is scoped, onboard window has no allowedTargets", () => {
    const tokens = { fUSD: "0x01", fETH: "0x02", fBTC: "0x03" };
    const scoped = buildOwnerWindowParams("qor1o", tokens, "0x04", "0x05", { blocks: 10, txs: 2, topupUqor: 7n });
    expect(scoped.allowedTargets).toHaveLength(5);
    const open = buildOnboardWindowParams("qor1o", { blocks: 10, txs: 2, topupUqor: 7n });
    expect("allowedTargets" in open).toBe(false);
    expect(open.maxValue).toBe(scoped.maxValue);
  });

  it("newAgentKeyHex is 64 hex chars without 0x and differs per call", () => {
    const a = newAgentKeyHex();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(newAgentKeyHex()).not.toBe(a);
  });
});

describe("browser safety", () => {
  it.each(["msgs.ts", "withdrawal.ts"])("%s imports nothing from node:*", (file) => {
    const src = readFileSync(resolve(__dirname, "../src", file), "utf8");
    expect(src).not.toMatch(/from\s+["']node:/);
  });
});
