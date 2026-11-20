import { describe, expect, it, vi } from "vitest";
import { fetchOwnerAuthenticators, fetchOwnerSpendingRules, isAccountNotFound } from "../src/abstractaccount";

const ADDR = "qor1pt4kd2d6fgumfdfnnwe9jrnylfnwn5z223sypr";
const OTHER = "qor1apchfrqfyf694k2dqedr3r54a3pq5eltmjxxpv";

/** A fetch answering like diana's REST gateway. */
const answer = (status: number, body: unknown) =>
  vi.fn(async (_url: string) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
/** What diana returns for an account that never linked a key (seen on run 20261120T141722Z). */
const notFound = (addr = ADDR) => answer(404, { code: 5, message: `account ${addr} not found`, details: [] });

describe("fetchOwnerAuthenticators", () => {
  it("treats diana's 404 'account <owner> not found' (never linked yet) as zero authenticators", async () => {
    const fetch = notFound();
    expect(await fetchOwnerAuthenticators(ADDR, fetch)).toEqual([]);
    expect(fetch.mock.calls[0][0]).toContain(`/accounts/${ADDR}/authenticators`);
  });

  it("returns the authenticators when the account exists", async () => {
    const fetch = answer(200, { authenticators: [{ scheme: "ed25519", pubkey_hex: "ab", permissions: ["evm"], expiry_unix: "9", revoked: false }] });
    expect(await fetchOwnerAuthenticators(ADDR, fetch)).toMatchObject([{ pubkeyHex: "ab", revoked: false, expiryUnix: 9n }]);
  });

  it("still throws on any other failure: another 404, a 404 for another account, a 500", async () => {
    await expect(fetchOwnerAuthenticators(ADDR, answer(404, { code: 5, message: "Not Found" }))).rejects.toThrow(/HTTP 404/);
    await expect(fetchOwnerAuthenticators(ADDR, answer(404, "<html>404 page not found</html>"))).rejects.toThrow(/HTTP 404/);
    await expect(fetchOwnerAuthenticators(ADDR, notFound(OTHER))).rejects.toThrow(/HTTP 404/);
    await expect(fetchOwnerAuthenticators(ADDR, answer(500, { code: 2, message: `account ${ADDR} not found` }))).rejects.toThrow(/HTTP 500/);
    await expect(fetchOwnerAuthenticators(ADDR, answer(503, "down"))).rejects.toThrow(/HTTP 503/);
  });
});

describe("fetchOwnerSpendingRules", () => {
  it("treats the same 404 as no rules, and throws on anything else", async () => {
    expect(await fetchOwnerSpendingRules(ADDR, notFound())).toEqual({ rules: [], authenticatorRules: [] });
    await expect(fetchOwnerSpendingRules(ADDR, answer(500, "boom"))).rejects.toThrow(/HTTP 500/);
  });
});

describe("isAccountNotFound", () => {
  it("matches only the abstractaccount 404 for that exact account", () => {
    const msg = (status: number, addr: string) =>
      new Error(`abstractaccount query failed: HTTP ${status} from https://x/qorechain/abstractaccount/v1/accounts/${addr}/authenticators: account ${addr} not found`);
    expect(isAccountNotFound(msg(404, ADDR), ADDR)).toBe(true);
    expect(isAccountNotFound(msg(404, OTHER), ADDR)).toBe(false);
    expect(isAccountNotFound(msg(500, ADDR), ADDR)).toBe(false);
    expect(isAccountNotFound(new Error(`auth_nonce query failed: HTTP 404 from https://x: account ${ADDR} not found`), ADDR)).toBe(false);
    expect(isAccountNotFound("account not found", ADDR)).toBe(false);
  });
});
