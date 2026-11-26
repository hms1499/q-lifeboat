import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { toHex, type Hex } from "viem";
import { RESCUE_SELECTOR, signOwnerRequest, type OwnerPurpose, type SignedOwnerRequest } from "@qday/core";
import { deriveUnifiedAccount, type AuthenticatorView, type PqcStatus, type SpendingRules, type UnifiedAccount } from "@qorechain/sdk";
import { createLimits } from "../src/limits.ts";
import { decodeLinkProof } from "@qday/core";
import { createProvisioner, GUARDIAN_FUND_UQOR, STARTER_OWNER_UQOR, TOPUP_UQOR, type ChainDeps } from "../src/provision.ts";
import { REFILLS_GLOBAL_PER_DAY } from "../src/limits.ts";
import { clientIp, createHostedServer } from "../src/server.ts";
import { createStore, type Store } from "../src/store.ts";

const OWNER_MN = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const GUARD_MN = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const FUNDER_MN = "letter advice cage absurd amount doctor acoustic avoid letter advice cage above";
const AGENT_SK = "11".repeat(32);
const VAULT = ("0x" + "77".repeat(20)) as Hex;
const T0 = Date.UTC(2026, 10, 25, 12);
const nowSec = Math.floor(T0 / 1000);

let ownerAcc: UnifiedAccount, guardianAcc: UnifiedAccount, funder: UnifiedAccount;
beforeAll(async () => {
  [ownerAcc, guardianAcc, funder] = await Promise.all([OWNER_MN, GUARD_MN, FUNDER_MN].map((m) => deriveUnifiedAccount(m)));
});

let n = 0;
const sign = (purpose: OwnerPurpose, body: unknown, over: Partial<SignedOwnerRequest["request"]> = {}): SignedOwnerRequest =>
  signOwnerRequest(
    { owner: ownerAcc.evm as Hex, purpose, body, nonce: `n-${++n}`, expiresAt: nowSec + 120, ...over },
    ownerAcc.pqc.secretKey,
  );

type Fake = ReturnType<typeof fakeChain>;
function fakeChain(store: Store) {
  const calls: string[] = [];
  const balances = new Map<string, bigint>();
  const pqc = new Map<string, PqcStatus>();
  pqc.set(ownerAcc.cosmos, { registered: true, possessionProven: true, pubkey: ownerAcc.pqc.publicKey });
  balances.set(funder.cosmos, 100_000_000n);
  const st = {
    calls,
    balances,
    pqc,
    vault: { owner: ownerAcc.evm as Hex, guardian: guardianAcc.evm as Hex } as { owner: Hex; guardian: Hex } | null | "throw",
    auths: [] as AuthenticatorView[],
    rules: { rules: [], authenticatorRules: [] } as SpendingRules,
    inFlight: 0,
    maxInFlight: 0,
    broadcastDelay: 0,
    failNext: undefined as string | undefined,
    secretsAtFirstBroadcast: undefined as unknown,
    txs: 0,
  };
  const chain: ChainDeps = {
    uqorBalance: async (c) => balances.get(c) ?? 0n,
    broadcast: async (acc, msgs, memo, mode) => {
      calls.push(`broadcast:${acc.cosmos === funder.cosmos ? "funder" : acc.cosmos === guardianAcc.cosmos ? "guardian" : "other"}:${mode}:${memo}`);
      if (st.secretsAtFirstBroadcast === undefined) st.secretsAtFirstBroadcast = store.readSecrets(ownerAcc.evm);
      st.inFlight++;
      st.maxInFlight = Math.max(st.maxInFlight, st.inFlight);
      try {
        if (st.broadcastDelay) await new Promise((r) => setTimeout(r, st.broadcastDelay));
        if (st.failNext) {
          const m = st.failNext;
          st.failNext = undefined;
          throw new Error(m);
        }
        for (const m of msgs) {
          const v = m.value as any;
          if (m.typeUrl.endsWith("MsgSend")) {
            const amt = BigInt(v.amount[0].amount);
            balances.set(v.toAddress, (balances.get(v.toAddress) ?? 0n) + amt);
            balances.set(v.fromAddress, (balances.get(v.fromAddress) ?? 0n) - amt);
          } else if (/RegisterPQC/.test(m.typeUrl)) {
            pqc.set(acc.cosmos, { registered: true, possessionProven: true, pubkey: acc.pqc.publicKey });
          }
        }
        return `TX${++st.txs}`;
      } finally {
        st.inFlight--;
      }
    },
    pqcStatus: async (c) => pqc.get(c) ?? { registered: false },
    readVault: async () => {
      if (st.vault === "throw") throw new Error("HTTP request failed: fetch failed");
      return st.vault;
    },
    authenticators: async () => st.auths,
    spendingRules: async () => st.rules,
    sleep: async () => {},
  };
  return { st, chain };
}

