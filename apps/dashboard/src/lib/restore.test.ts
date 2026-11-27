import { generatePqcRecoveryCode } from "@qorechain/sdk";
import { getContractAddress, zeroAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { findOwnerVault, parseRecoveryTxt, restoreChecks, signedFile, sponsorBody } from "./restore";
import { formatRecoveryCode } from "./setup";

const OWNER = "0x1111111111111111111111111111111111111111" as Hex;
const OTHER = "0x2222222222222222222222222222222222222222" as Hex;
const VAULT = "0x3333333333333333333333333333333333333333" as Hex;
const TOKEN = "0x4444444444444444444444444444444444444444" as Hex;

const bytes = (n: number, v = 7) => new Uint8Array(n).fill(v);
const status = (over: Record<string, unknown> = {}) => ({ registered: true, possessionProven: true, pubkey: bytes(2592), ...over }) as never;

const code = generatePqcRecoveryCode();
const file = [
  "Q-Lifeboat recovery code (diana testnet)",
  `Account: ${OWNER}`,
  "",
  formatRecoveryCode(code),
  "",
  "This code makes the key that signs withdrawals from your vault.",
].join("\n");

describe("parseRecoveryTxt", () => {
  it("reads the account and the code from the downloaded file", () => {
    const r = parseRecoveryTxt(file);
    expect(r.account).toBe(OWNER);
    expect(r.code).toHaveLength(56);
    expect(r.code.startsWith("QRC1")).toBe(false);
  });
  it("refuses a file without an account line", () => {
    expect(() => parseRecoveryTxt("QRC1-ABCD")).toThrow(/no "Account/);
  });
  it("refuses a file without a code", () => {
    expect(() => parseRecoveryTxt(`Account: ${OWNER}`)).toThrow(/no QRC1/);
  });
  it("refuses a malformed code", () => {
    expect(() => parseRecoveryTxt(`Account: ${OWNER}\nQRC1-AAAA-BBBB`)).toThrow(/malformed/);
  });
  it("refuses an HTML file renamed .txt", () => {
    expect(() => parseRecoveryTxt("<html><body>nope</body></html>")).toThrow();
  });
});

describe("restoreChecks", () => {
  const derived = bytes(2592);
  it("passes when the code's key is the registered one and the vault names the account", () => {
    const c = restoreChecks({ account: OWNER, derived, status: status(), roles: { owner: OWNER } });
    expect(c.map((x) => x.status)).toEqual(["pass", "pass", "pass"]);
  });
  it("fails when the account has no key", () => {
    const c = restoreChecks({ account: OWNER, derived, status: status({ registered: false }), roles: { owner: OWNER } });
    expect(c.find((x) => x.id === "key")?.status).toBe("fail");
    expect(c.find((x) => x.id === "key")?.detail).toMatch(/no ML-DSA-87 key/);
  });
  it("fails when the code belongs to another account", () => {
    const c = restoreChecks({ account: OWNER, derived: bytes(2592, 9), status: status(), roles: { owner: OWNER } });
    expect(c.find((x) => x.id === "key")?.status).toBe("fail");
    expect(c.find((x) => x.id === "key")?.detail).toMatch(/not the key registered/);
  });
  it("fails when the vault's owner is someone else", () => {
    const c = restoreChecks({ account: OWNER, derived, status: status(), roles: { owner: OTHER } });
    expect(c.find((x) => x.id === "account")?.status).toBe("fail");
    expect(c.find((x) => x.id === "account")?.detail).toContain(OTHER);
  });
  it("fails both vault checks when there is no vault", () => {
    const c = restoreChecks({ account: OWNER, derived, status: status(), roles: null });
    expect(c.find((x) => x.id === "vault")?.status).toBe("fail");
    expect(c.find((x) => x.id === "account")?.status).toBe("fail");
  });
});

describe("findOwnerVault", () => {
  const rolesFor = (map: Record<string, { owner: Hex; guardian: Hex } | null>) => (a: Hex) => Promise.resolve(map[a.toLowerCase()] ?? null);
  it("uses the known address first when it belongs to the account", async () => {
    const r = await findOwnerVault(OWNER, { txCount: () => Promise.resolve(0), roles: rolesFor({ [VAULT]: { owner: OWNER, guardian: OTHER } }) }, VAULT);
    expect(r?.address).toBe(VAULT);
  });
  it("skips a known contract of another owner and probes creation addresses", async () => {
    const probe = getContractAddress({ from: OWNER, nonce: 0n });
    const r = await findOwnerVault(
      OWNER,
      { txCount: () => Promise.resolve(1), roles: rolesFor({ [VAULT]: { owner: OTHER, guardian: OTHER }, [probe.toLowerCase()]: { owner: OWNER, guardian: OTHER } }) },
      VAULT,
    );
    expect(r?.address).toBe(probe);
  });
  it("returns null past the nonce cap", async () => {
    const r = await findOwnerVault(OWNER, { txCount: () => Promise.resolve(0), roles: rolesFor({}) }, null);
    expect(r).toBeNull();
  });
  it("propagates a failed read instead of reporting no vault", async () => {
    await expect(findOwnerVault(OWNER, { txCount: () => Promise.reject(new Error("rpc down")), roles: rolesFor({}) })).rejects.toThrow(/rpc down/);
  });
});

describe("signed file and sponsor body", () => {
  const w = { vault: VAULT, to: OWNER, token: TOKEN, amount: 10n ** 18n, nonce: 3n, sig: `0x${"ab".repeat(4627)}` } as const;
  it("writes the six fields with decimal bigints", () => {
    const o = JSON.parse(signedFile(w));
    expect(Object.keys(o).sort()).toEqual(["amount", "nonce", "sig", "to", "token", "vault"]);
    expect(o.amount).toBe("1000000000000000000");
    expect(o.nonce).toBe("3");
  });
  it("adds the owner for the sponsored submit", () => {
    const b = sponsorBody(w, OWNER);
    expect(Object.keys(b).sort()).toEqual(["amount", "nonce", "owner", "sig", "to", "token", "vault"]);
    expect(b.owner).toBe(OWNER);
    expect(b.vault).toBe(VAULT);
  });
  it("never signs the zero address by accident in these fixtures", () => {
    expect(w.to).not.toBe(zeroAddress);
  });
});
