import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { buildWithdrawal, NETWORK, withdrawalMessage } from "@qday/core";
import { deriveUnifiedAccount, type PqcStatus, type UnifiedAccount } from "@qorechain/sdk";
import { createRecoverer, parseSubmit, RECOVERS_PER_DAY, type RecoverDeps, type Submit } from "../src/recover.ts";
import { createStore, type Store } from "../src/store.ts";

const OWNER_MN = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const OTHER_MN = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const VAULT = ("0x" + "77".repeat(20)) as Hex;
const TOKEN = ("0x" + "88".repeat(20)) as Hex;
const TO = ("0x" + "99".repeat(20)) as Hex;
const T0 = Date.UTC(2026, 10, 25, 12);

let owner: UnifiedAccount, other: UnifiedAccount;
beforeAll(async () => {
  [owner, other] = await Promise.all([OWNER_MN, OTHER_MN].map((m) => deriveUnifiedAccount(m)));
});

/** A signed withdrawal for `owner`, in the wire form the restore screen posts (bigints as decimal strings). */
function signed(over: { amount?: bigint; nonce?: bigint; to?: Hex; token?: Hex; vault?: Hex } = {}, signer = owner): Record<string, string> {
  const p = { vault: over.vault ?? VAULT, to: over.to ?? TO, token: over.token ?? TOKEN, amount: over.amount ?? 10n ** 18n, nonce: over.nonce ?? 0n };
  const f = buildWithdrawal(p, signer.pqc.secretKey);
  return { owner: owner.evm, vault: p.vault, to: p.to, token: p.token, amount: p.amount.toString(), nonce: p.nonce.toString(), sig: f.sig };
}

function setup(over: Partial<RecoverDeps["chain"]> = {}, stage = "active" as string) {
  const store: Store = createStore(mkdtempSync(join(tmpdir(), "recover-")));
  store.put({ owner: owner.evm as Hex, stage: stage as never, createdAt: T0, lastActiveAt: T0, topups: 0 });
  const st = { submitted: [] as Submit[], nonce: 0n, balance: 5n * 10n ** 18n, funder: 100_000_000n, status: { registered: true, possessionProven: true, pubkey: owner.pqc.publicKey } as PqcStatus, roles: { owner: owner.evm as Hex, guardian: other.evm as Hex } as { owner: Hex; guardian: Hex } | null, fail: false };
  const chain: RecoverDeps["chain"] = {
    readVault: async () => st.roles,
    readWithdrawalMessage: () => Promise.resolve(`0x${Buffer.from(withdrawalMessage({ chainId: BigInt(NETWORK.evmChainId), vault: VAULT, to: TO, token: TOKEN, amount: 10n ** 18n, nonce: 0n })).toString("hex")}` as Hex),
    readNonce: async () => st.nonce,
    readVaultBalance: async () => st.balance,
    pqcStatus: async () => st.status,
    funderUqor: async () => st.funder,
    submit: async (w) => {
      if (st.fail) throw new Error("window did not go live");
      st.submitted.push(w);
      return { hash: ("0x" + "ab".repeat(32)) as Hex, status: "success" };
    },
    ...over,
  };
  const rec = createRecoverer({ store, chain, now: () => T0 + 1000 });
  return { store, st, rec };
}

describe("parseSubmit", () => {
  const ok = () => ({ owner: owner.evm, vault: VAULT, to: TO, token: TOKEN, amount: "1000", nonce: "0", sig: "0x" + "ab".repeat(4627) });
  it("accepts the seven fields", () => {
    const r = parseSubmit(ok());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.w.amount).toBe(1000n);
  });
  it("refuses extra keys", () => {
    expect(parseSubmit({ ...ok(), memo: "x" })).toMatchObject({ ok: false });
  });
  it("refuses a short signature", () => {
    expect(parseSubmit({ ...ok(), sig: "0xabcd" })).toMatchObject({ ok: false, error: expect.stringContaining("4627") });
  });
  it("refuses the zero recipient", () => {
    expect(parseSubmit({ ...ok(), to: "0x" + "00".repeat(20) })).toMatchObject({ ok: false, error: expect.stringContaining("zero address") });
  });
  it("refuses a non-address vault", () => {
    expect(parseSubmit({ ...ok(), vault: "0x1234" })).toMatchObject({ ok: false });
  });
  it("refuses a zero amount", () => {
    expect(parseSubmit({ ...ok(), amount: "0" })).toMatchObject({ ok: false });
  });
  it("refuses a bad checksum", () => {
    const mixed = "0x" + "aB".repeat(20);
    expect(parseSubmit({ ...ok(), to: mixed })).toMatchObject({ ok: false, error: expect.stringContaining("checksum") });
  });
});