/** `starter` (default true): the owner already took a starter pack (seeded row, no tx). */
function setup(opts: { onActivated?: (o: Hex) => void; failBroadcast?: () => boolean; newMnemonic?: () => string; starter?: boolean; canStart?: () => boolean; maxAgents?: number } = {}) {
  const raw = createStore(mkdtempSync(join(tmpdir(), "hp-")));
  if (opts.starter !== false) raw.put({ owner: ownerAcc.evm as Hex, stage: "starter", starter: true, createdAt: T0, lastActiveAt: T0, topups: 0 });
  const order: string[] = [];
  const store: Store = {
    ...raw,
    writeSecrets: (o, s) => {
      order.push("secrets");
      raw.writeSecrets(o, s);
    },
  };
  const { st, chain: base } = fakeChain(store);
  const chain: ChainDeps = {
    ...base,
    broadcast: async (acc, msgs, memo, mode) => {
      if (opts.failBroadcast?.()) throw new Error(`refused: ${memo}`);
      return base.broadcast(acc, msgs, memo, mode);
    },
  };
  let t = T0;
  const prov = createProvisioner({
    store,
    chain,
    funder,
    limits: createLimits(() => t),
    now: () => t,
    newMnemonic: opts.newMnemonic ?? (() => GUARD_MN),
    newAgentKey: () => AGENT_SK,
    onActivated: opts.onActivated,
    canStart: opts.canStart,
    maxAgents: opts.maxAgents,
    log: () => {},
  });
  return { prov, store, st, order, chain, setNow: (ms: number) => (t = ms) };
}

/** The agent key linked live on the owner, plus the exact rule: what activate needs. */
function linkOnChain(st: Fake["st"], pkHex: string) {
  st.auths = [
    { scheme: "ed25519", pubkeyHex: pkHex.replace(/^0x/, ""), permissions: ["evm"], expiryUnix: BigInt(nowSec + 30 * 86400), label: "x", createdAtUnix: 0n, revoked: false, hasSpendRule: false },
  ];
  st.rules = {
    rules: [{ id: "guardian", enabled: true, perTxLimit: 1n, dailyLimit: 1n, allowedDenoms: ["uqor"], allowedEvmCalls: [`${VAULT.toLowerCase()}/${RESCUE_SELECTOR}`], denomLimits: [] }],
    authenticatorRules: [],
  };
}

describe("starter", () => {
  it("sends 2.5 QOR from the funder, records stage starter, refuses the same owner again", async () => {
    const { prov, store, st } = setup({ starter: false });
    const r = await prov.starter("1.1.1.1", { owner: ownerAcc.evm });
    expect(r.code).toBe(200);
    expect(r.body).toEqual({ tx: "TX1" });
    expect(st.balances.get(ownerAcc.cosmos)).toBe(STARTER_OWNER_UQOR);
    expect(store.get(ownerAcc.evm)?.stage).toBe("starter");
    const again = await prov.starter("2.2.2.2", { owner: ownerAcc.evm });
    expect(again).toEqual({ code: 409, body: { error: "owner-used" } });
  });

  it("refuses a malformed owner with 400 and a low funder with 503 funder-low", async () => {
    const { prov, st } = setup({ starter: false });
    expect((await prov.starter("1.1.1.1", { owner: "0x12" })).code).toBe(400);
    st.balances.set(funder.cosmos, 19_900_000n);
    expect(await prov.starter("1.1.1.1", { owner: ownerAcc.evm })).toEqual({ code: 503, body: { error: "funder-low" } });
  });

  it("a failed starter tx releases the owner so it can retry", async () => {
    const { prov, st, store } = setup({ starter: false });
    st.failNext = "refused";
    expect((await prov.starter("1.1.1.1", { owner: ownerAcc.evm })).code).toBe(502);
    expect(store.get(ownerAcc.evm)).toBeNull();
    expect((await prov.starter("1.1.1.1", { owner: ownerAcc.evm })).code).toBe(200);
  });

  it("funder txs are serialized (one in flight at a time)", async () => {
    const { prov, st } = setup();
    st.broadcastDelay = 20;
    const owners = [1, 2, 3].map((i) => `0x${String(i).repeat(40)}`);
    const rs = await Promise.all(owners.map((o, i) => prov.starter(`9.9.9.${i}`, { owner: o })));
    expect(rs.map((r) => r.code)).toEqual([200, 200, 200]);
    expect(st.maxInFlight).toBe(1);
  });
});

