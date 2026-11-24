import { signIncident, verifyIncident, incidentSigningBytes, type IncidentBody } from "@qday/core";
import { verifyMessage } from "@qorechain/qoresign";
import { deriveUnifiedAccount } from "@qorechain/sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { guardianCoSigner, CHAIN_ID } from "../src/cosign";
import { signAndRecord, type Facts } from "../src/report";

const MNEMONIC = "test test test test test test test test test test test junk";
const SK = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const body: IncidentBody = {
  id: "inc-1",
  detectedAt: "2026-11-25T10:00:00.000Z",
  trigger: { kind: "approval", hash: `0x${"ab".repeat(32)}`, block: 7n, token: `0x${"a1".repeat(20)}`, to: `0x${"55".repeat(20)}`, amount: 1n },
  reason: "approval to an untrusted spender",
  rescues: [],
  summary: "s",
  summarySource: "template",
};

describe("guardianCoSigner (QoreSign, submission gap 3)", () => {
  it("signs as the guardian's qor1 with eth_secp256k1 + ML-DSA-87; QoreSign verifies it against the guardian's PQ key", async () => {
    const g = await deriveUnifiedAccount(MNEMONIC);
    const signed = signIncident(body, SK, guardianCoSigner(g));
    expect(signed.guardian).toBe(g.cosmos);
    expect(signed.guardianSig?.signatureType).toBe("ml-dsa-87-hybrid");
    expect(signed.guardianSig?.classical.keyType).toBe("eth_secp256k1");
    expect(verifyIncident(signed)).toBe(true);
    expect(() =>
      verifyMessage({ chainId: CHAIN_ID, signer: g.cosmos, data: incidentSigningBytes(signed), signature: signed.guardianSig as never, pqPublicKey: g.pqc.publicKey }),
    ).not.toThrow();
  });

  it("the signature does not verify over a changed report", async () => {
    const g = await deriveUnifiedAccount(MNEMONIC);
    const signed = signIncident(body, SK, guardianCoSigner(g));
    const changed = { ...signed, summary: "other" };
    expect(() =>
      verifyMessage({ chainId: CHAIN_ID, signer: g.cosmos, data: incidentSigningBytes(changed), signature: signed.guardianSig as never, pqPublicKey: g.pqc.publicKey }),
    ).toThrow();
  });

  it("signAndRecord: the stored report carries the co-signature, and the co-signer never reaches the LLM", async () => {
    const g = await deriveUnifiedAccount(MNEMONIC);
    const llm = vi.fn(async () => ({ text: "Rescued.", stopReason: "end_turn" }));
    const facts: Facts = { trigger: body.trigger, reason: body.reason, rescues: [] };
    const inc = await signAndRecord({ ...facts, sk: SK, llm, log: () => {}, coSigner: guardianCoSigner(g) }, join(mkdtempSync(join(tmpdir(), "qday-")), "i.jsonl"));
    expect(inc.guardianSig?.pq?.algorithmId).toBe(1);
    const user = (llm.mock.calls[0] as unknown as [string, string])[1];
    expect(Object.keys(JSON.parse(user)).sort()).toEqual(["reason", "rescues", "trigger"]);
  });

  it("a co-signing failure still records the report with the ed25519 signature, and logs it", async () => {
    const lines: string[] = [];
    const broken = { guardian: "qor1x", sign: () => { throw new Error("no pq key"); } };
    const facts: Facts = { trigger: body.trigger, reason: body.reason, rescues: [] };
    const inc = await signAndRecord({ ...facts, sk: SK, log: (l) => void lines.push(l), coSigner: broken }, join(mkdtempSync(join(tmpdir(), "qday-")), "i.jsonl"));
    expect(inc.guardianSig).toBeUndefined();
    expect(verifyIncident(inc)).toBe(true);
    expect(lines.join("\n")).toMatch(/co-sign.*no pq key/);
  });
});
