import { withdrawalMessage } from "@qday/core";
import { generatePqcKeypair, ML_DSA_87_SIGNATURE_LENGTH, pqcSign, type PqcStatus } from "@qorechain/sdk";
import { bytesToHex, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { checkWithdrawal, parseWithdrawalJson, type ParsedWithdrawal, type WithdrawalDeps } from "./withdrawal";

const VAULT = "0x17d867860a0A0Ff528dF655439ff59176b061B3C" as Hex;
const TO = "0x9858EfFD232B4033E47d90003D41EC34EcaEda94" as Hex;
const FUSD = "0x1111111111111111111111111111111111111111" as Hex;
const QOR = "0x0000000000000000000000000000000000000000" as Hex;

const kp = generatePqcKeypair(new Uint8Array(32).fill(3));
const other = generatePqcKeypair(new Uint8Array(32).fill(4));

function signed(over: Partial<{ vault: Hex; to: Hex; token: Hex; amount: bigint; nonce: bigint }> = {}, sk = kp.secretKey) {
  const p = { vault: VAULT, to: TO, token: FUSD, amount: 10n ** 18n, nonce: 2n, ...over };
  const msg = withdrawalMessage({ chainId: 9800n, ...p });
  return { file: { vault: p.vault, to: p.to, token: p.token, amount: p.amount.toString(), nonce: p.nonce.toString(), sig: bytesToHex(pqcSign(sk, msg)) }, msg };
}

const status = (over: Partial<PqcStatus> = {}): PqcStatus => ({ registered: true, possessionProven: true, pubkey: kp.publicKey, ...over });

const deps = (over: Partial<WithdrawalDeps> = {}): WithdrawalDeps => ({
  vault: VAULT,
  chainId: 9800n,
  readPqcStatus: async () => status(),
  readOnChainMessage: async (w) => bytesToHex(withdrawalMessage({ chainId: 9800n, vault: VAULT, to: w.to, token: w.token, amount: w.amount, nonce: w.nonce })),
  readNonce: async () => 2n,
  readVaultBalance: async () => 5n * 10n ** 18n,
  ...over,
});

const parse = (o: unknown) => parseWithdrawalJson(JSON.stringify(o));
const byId = (cs: Awaited<ReturnType<typeof checkWithdrawal>>, id: string) => cs.find((c) => c.id === id)!;

describe("parseWithdrawalJson (strict)", () => {
  const good = signed().file;

  it("parses the CLI's withdrawal.json into typed values", () => {
    const w = parse(good);
    expect(w).toEqual({ vault: VAULT, to: TO, token: FUSD, amount: 10n ** 18n, nonce: 2n, sig: good.sig });
  });

  it("rejects invalid JSON, a non-object, an unknown key and a missing key", () => {
    expect(() => parseWithdrawalJson("{")).toThrow(/JSON/);
    expect(() => parse([good])).toThrow(/object/);
    expect(() => parse({ ...good, extra: 1 })).toThrow(/extra/);
    for (const k of ["vault", "to", "token", "amount", "nonce", "sig"]) {
      const bad: Record<string, unknown> = { ...good };
      delete bad[k];
      expect(() => parse(bad), k).toThrow(new RegExp(k));
    }
  });

  it("rejects malformed addresses, non-decimal or zero amounts, numbers instead of strings and a wrong-length sig", () => {
    expect(() => parse({ ...good, to: "0x1234" })).toThrow(/to/);
    expect(() => parse({ ...good, amount: "1e18" })).toThrow(/amount/);
    expect(() => parse({ ...good, amount: "0" })).toThrow(/amount/);
    expect(() => parse({ ...good, amount: 1 })).toThrow(/amount/);
    expect(() => parse({ ...good, nonce: "-1" })).toThrow(/nonce/);
    expect(() => parse({ ...good, sig: "0xabcd" })).toThrow(new RegExp(String(ML_DSA_87_SIGNATURE_LENGTH)));
    expect(() => parse({ ...good, sig: `0x${"zz".repeat(ML_DSA_87_SIGNATURE_LENGTH)}` })).toThrow(/sig/);
  });
});

describe("checkWithdrawal", () => {
  const w = (over = {}, sk?: Uint8Array): ParsedWithdrawal => parse(signed(over, sk).file);

  it("passes every check for a fresh, correctly signed file", async () => {
    const cs = await checkWithdrawal(w(), deps());
    expect(cs.map((c) => [c.id, c.status])).toEqual([
      ["vault", "pass"],
      ["key", "pass"],
      ["signature", "pass"],
      ["message", "pass"],
      ["nonce", "pass"],
      ["balance", "pass"],
    ]);
  });

  it("refuses a file for another vault", async () => {
    const other = "0x2222222222222222222222222222222222222222" as Hex;
    expect(byId(await checkWithdrawal(w({ vault: other }), deps()), "vault").status).toBe("fail");
  });

  it("refuses when the owner's PQC key is not registered, not proven, or unreadable", async () => {
    expect(byId(await checkWithdrawal(w(), deps({ readPqcStatus: async () => status({ registered: false, pubkey: undefined }) })), "key").status).toBe("fail");
    expect(byId(await checkWithdrawal(w(), deps({ readPqcStatus: async () => status({ possessionProven: false }) })), "key").status).toBe("fail");
    const down = await checkWithdrawal(w(), deps({ readPqcStatus: async () => { throw new Error("rest down"); } }));
    expect(byId(down, "key").status).toBe("fail");
    expect(byId(down, "signature").status).toBe("fail");
  });

  it("refuses a signature by another ML-DSA key", async () => {
    expect(byId(await checkWithdrawal(w({}, other.secretKey), deps()), "signature").status).toBe("fail");
  });

  it("refuses a file whose amount was edited after signing", async () => {
    const f = signed().file;
    const cs = await checkWithdrawal(parse({ ...f, amount: "2000000000000000000" }), deps());
    expect(byId(cs, "signature").status).toBe("fail");
  });

  it("refuses when the vault's withdrawalMessage differs from core's bytes", async () => {
    const cs = await checkWithdrawal(w(), deps({ readOnChainMessage: async () => "0xdeadbeef" }));
    expect(byId(cs, "message").status).toBe("fail");
  });

  it("refuses a stale nonce", async () => {
    const cs = await checkWithdrawal(w(), deps({ readNonce: async () => 3n }));
    expect(byId(cs, "nonce").status).toBe("fail");
    expect(byId(cs, "nonce").detail).toMatch(/sign-withdraw/);
  });

  it("refuses an amount above the vault balance; QOR reads the native balance (zero address)", async () => {
    const seen: Hex[] = [];
    const cs = await checkWithdrawal(w({ token: QOR, amount: 6n * 10n ** 18n }), deps({ readVaultBalance: async (t) => (seen.push(t), 5n * 10n ** 18n) }));
    expect(seen).toEqual([QOR]);
    expect(byId(cs, "balance").status).toBe("fail");
    const exact = await checkWithdrawal(w({ amount: 5n * 10n ** 18n }), deps());
    expect(byId(exact, "balance").status).toBe("pass");
  });

  it("a reader that throws fails its own check, never the whole list", async () => {
    const cs = await checkWithdrawal(w(), deps({ readNonce: async () => { throw new Error("rpc"); } }));
    expect(cs).toHaveLength(6);
    expect(byId(cs, "nonce").status).toBe("fail");
    expect(byId(cs, "balance").status).toBe("pass");
  });
});

describe("parseWithdrawalJson checksum", () => {
  it("rejects a mixed-case address with a wrong EIP-55 checksum, accepts all-lowercase", () => {
    const f = signed().file;
    expect(() => parse({ ...f, to: "0x9858EfFD232B4033E47d90003D41EC34EcaEdA94" })).toThrow(/checksum/);
    expect(parse({ ...f, to: f.to.toLowerCase() }).to).toBe(f.to.toLowerCase());
  });
});