describe("onboard", () => {
  it("onboard twice returns the same guardian (fund called once) with a fresh proof each time", async () => {
    const { prov, st, store } = setup();
    const a = await prov.onboard(sign("onboard", {}));
    expect(a.code).toBe(200);
    const b = await prov.onboard(sign("onboard", {}));
    expect(b.code).toBe(200);
    const ab = a.body as { guardian: Hex; linkProof: any };
    const bb = b.body as { guardian: Hex; linkProof: any };
    expect(ab.guardian).toBe(guardianAcc.evm);
    expect(bb.guardian).toBe(guardianAcc.evm);
    expect(st.calls.filter((c) => c.includes(":funder:")).length).toBe(1);
    expect(st.calls.filter((c) => c.includes(":guardian:classical:")).length).toBe(1);
    expect(st.balances.get(guardianAcc.cosmos)).toBe(GUARDIAN_FUND_UQOR);
    expect(store.get(ownerAcc.evm)).toMatchObject({ stage: "provisioned", guardian: guardianAcc.evm });
    // The proof is JSON-safe hex and agrees with agentPubKeyHex.
    const p = decodeLinkProof(bb.linkProof);
    expect(p.scheme).toBe("ed25519");
    expect(toHex(p.pubkey)).toBe(bb.linkProof.agentPubKeyHex);
    expect(p.possessionProof.length).toBe(64);
    expect(JSON.stringify(a.body)).not.toContain(AGENT_SK);
    expect(JSON.stringify(a.body)).not.toContain("abandon");
  });

  it("onboard at agent capacity → 503 capacity before any guardian is made or funded; a provisioned owner still gets its proof", async () => {
    let room = false;
    const { prov, st, store } = setup({ canStart: () => room });
    expect(await prov.onboard(sign("onboard", {}))).toEqual({ code: 503, body: { error: "capacity" } });
    expect(st.calls).toEqual([]);
    expect(store.get(ownerAcc.evm)?.stage).toBe("starter");
    room = true;
    expect((await prov.onboard(sign("onboard", {}))).code).toBe(200);
    room = false;
    expect((await prov.onboard(sign("onboard", {}))).code).toBe(200);
  });

  it("secrets are written before the fund tx", async () => {
    const { prov, st, order } = setup();
    expect((await prov.onboard(sign("onboard", {}))).code).toBe(200);
    expect(order[0]).toBe("secrets");
    expect(st.secretsAtFirstBroadcast).toEqual({ GAS_MNEMONIC: GUARD_MN, AGENT_ED25519_SK: AGENT_SK });
    expect(st.calls[0]).toMatch(/^broadcast:funder:hybrid:/);
  });

  it("onboard for an owner with no starter pack → 403 no-starter, nothing written or sent", async () => {
    const { prov, st, store } = setup({ starter: false });
    expect(await prov.onboard(sign("onboard", {}))).toEqual({ code: 403, body: { error: "no-starter" } });
    // A row without the starter flag (as an earlier build wrote for a self-funded owner) is refused too.
    store.put({ owner: ownerAcc.evm as Hex, stage: "starter", createdAt: T0, lastActiveAt: T0, topups: 0 });
    expect((await prov.onboard(sign("onboard", {}))).code).toBe(403);
    expect(store.readSecrets(ownerAcc.evm)).toBeNull();
    expect(st.calls).toEqual([]);
  });

  it("onboard with an expired request → 401", async () => {
    const { prov, st } = setup();
    const r = await prov.onboard(sign("onboard", {}, { expiresAt: nowSec - 1 }));
    expect(r.code).toBe(401);
    expect(st.calls).toEqual([]);
  });

  it("a request signed for another purpose → 401", async () => {
    const { prov } = setup();
    expect((await prov.onboard(sign("topup", {}))).code).toBe(401);
  });

  it("a request signed by another key → 401", async () => {
    const { prov } = setup();
    const forged = signOwnerRequest({ owner: ownerAcc.evm as Hex, purpose: "onboard", body: {}, nonce: "x", expiresAt: nowSec + 60 }, guardianAcc.pqc.secretKey);
    expect((await prov.onboard(forged)).code).toBe(401);
  });

  it("same nonce twice → 409", async () => {
    const { prov } = setup();
    const req = sign("onboard", {});
    expect((await prov.onboard(req)).code).toBe(200);
    expect((await prov.onboard(req)).code).toBe(409);
  });

  it("a nonce can be reused after 10 minutes", async () => {
    const { prov, setNow } = setup();
    const r1 = sign("onboard", {}, { nonce: "same" });
    expect((await prov.onboard(r1)).code).toBe(200);
    setNow(T0 + 601_000);
    const r2 = signOwnerRequest({ owner: ownerAcc.evm as Hex, purpose: "onboard", body: {}, nonce: "same", expiresAt: nowSec + 601 + 60 }, ownerAcc.pqc.secretKey);
    expect((await prov.onboard(r2)).code).toBe(200);
  });

  it("malformed signed bodies → 400", async () => {
    const { prov } = setup();
    expect((await prov.onboard({})).code).toBe(400);
    expect((await prov.onboard({ request: { owner: "0x12" }, sig: "0x" })).code).toBe(400);
  });

  it("refuses with 503 funder-low when the funder cannot cover the guardian, before anything is written", async () => {
    const { prov, st, store } = setup();
    st.balances.set(funder.cosmos, 1_000_000n);
    expect(await prov.onboard(sign("onboard", {}))).toEqual({ code: 503, body: { error: "funder-low" } });
    expect(store.readSecrets(ownerAcc.evm)).toBeNull();
  });
});