describe("submit", () => {
  it("sends a valid withdrawal and counts it", async () => {
    const { rec, st, store } = setup();
    const r = await rec.submit(signed());
    expect(r.code).toBe(200);
    expect(st.submitted).toHaveLength(1);
    expect(store.get(owner.evm)?.restores?.n).toBe(1);
  });

  it("answers 400 for a malformed body", async () => {
    const { rec, st } = setup();
    expect((await rec.submit({ owner: owner.evm })).code).toBe(400);
    expect(st.submitted).toHaveLength(0);
  });

  it("answers 404 for an owner the service never saw", async () => {
    const { rec, store } = setup();
    store.put({ owner: other.evm as Hex, stage: "starter", createdAt: T0, lastActiveAt: T0, topups: 0 });
    const w = { ...signed(), owner: ("0x" + "12".repeat(20)) as Hex };
    expect((await rec.submit(w)).code).toBe(404);
  });

  it("answers 409 while the owner is not active", async () => {
    const { rec, st } = setup({}, "provisioned");
    const r = await rec.submit(signed());
    expect(r).toMatchObject({ code: 409, body: { error: "not-active" } });
    expect(st.submitted).toHaveLength(0);
  });

  it("answers 422 when the vault belongs to another owner", async () => {
    const { rec, st } = setup();
    st.roles = { owner: other.evm as Hex, guardian: other.evm as Hex };
    expect(await rec.submit(signed())).toMatchObject({ code: 422, body: { error: "recover-vault" } });
  });

  it("answers 422 when the vault encodes a different message", async () => {
    const { rec } = setup({ readWithdrawalMessage: () => Promise.resolve(("0x" + "00".repeat(32)) as Hex) });
    expect(await rec.submit(signed())).toMatchObject({ code: 422, body: { error: "recover-message" } });
  });

  it("answers 422 for a signature from another account's key", async () => {
    const { rec, st } = setup();
    expect(await rec.submit(signed({}, other))).toMatchObject({ code: 422, body: { error: "recover-signature" } });
    expect(st.submitted).toHaveLength(0);
  });

  it("answers 422 when the key is not proven", async () => {
    const { rec, st } = setup();
    st.status = { registered: true, possessionProven: false, pubkey: owner.pqc.publicKey };
    expect(await rec.submit(signed())).toMatchObject({ code: 422, body: { error: "recover-signature" } });
  });

  it("answers 422 when the nonce moved on", async () => {
    const { rec, st } = setup();
    st.nonce = 1n;
    expect(await rec.submit(signed())).toMatchObject({ code: 422, body: { error: "recover-nonce" } });
  });

  it("answers 422 when the vault cannot cover the amount", async () => {
    const { rec, st } = setup();
    st.balance = 1n;
    expect(await rec.submit(signed())).toMatchObject({ code: 422, body: { error: "recover-balance" } });
  });

  it("stops at the per-owner daily cap", async () => {
    const { rec, st } = setup();
    for (let i = 0; i < RECOVERS_PER_DAY; i++) expect((await rec.submit(signed())).code).toBe(200);
    expect(await rec.submit(signed())).toMatchObject({ code: 429, body: { error: "recover-cap" } });
    expect(st.submitted).toHaveLength(RECOVERS_PER_DAY);
  });

  it("refuses below the funder floor", async () => {
    const { rec, st } = setup();
    st.funder = 1n;
    expect(await rec.submit(signed())).toMatchObject({ code: 503, body: { error: "funder-low" } });
    expect(st.submitted).toHaveLength(0);
  });

  it("releases the day's slot when the send fails", async () => {
    const { rec, st, store } = setup();
    st.fail = true;
    expect((await rec.submit(signed())).code).toBe(502);
    expect(store.get(owner.evm)?.restores?.n).toBe(0);
  });

  it("reports a reverted receipt as its own status, not as an error", async () => {
    const { rec } = setup({ submit: () => Promise.resolve({ hash: ("0x" + "cd".repeat(32)) as Hex, status: "reverted" }) });
    expect(await rec.submit(signed())).toMatchObject({ code: 200, body: { status: "reverted" } });
  });
});
