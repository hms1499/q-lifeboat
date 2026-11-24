import { signIncident, vaultAbi, type IncidentBody } from "@qday/core";
import { ed25519 } from "@noble/curves/ed25519";
import { bytesToHex, encodeAbiParameters, encodeEventTopics, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { verifyReport, type AuthenticatorLike, type ReceiptLike, type VerifyContext } from "./verify";

const SK = new Uint8Array(32).fill(7);
const PK_HEX = bytesToHex(ed25519.getPublicKey(SK)).slice(2); // lowercase, no 0x
const OTHER_PK_HEX = bytesToHex(ed25519.getPublicKey(new Uint8Array(32).fill(9))).slice(2);

const VAULT = "0x17d867860a0a0ff528df655439ff59176b061b3c" as Hex;
const FUSD = "0x1111111111111111111111111111111111111111" as Hex;
const FETH = "0x2222222222222222222222222222222222222222" as Hex;
const H1 = `0x${"a1".repeat(32)}` as Hex;
const H2 = `0x${"b2".repeat(32)}` as Hex;
const NOW = 1_800_000_000;

const body = (over: Partial<IncidentBody> = {}): IncidentBody => ({
  id: "inc-1",
  detectedAt: "2026-11-21T04:32:43.151Z",
  trigger: { kind: "transfer", hash: `0x${"cc".repeat(32)}`, block: 100n, token: FUSD, to: "0x849558983b0BEa8E6aEF9eb3a37b888a56CB069f", amount: 10n * 10n ** 18n },
  reason: "recipient is not trusted",
  rescues: [{ token: FUSD, hash: H1, amount: 90n * 10n ** 18n, expected: 90n * 10n ** 18n, success: true }],
  summary: "s",
  summarySource: "template",
  ...over,
});

/** What the dashboard receives: the agent's JSON (bigints as decimal strings), parsed back. */
const wire = (b: IncidentBody, sk = SK) => JSON.parse(JSON.stringify(signIncident(b, sk), (_, v) => (typeof v === "bigint" ? v.toString() : v)));

const rescuedLog = (token: Hex, amount: bigint, address: Hex = VAULT) => ({
  address,
  topics: encodeEventTopics({ abi: vaultAbi, eventName: "Rescued", args: { token } }) as Hex[],
  data: encodeAbiParameters([{ type: "uint256" }], [amount]),
});

const okReceipt = (logs = [rescuedLog(FUSD, 90n * 10n ** 18n)]): ReceiptLike => ({ status: "success", to: VAULT, blockNumber: 101n, logs });

const linked = (over: Partial<AuthenticatorLike> = {}): AuthenticatorLike => ({
  scheme: "ed25519",
  pubkeyHex: PK_HEX,
  revoked: false,
  expiryUnix: BigInt(NOW + 86_400),
  ...over,
});

const ctx = (over: Partial<VerifyContext> = {}): VerifyContext => ({
  authenticators: [linked()],
  nowUnix: NOW,
  vault: VAULT,
  readReceipt: async (h) => (h === H1 ? okReceipt() : null),
  ...over,
});

const byId = (r: Awaited<ReturnType<typeof verifyReport>>, id: string) => r.checks.find((c) => c.id === id)!;

describe("verifyReport", () => {
  it("passes a signed report by a linked, active key whose rescue is on chain", async () => {
    const r = await verifyReport(wire(body()), ctx());
    expect(r.checks.map((c) => [c.id, c.status])).toEqual([
      ["signature", "pass"],
      ["linked", "pass"],
      ["active", "pass"],
      ["guardian", "n/a"],
      ["rescues", "pass"],
    ]);
    expect(r.ok).toBe(true);
  });

  it("test_rejectsValidSigFromUnlinkedKey: a valid signature by a key the owner never linked is not trusted", async () => {
    const r = await verifyReport(wire(body()), ctx({ authenticators: [linked({ pubkeyHex: OTHER_PK_HEX })] }));
    expect(byId(r, "signature").status).toBe("pass");
    expect(byId(r, "linked").status).toBe("fail");
    expect(r.ok).toBe(false);
    const none = await verifyReport(wire(body()), ctx({ authenticators: [] }));
    expect(byId(none, "linked").status).toBe("fail");
    expect(none.ok).toBe(false);
  });

  it("refuses a linked key that is not ed25519", async () => {
    const r = await verifyReport(wire(body()), ctx({ authenticators: [linked({ scheme: "secp256k1" })] }));
    expect(byId(r, "linked").status).toBe("fail");
    expect(r.ok).toBe(false);
  });

  it("refuses a revoked key", async () => {
    const r = await verifyReport(wire(body()), ctx({ authenticators: [linked({ revoked: true })] }));
    expect(byId(r, "linked").status).toBe("pass");
    expect(byId(r, "active").status).toBe("fail");
    expect(byId(r, "active").detail).toMatch(/revoked/);
    expect(r.ok).toBe(false);
  });

  it("refuses an expired key (expiryUnix must be strictly after now)", async () => {
    const at = await verifyReport(wire(body()), ctx({ authenticators: [linked({ expiryUnix: BigInt(NOW) })] }));
    expect(byId(at, "active").status).toBe("fail");
    expect(byId(at, "active").detail).toMatch(/expired/);
    expect(at.ok).toBe(false);
  });

  it("accepts the key when one of several entries for it is active (re-linked after a revoke)", async () => {
    const r = await verifyReport(wire(body()), ctx({ authenticators: [linked({ revoked: true }), linked()] }));
    expect(byId(r, "active").status).toBe("pass");
    expect(r.ok).toBe(true);
  });

  it("normalises the linked key: uppercase and 0x-prefixed pubkey_hex still matches", async () => {
    const r = await verifyReport(wire(body()), ctx({ authenticators: [linked({ pubkeyHex: `0x${PK_HEX.toUpperCase()}`, scheme: "ED25519" })] }));
    expect(byId(r, "linked").status).toBe("pass");
    expect(r.ok).toBe(true);
  });

  it("refuses a tampered body (amount changed after signing)", async () => {
    const inc = wire(body());
    inc.rescues[0].amount = "100000000000000000000";
    const r = await verifyReport(inc, ctx({ readReceipt: async () => okReceipt([rescuedLog(FUSD, 100n * 10n ** 18n)]) }));
    expect(byId(r, "signature").status).toBe("fail");
    expect(r.ok).toBe(false);
  });

  it("refuses a report whose agentPubkey was swapped for the linked key (signature no longer verifies)", async () => {
    const inc = wire(body(), new Uint8Array(32).fill(9));
    inc.agentPubkey = PK_HEX;
    const r = await verifyReport(inc, ctx());
    expect(byId(r, "signature").status).toBe("fail");
    expect(r.ok).toBe(false);
  });

  it("refuses a rescue whose receipt reverted", async () => {
    const r = await verifyReport(wire(body()), ctx({ readReceipt: async () => ({ ...okReceipt(), status: "reverted" }) }));
    expect(byId(r, "rescues").status).toBe("fail");
    expect(byId(r, "rescues").detail).toMatch(/revert/);
    expect(r.ok).toBe(false);
  });

  it("refuses a rescue tx that is not on chain, or whose receipt cannot be read", async () => {
    const missing = await verifyReport(wire(body()), ctx({ readReceipt: async () => null }));
    expect(byId(missing, "rescues").status).toBe("fail");
    const throws = await verifyReport(wire(body()), ctx({ readReceipt: async () => { throw new Error("rpc down"); } }));
    expect(byId(throws, "rescues").status).toBe("fail");
    expect(throws.ok).toBe(false);
  });

  it("refuses a Rescued amount that differs from the report", async () => {
    const r = await verifyReport(wire(body()), ctx({ readReceipt: async () => okReceipt([rescuedLog(FUSD, 89n * 10n ** 18n)]) }));
    expect(byId(r, "rescues").status).toBe("fail");
    expect(byId(r, "rescues").detail).toMatch(/amount/);
    expect(r.ok).toBe(false);
  });

  it("refuses a Rescued log for another token, or emitted by another contract", async () => {
    const token = await verifyReport(wire(body()), ctx({ readReceipt: async () => okReceipt([rescuedLog(FETH, 90n * 10n ** 18n)]) }));
    expect(byId(token, "rescues").status).toBe("fail");
    const fake = "0x9999999999999999999999999999999999999999" as Hex;
    const emitter = await verifyReport(wire(body()), ctx({ readReceipt: async () => okReceipt([rescuedLog(FUSD, 90n * 10n ** 18n, fake)]) }));
    expect(byId(emitter, "rescues").status).toBe("fail");
  });

  it("refuses a rescue tx sent to another address than the vault", async () => {
    const r = await verifyReport(wire(body()), ctx({ readReceipt: async () => ({ ...okReceipt(), to: "0x9999999999999999999999999999999999999999" }) }));
    expect(byId(r, "rescues").status).toBe("fail");
    expect(r.ok).toBe(false);
  });

  it("refuses a successful rescue whose hash is not an EVM tx hash", async () => {
    const inc = wire(body({ rescues: [{ token: FUSD, hash: "8508B568DE126539BA5DD8CAE4337E0DCFC1F1B6C47323BC4228495037EA84B7", amount: 1n, expected: 1n, success: true }] }));
    const r = await verifyReport(inc, ctx());
    expect(byId(r, "rescues").status).toBe("fail");
  });

  it("checks every successful rescue and skips failed attempts", async () => {
    const two = body({
      rescues: [
        { token: FUSD, hash: H1, amount: 90n * 10n ** 18n, expected: 90n * 10n ** 18n, success: true },
        { token: FETH, hash: "", amount: 0n, expected: 5n, success: false, error: "window exhausted" },
        { token: FETH, hash: H2, amount: 7n, expected: 7n, success: true },
      ],
    });
    const receipts: Record<string, ReceiptLike> = { [H1]: okReceipt(), [H2]: okReceipt([rescuedLog(FETH, 7n)]) };
    const ok = await verifyReport(wire(two), ctx({ readReceipt: async (h) => receipts[h] ?? null }));
    expect(byId(ok, "rescues").status).toBe("pass");
    expect(ok.ok).toBe(true);
    const bad = await verifyReport(wire(two), ctx({ readReceipt: async (h) => (h === H1 ? okReceipt() : null) }));
    expect(byId(bad, "rescues").status).toBe("fail");
  });

  it("alert-only report (no rescues) → rescues check is n/a and the report can still be ok", async () => {
    const r = await verifyReport(wire(body({ rescues: [] })), ctx({ readReceipt: async () => { throw new Error("must not be called"); } }));
    expect(byId(r, "rescues").status).toBe("n/a");
    expect(r.ok).toBe(true);
  });

  it("only failed rescue attempts → n/a (nothing moved, nothing to prove)", async () => {
    const r = await verifyReport(
      wire(body({ rescues: [{ token: FUSD, hash: "", amount: 0n, expected: 9n, success: false, error: "x" }] })),
      ctx(),
    );
    expect(byId(r, "rescues").status).toBe("n/a");
  });

  it("an old trigger without `kind` still verifies (the signature covers what the agent signed)", async () => {
    const b = body();
    const { kind: _k, ...trigger } = b.trigger;
    const r = await verifyReport(wire({ ...b, trigger: trigger as IncidentBody["trigger"] }), ctx());
    expect(byId(r, "signature").status).toBe("pass");
  });

  it("a config mismatch fails every report (config check added first)", async () => {
    const r = await verifyReport(wire(body()), ctx({ config: { ok: false, detail: "vault.owner() is 0xabc…, config says 0xdef…" } }));
    expect(r.checks[0]).toMatchObject({ id: "config", status: "fail" });
    expect(r.ok).toBe(false);
    const fine = await verifyReport(wire(body()), ctx({ config: { ok: true, detail: "owner and guardian match vault" } }));
    expect(fine.checks[0]).toMatchObject({ id: "config", status: "pass" });
    expect(fine.ok).toBe(true);
  });

  it("never throws on malformed input: it fails instead", async () => {
    const r = await verifyReport({ id: "x" } as never, ctx());
    expect(r.ok).toBe(false);
    expect(byId(r, "signature").status).toBe("fail");
  });
});

describe("guardian co-signature check (submission gap 3)", () => {
  const MNEMONIC = "test test test test test test test test test test test junk";
  const OTHER = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

  /** A report co-signed by `m`'s account with QoreSign, as the agent produces it, then sent as JSON. */
  async function coSigned(m = MNEMONIC, b = body()) {
    const { deriveUnifiedAccount } = await import("@qorechain/sdk");
    const { classicalKeyFromPrivate, signMessage } = await import("@qorechain/qoresign");
    const g = await deriveUnifiedAccount(m);
    const ck = classicalKeyFromPrivate(Buffer.from(g.privateKey.replace(/^0x/, ""), "hex"), "eth_secp256k1");
    const signed = signIncident(b, SK, {
      guardian: g.cosmos,
      sign: (data) => signMessage({ chainId: "qorechain-diana", signer: g.cosmos, data, classicalKey: ck, pqKey: { secretKey: g.pqc.secretKey } }) as never,
    });
    return { g, report: JSON.parse(JSON.stringify(signed, (_, v) => (typeof v === "bigint" ? v.toString() : v))) };
  }
  /** Offline stand-in for verifyMessageWithChain: QoreSign's verifyMessage against `g`'s PQ key as "registered on chain". */
  async function offlineVerifier(g: { pqc: { publicKey: Uint8Array } }) {
    const { verifyMessage } = await import("@qorechain/qoresign");
    return async (a: { chainId: string; signer: string; data: Uint8Array; signature: unknown }) => {
      verifyMessage({ ...a, signature: a.signature as never, pqPublicKey: g.pqc.publicKey, requirePq: true });
      return { possessionProven: true };
    };
  }

  it("pass: signed by the vault's guardian (its qor1), verified over the report's exact bytes", async () => {
    const { g, report } = await coSigned();
    const r = await verifyReport(report, ctx({ guardian: g.evm as Hex, verifyGuardianSig: await offlineVerifier(g) }));
    expect(byId(r, "guardian").status).toBe("pass");
    expect(byId(r, "guardian").detail).toMatch(/ML-DSA-87/);
    expect(r.ok).toBe(true);
  });

  it("fail: the co-signer is not the vault's guardian (the verifier is never asked)", async () => {
    const { report } = await coSigned(OTHER);
    const { deriveUnifiedAccount } = await import("@qorechain/sdk");
    const real = await deriveUnifiedAccount(MNEMONIC);
    let asked = false;
    const r = await verifyReport(report, ctx({ guardian: real.evm as Hex, verifyGuardianSig: async () => ((asked = true), { possessionProven: true }) }));
    expect(byId(r, "guardian").status).toBe("fail");
    expect(byId(r, "guardian").detail).toMatch(/not the vault's guardian/);
    expect(asked).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("fail: a changed report no longer verifies", async () => {
    const { g, report } = await coSigned();
    const r = await verifyReport({ ...report, guardianSig: report.guardianSig, reason: "changed" }, ctx({ guardian: g.evm as Hex, verifyGuardianSig: await offlineVerifier(g) }));
    expect(byId(r, "guardian").status).toBe("fail");
  });

  it("fail: a classical-only co-signature (no ML-DSA-87 part)", async () => {
    const { g, report } = await coSigned();
    const classicalOnly = { ...report, guardianSig: { ...report.guardianSig, signatureType: "secp256k1", pq: undefined } };
    const r = await verifyReport(classicalOnly, ctx({ guardian: g.evm as Hex, verifyGuardianSig: await offlineVerifier(g) }));
    expect(byId(r, "guardian").status).toBe("fail");
    expect(byId(r, "guardian").detail).toMatch(/no ML-DSA-87/);
  });

  it("Review Focus 5: names the real guardian but was co-signed by another account's keys → fail (the verifier is asked)", async () => {
    const { g } = await coSigned();
    const { report: byOther } = await coSigned(OTHER);
    const forged = { ...byOther, guardian: g.cosmos };
    const r = await verifyReport(forged, ctx({ guardian: g.evm as Hex, verifyGuardianSig: await offlineVerifier(g) }));
    expect(byId(r, "guardian").status).toBe("fail");
  });

  it("fail: valid classical part, ML-DSA-87 part spliced from another report", async () => {
    const { g, report } = await coSigned();
    const { report: other } = await coSigned(MNEMONIC, body({ id: "inc-2", summary: "another report" }));
    const spliced = { ...report, guardianSig: { ...report.guardianSig, pq: other.guardianSig.pq } };
    const r = await verifyReport(spliced, ctx({ guardian: g.evm as Hex, verifyGuardianSig: await offlineVerifier(g) }));
    expect(byId(r, "guardian").status).toBe("fail");
    expect(byId(r, "guardian").detail).toMatch(/PQ_SIGNATURE_INVALID/);
  });

  it("fail when the config check failed: the guardian it names is not the vault's", async () => {
    const { g, report } = await coSigned();
    const r = await verifyReport(report, ctx({ guardian: g.evm as Hex, verifyGuardianSig: await offlineVerifier(g), config: { ok: false, detail: "mismatch" } }));
    expect(byId(r, "guardian").status).toBe("fail");
  });

  it("never throws: a malformed guardian address fails the row", async () => {
    const { g, report } = await coSigned();
    const r = await verifyReport(report, ctx({ guardian: "0xnot-an-address" as Hex, verifyGuardianSig: await offlineVerifier(g) }));
    expect(byId(r, "guardian").status).toBe("fail");
  });

  it("an unreachable chain reads as 'could not check', still a fail", async () => {
    const { g, report } = await coSigned();
    const down = async () => {
      throw Object.assign(new Error("fetch failed"), { code: "NETWORK_UNAVAILABLE" });
    };
    const r = await verifyReport(report, ctx({ guardian: g.evm as Hex, verifyGuardianSig: down }));
    expect(byId(r, "guardian").status).toBe("fail");
    expect(byId(r, "guardian").detail).toMatch(/could not check/);
  });

  it("n/a for a report signed before co-signing; it does not fail an otherwise valid report", async () => {
    const r = await verifyReport(wire(body()), ctx({ guardian: VAULT, verifyGuardianSig: async () => ({ possessionProven: true }) }));
    expect(byId(r, "guardian").status).toBe("n/a");
    expect(byId(r, "guardian").detail).toMatch(/classical/);
    expect(r.ok).toBe(true);
  });

  it("fail when the report carries a co-signature but the vault's guardian is unknown", async () => {
    const { g, report } = await coSigned();
    const r = await verifyReport(report, ctx({ verifyGuardianSig: await offlineVerifier(g) }));
    expect(byId(r, "guardian").status).toBe("fail");
  });
});