describe("onboard resume", () => {
  it("a register failure keeps the secrets; the next call reuses them and does not fund twice", async () => {
    let k = 0;
    let mnemonics = 0;
    const { prov, st, store } = setup({
      failBroadcast: () => ++k === 2, // the register (2nd broadcast) is refused once
      newMnemonic: () => {
        mnemonics++;
        return GUARD_MN;
      },
    });
    const r1 = await prov.onboard(sign("onboard", {}));
    expect(r1.code).toBe(502);
    expect(JSON.stringify(r1.body)).not.toContain("abandon");
    expect(store.readSecrets(ownerAcc.evm)).not.toBeNull();
    expect(store.get(ownerAcc.evm)?.stage).not.toBe("provisioned");
    const r2 = await prov.onboard(sign("onboard", {}));
    expect(r2.code).toBe(200);
    expect(mnemonics).toBe(1);
    expect(st.calls.filter((c) => c.includes(":funder:")).length).toBe(1);
    expect(store.get(ownerAcc.evm)).toMatchObject({ stage: "provisioned", guardian: guardianAcc.evm });
  });

  it("two concurrent first calls provision one guardian", async () => {
    let mnemonics = 0;
    const { prov, st } = setup({ newMnemonic: () => (mnemonics++, GUARD_MN) });
    st.broadcastDelay = 10;
    const [a, b] = await Promise.all([prov.onboard(sign("onboard", {})), prov.onboard(sign("onboard", {}))]);
    expect([a.code, b.code]).toEqual([200, 200]);
    expect(mnemonics).toBe(1);
    expect(st.calls.filter((c) => c.includes(":funder:")).length).toBe(1);
  });
});

describe("activate", () => {
  async function provisioned(onActivated?: (o: Hex) => void, canStart?: () => boolean) {
    const ctx = setup({ onActivated, canStart });
    const r = await ctx.prov.onboard(sign("onboard", {}));
    expect(r.code).toBe(200);
    const pk = (r.body as { linkProof: { agentPubKeyHex: string } }).linkProof.agentPubKeyHex;
    return { ...ctx, pk };
  }

  it("checks the vault, link and rule on chain, then marks the owner active and hands off", async () => {
    const handed: Hex[] = [];
    const { prov, st, store, pk } = await provisioned((o) => handed.push(o));
    linkOnChain(st, pk);
    expect(await prov.activate(sign("activate", { vault: VAULT }))).toEqual({ code: 200, body: { ok: true } });
    expect(store.get(ownerAcc.evm)).toMatchObject({ stage: "active", vault: VAULT.toLowerCase(), guardian: guardianAcc.evm });
    expect(handed).toEqual([ownerAcc.evm.toLowerCase()]);
  });

  it("activate at agent capacity → 503 capacity, the owner stays provisioned and nothing is handed off", async () => {
    const handed: Hex[] = [];
    let room = true; // room at onboard time, none left by activation
    const { prov, st, store, pk } = await provisioned((o) => handed.push(o), () => room);
    room = false;
    linkOnChain(st, pk);
    expect(await prov.activate(sign("activate", { vault: VAULT }))).toEqual({ code: 503, body: { error: "capacity" } });
    expect(store.get(ownerAcc.evm)?.stage).toBe("provisioned");
    expect(handed).toEqual([]);
    room = true;
    expect((await prov.activate(sign("activate", { vault: VAULT }))).code).toBe(200);
    expect(handed).toEqual([ownerAcc.evm.toLowerCase()]);
  });

  it("activate with a vault whose guardian() differs → 409", async () => {
    const { prov, st, store, pk } = await provisioned();
    linkOnChain(st, pk);
    st.vault = { owner: ownerAcc.evm as Hex, guardian: ("0x" + "99".repeat(20)) as Hex };
    const r = await prov.activate(sign("activate", { vault: VAULT }));
    expect(r.code).toBe(409);
    expect(store.get(ownerAcc.evm)?.stage).toBe("provisioned");
  });

  it("a vault whose owner() differs → 409", async () => {
    const { prov, st, pk } = await provisioned();
    linkOnChain(st, pk);
    st.vault = { owner: ("0x" + "99".repeat(20)) as Hex, guardian: guardianAcc.evm as Hex };
    expect((await prov.activate(sign("activate", { vault: VAULT }))).code).toBe(409);
  });

  it("no live linked agent key (missing, revoked or expired) → 409", async () => {
    const { prov, st, pk } = await provisioned();
    linkOnChain(st, pk);
    st.auths = [];
    expect((await prov.activate(sign("activate", { vault: VAULT }))).code).toBe(409);
    linkOnChain(st, pk);
    st.auths[0]!.revoked = true;
    expect((await prov.activate(sign("activate", { vault: VAULT }))).code).toBe(409);
    linkOnChain(st, pk);
    st.auths[0]!.expiryUnix = BigInt(nowSec - 1);
    expect((await prov.activate(sign("activate", { vault: VAULT }))).code).toBe(409);
  });

  it("a rule that is not exactly vault.rescue + uqor → 409", async () => {
    const { prov, st, pk } = await provisioned();
    linkOnChain(st, pk);
    st.rules.rules[0]!.allowedDenoms = ["uqor", "erc20/0x" + "12".repeat(20)];
    expect((await prov.activate(sign("activate", { vault: VAULT }))).code).toBe(409);
  });

  it("activate again with the same vault → ok without a second hand-off; another vault → 409 already-active", async () => {
    const handed: Hex[] = [];
    const { prov, st, store, pk } = await provisioned((o) => handed.push(o));
    linkOnChain(st, pk);
    expect((await prov.activate(sign("activate", { vault: VAULT }))).code).toBe(200);
    expect(await prov.activate(sign("activate", { vault: VAULT.toUpperCase().replace("0X", "0x") }))).toEqual({ code: 200, body: { ok: true } });
    expect(handed.length).toBe(1);
    const other = ("0x" + "88".repeat(20)) as Hex;
    expect(await prov.activate(sign("activate", { vault: other }))).toEqual({ code: 409, body: { error: "already-active" } });
    expect(store.get(ownerAcc.evm)?.vault).toBe(VAULT.toLowerCase());
  });

  it("an RPC failure reading the vault → 502 chain-unavailable; no vault at the address → 409 vault-unreadable", async () => {
    const { prov, st, store, pk } = await provisioned();
    linkOnChain(st, pk);
    st.vault = "throw";
    expect(await prov.activate(sign("activate", { vault: VAULT }))).toEqual({ code: 502, body: { error: "chain-unavailable" } });
    st.vault = null;
    expect(await prov.activate(sign("activate", { vault: VAULT }))).toEqual({ code: 409, body: { error: "vault-unreadable" } });
    expect(store.get(ownerAcc.evm)?.stage).toBe("provisioned");
  });

  it("an owner that was never provisioned → 409; a bad vault address → 400", async () => {
    const { prov } = setup();
    expect((await prov.activate(sign("activate", { vault: VAULT }))).code).toBe(409);
    expect((await prov.activate(sign("activate", { vault: "0x12" }))).code).toBe(400);
  });
});

describe("topup", () => {
  it("sends 1 QOR once when the owner holds < 0.5 QOR", async () => {
    const { prov, st, store } = setup({ starter: false });
    expect((await prov.starter("1.1.1.1", { owner: ownerAcc.evm })).code).toBe(200);
    expect(store.get(ownerAcc.evm)?.starter).toBe(true);
    st.balances.set(ownerAcc.cosmos, 600_000n);
    expect((await prov.topup(sign("topup", {}))).code).toBe(409); // holds >= 0.5 QOR
    st.balances.set(ownerAcc.cosmos, 400_000n);
    const r = await prov.topup(sign("topup", {}));
    expect(r.code).toBe(200);
    expect(st.balances.get(ownerAcc.cosmos)).toBe(400_000n + TOPUP_UQOR);
    expect(store.get(ownerAcc.evm)?.topups).toBe(1);
    st.balances.set(ownerAcc.cosmos, 0n);
    expect((await prov.topup(sign("topup", {}))).code).toBe(409); // only one
  });

  it("two concurrent top-ups send once", async () => {
    const { prov, st } = setup({ starter: false });
    expect((await prov.starter("1.1.1.1", { owner: ownerAcc.evm })).code).toBe(200);
    st.balances.set(ownerAcc.cosmos, 0n);
    const rs = await Promise.all([prov.topup(sign("topup", {})), prov.topup(sign("topup", {}))]);
    expect(rs.map((r) => r.code).sort()).toEqual([200, 409]);
    expect(st.balances.get(ownerAcc.cosmos)).toBe(TOPUP_UQOR);
  });

  it("an unknown owner → 404", async () => {
    const { prov } = setup({ starter: false });
    expect((await prov.topup(sign("topup", {}))).code).toBe(404);
  });

  it("an owner whose row has no starter pack (onboarded only) → 403 no-starter, nothing sent", async () => {
    const { prov, st, store } = setup({ starter: false });
    store.put({ owner: ownerAcc.evm as Hex, stage: "provisioned", guardian: guardianAcc.evm as Hex, createdAt: T0, lastActiveAt: T0, topups: 0 });
    st.balances.set(ownerAcc.cosmos, 0n);
    expect(await prov.topup(sign("topup", {}))).toEqual({ code: 403, body: { error: "no-starter" } });
    expect(st.calls).toEqual([]);
  });

  it("the normal path starter → onboard → topup works", async () => {
    const { prov, st, store } = setup({ starter: false });
    expect((await prov.starter("1.1.1.1", { owner: ownerAcc.evm })).code).toBe(200);
    expect((await prov.onboard(sign("onboard", {}))).code).toBe(200);
    expect(store.get(ownerAcc.evm)).toMatchObject({ stage: "provisioned", starter: true });
    st.balances.set(ownerAcc.cosmos, 0n);
    expect((await prov.topup(sign("topup", {}))).code).toBe(200);
  });
});

describe("hosted routes", () => {
  const listen = (s: Server) => new Promise<string>((r) => s.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
  const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  async function serve(trustProxy: boolean) {
    const ctx = setup({ starter: false });
    const srv = createHostedServer({
      distDir: mkdtempSync(join(tmpdir(), "d-")), restUrl: "http://127.0.0.1:1", rpcUrl: "http://127.0.0.1:1",
      store: ctx.store, status: ctx.prov.status, provision: ctx.prov, trustProxy,
    });
    return { ...ctx, srv, base: await listen(srv) };
  }

  it("/api/status says paused with funder-low", async () => {
    const { st, srv, base, setNow } = await serve(false);
    expect(await (await fetch(`${base}/api/status`)).json()).toEqual({ onboarding: "open", activeGuardians: 0 });
    st.balances.set(funder.cosmos, 19_900_000n);
    setNow(T0 + 11_000); // past the 10 s status cache
    expect(await (await fetch(`${base}/api/status`)).json()).toEqual({ onboarding: "paused", reason: "funder-low", activeGuardians: 0 });
    srv.close();
  });

  it("POST /api/starter, /api/onboard and /api/activate go through the provisioner", async () => {
    const { st, srv, base } = await serve(false);
    const s = await post(base, "/api/starter", { owner: ownerAcc.evm });
    expect(s.status).toBe(200);
    expect(await s.json()).toEqual({ tx: "TX1" });
    const o = await post(base, "/api/onboard", sign("onboard", {}));
    expect(o.status).toBe(200);
    const body = (await o.json()) as { guardian: string; linkProof: { agentPubKeyHex: string } };
    expect(body.guardian).toBe(guardianAcc.evm);
    linkOnChain(st, body.linkProof.agentPubKeyHex);
    const a = await post(base, "/api/activate", sign("activate", { vault: VAULT }));
    expect(await a.json()).toEqual({ ok: true });
    const exp = await post(base, "/api/onboard", sign("onboard", {}, { expiresAt: nowSec - 5 }));
    expect(exp.status).toBe(401);
    expect((await post(base, "/api/starter", "not json")).status).toBe(400);
    expect((await fetch(`${base}/api/starter`, { method: "POST", body: "{" })).status).toBe(400);
    srv.close();
  });

  it("clientIp: the socket address, or with TRUST_PROXY the right-most X-Forwarded-For entry", () => {
    const req = (xff?: string | string[]) => ({ headers: xff ? { "x-forwarded-for": xff } : {}, socket: { remoteAddress: "127.0.0.1" } }) as never;
    expect(clientIp(req("1.1.1.1, 9.9.9.9"), false)).toBe("127.0.0.1");
    expect(clientIp(req("1.1.1.1, 9.9.9.9"), true)).toBe("9.9.9.9");
    expect(clientIp(req("9.9.9.9"), true)).toBe("9.9.9.9");
    expect(clientIp(req(["1.1.1.1", "2.2.2.2, 8.8.8.8"]), true)).toBe("8.8.8.8");
    expect(clientIp(req(), true)).toBe("127.0.0.1");
  });

  it("forged first X-Forwarded-For entries do not dodge the per-IP cap", async () => {
    for (const trust of [false, true]) {
      const { srv, base } = await serve(trust);
      for (let i = 1; i <= 4; i++) {
        const r = await post(base, "/api/starter", { owner: `0x${String(i).repeat(40)}` }, { "x-forwarded-for": `203.0.113.${i}, 9.9.9.9` });
        // Untrusted: every request is 127.0.0.1. Trusted: every request is 9.9.9.9 (the hop the proxy appended).
        expect(r.status).toBe(i === 4 ? 429 : 200);
      }
      srv.close();
    }
  });

  it("with TRUST_PROXY, different proxy-appended entries count as different IPs", async () => {
    const { srv, base } = await serve(true);
    for (let i = 1; i <= 4; i++) {
      const r = await post(base, "/api/starter", { owner: `0x${String(i).repeat(40)}` }, { "x-forwarded-for": `1.1.1.1, 203.0.113.${i}` });
      expect(r.status).toBe(200);
    }
    srv.close();
  });

  it("refuses a body over 64 KB with 413", async () => {
    const { srv, base } = await serve(false);
    expect((await post(base, "/api/onboard", { pad: "x".repeat(70_000) })).status).toBe(413);
    srv.close();
  });

  it("without a provisioner the provisioning routes answer 503", async () => {
    const store = createStore(mkdtempSync(join(tmpdir(), "hs-")));
    const srv = createHostedServer({
      distDir: mkdtempSync(join(tmpdir(), "d-")), restUrl: "http://127.0.0.1:1", rpcUrl: "http://127.0.0.1:1", store,
      status: () => ({ onboarding: "paused", reason: "no-funder", activeGuardians: 0 }),
    });
    const base = await listen(srv);
    expect((await post(base, "/api/starter", { owner: ownerAcc.evm })).status).toBe(503);
    srv.close();
  });
});


describe("refundGuardian", () => {
  it("tops a swept guardian back up to 1 QOR from the funder, once", async () => {
    const { prov, st } = setup();
    expect((await prov.onboard(sign("onboard", {}))).code).toBe(200);
    // Retirement swept it down to the 0.3 QOR reserve.
    st.balances.set(guardianAcc.cosmos, 300_000n);
    const funderBefore = st.balances.get(funder.cosmos)!;
    const tx = await prov.refundGuardian(ownerAcc.evm as Hex);
    expect(tx).toMatch(/^TX/);
    expect(st.balances.get(guardianAcc.cosmos)).toBe(GUARDIAN_FUND_UQOR);
    expect(st.balances.get(funder.cosmos)).toBe(funderBefore - 700_000n);
    expect(st.calls.at(-1)).toBe("broadcast:funder:hybrid:qlifeboat: re-fund guardian");
    expect(await prov.refundGuardian(ownerAcc.evm as Hex)).toBeNull();
  });

  it("refuses an owner with no guardian and a funder too low to pay", async () => {
    const { prov, st } = setup();
    await expect(prov.refundGuardian(ownerAcc.evm as Hex)).rejects.toThrow(/not-provisioned/);
    expect((await prov.onboard(sign("onboard", {}))).code).toBe(200);
    st.balances.set(guardianAcc.cosmos, 0n);
    st.balances.set(funder.cosmos, 1_000_000n);
    await expect(prov.refundGuardian(ownerAcc.evm as Hex)).rejects.toThrow(/funder-low/);
  });
});

describe("refillOnArm (on-demand guardians spend ~0.225 QOR per session)", () => {
  async function provisioned() {
    const ctx = setup();
    expect((await ctx.prov.onboard(sign("onboard", {}))).code).toBe(200);
    return ctx;
  }

  it("below 0.5 QOR: tops the guardian back up to 1 QOR from the funder", async () => {
    const { prov, st } = await provisioned();
    st.balances.set(guardianAcc.cosmos, 291_400n);
    const r = await prov.refillOnArm(ownerAcc.evm as Hex);
    expect(r).toMatchObject({ tx: expect.stringMatching(/^TX/) });
    expect(st.balances.get(guardianAcc.cosmos)).toBe(GUARDIAN_FUND_UQOR);
    expect(st.calls.at(-1)).toBe("broadcast:funder:hybrid:qlifeboat: refill guardian");
  });

  it("at or above 0.5 QOR: nothing sent", async () => {
    const { prov, st } = await provisioned();
    st.balances.set(guardianAcc.cosmos, 500_000n);
    const before = st.calls.length;
    expect(await prov.refillOnArm(ownerAcc.evm as Hex)).toEqual({ skipped: "enough" });
    expect(st.calls.length).toBe(before);
  });

  it("at most 3 refills per owner per UTC day; the next day allows more", async () => {
    const { prov, st, setNow } = await provisioned();
    for (let i = 0; i < 3; i++) {
      st.balances.set(guardianAcc.cosmos, 100_000n);
      expect(await prov.refillOnArm(ownerAcc.evm as Hex)).toMatchObject({ tx: expect.any(String) });
    }
    st.balances.set(guardianAcc.cosmos, 100_000n);
    expect(await prov.refillOnArm(ownerAcc.evm as Hex)).toEqual({ skipped: "daily-cap" });
    setNow(T0 + 24 * 3600 * 1000);
    expect(await prov.refillOnArm(ownerAcc.evm as Hex)).toMatchObject({ tx: expect.any(String) });
  });

  it("not below the funder floor (20 QOR): the starter packs keep priority", async () => {
    const { prov, st } = await provisioned();
    st.balances.set(guardianAcc.cosmos, 100_000n);
    st.balances.set(funder.cosmos, 19_999_999n);
    expect(await prov.refillOnArm(ownerAcc.evm as Hex)).toEqual({ skipped: "funder-low" });
  });

  it("a refill never takes the funder below its floor (amount and fee reserve counted)", async () => {
    const { prov, st } = await provisioned();
    st.balances.set(guardianAcc.cosmos, 100_000n);
    st.balances.set(funder.cosmos, 20_400_000n); // above the floor, but not by the 0.9 QOR refill + fee reserve
    expect(await prov.refillOnArm(ownerAcc.evm as Hex)).toEqual({ skipped: "funder-low" });
  });

  it("all owners together get at most REFILLS_GLOBAL_PER_DAY refills per UTC day", async () => {
    const { prov, st, store } = await provisioned();
    const day = Math.floor(T0 / (24 * 3600 * 1000));
    // Other owners already used the day's budget.
    for (let i = 1; i <= REFILLS_GLOBAL_PER_DAY; i++) {
      store.put({ owner: `0x${i.toString(16).padStart(40, "0")}` as Hex, stage: "active", createdAt: T0, lastActiveAt: T0, topups: 0, refills: { day, n: 1 } });
    }
    st.balances.set(guardianAcc.cosmos, 100_000n);
    expect(await prov.refillOnArm(ownerAcc.evm as Hex)).toEqual({ skipped: "daily-cap" });
  });

  it("two arms at once refill once", async () => {
    const { prov, st } = await provisioned();
    st.balances.set(guardianAcc.cosmos, 100_000n);
    const before = st.calls.filter((c) => c.includes("refill guardian")).length;
    await Promise.all([prov.refillOnArm(ownerAcc.evm as Hex), prov.refillOnArm(ownerAcc.evm as Hex)]);
    expect(st.calls.filter((c) => c.includes("refill guardian")).length).toBe(before + 1);
  });

  it("an owner with no guardian is skipped", async () => {
    const { prov } = setup();
    expect(await prov.refillOnArm(ownerAcc.evm as Hex)).toEqual({ skipped: "not-provisioned" });
  });
});

describe("status at capacity", () => {
  it("pauses onboarding with reason capacity once 40 owners are active and not stopped", async () => {
    const { prov, store, setNow } = setup();
    const seed = (i: number, over: Record<string, unknown> = {}) =>
      store.put({ owner: `0x${i.toString(16).padStart(40, "0")}` as Hex, stage: "active", createdAt: T0, lastActiveAt: T0, topups: 0, ...over });
    for (let i = 1; i <= 39; i++) seed(i);
    seed(100, { stopped: true }); // a stopped owner runs no agent
    seed(101, { stage: "retired" });
    expect(await prov.status()).toMatchObject({ onboarding: "open" });
    seed(40);
    setNow(T0 + 11_000); // past the 10 s status cache
    expect(await prov.status()).toEqual({ onboarding: "paused", reason: "capacity", activeGuardians: 41 });
  });

  it("follows a configured cap (HOSTED_MAX_AGENTS)", async () => {
    const { prov, store } = setup({ maxAgents: 2 });
    for (let i = 1; i <= 2; i++) store.put({ owner: `0x${i.toString(16).padStart(40, "0")}` as Hex, stage: "active", createdAt: T0, lastActiveAt: T0, topups: 0 });
    expect(await prov.status()).toEqual({ onboarding: "paused", reason: "capacity", activeGuardians: 2 });
  });
});
