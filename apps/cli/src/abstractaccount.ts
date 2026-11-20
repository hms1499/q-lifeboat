import { NETWORK } from "@qday/core";
import { fetchAuthenticators, fetchSpendingRules, type AuthenticatorView, type FetchLike, type SpendingRules } from "@qorechain/sdk";

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * True only for the abstractaccount REST 404 diana returns for an account that has never linked a key:
 * `abstractaccount query failed: HTTP 404 from <url>: account <address> not found` (run 20261120T141722Z).
 * Any other status, message or account is a real failure.
 */
export function isAccountNotFound(e: unknown, address: string): boolean {
  if (!(e instanceof Error)) return false;
  const re = new RegExp(`^abstractaccount query failed: HTTP 404 from \\S+: account ${escape(address)} not found$`);
  return re.test(e.message);
}

async function orEmptyIfNoAccount<T>(read: Promise<T>, address: string, empty: T): Promise<T> {
  try {
    return await read;
  } catch (e) {
    if (isAccountNotFound(e, address)) return empty;
    throw e;
  }
}

/** The account's linked keys; none for a fresh account that has no abstractaccount record yet. */
export function fetchOwnerAuthenticators(address: string, fetch?: FetchLike): Promise<AuthenticatorView[]> {
  return orEmptyIfNoAccount(fetchAuthenticators({ rest: NETWORK.rest, address, fetch }), address, []);
}

/** The account's spending rules; none for a fresh account that has no abstractaccount record yet. */
export function fetchOwnerSpendingRules(address: string, fetch?: FetchLike): Promise<SpendingRules> {
  return orEmptyIfNoAccount(fetchSpendingRules({ rest: NETWORK.rest, address, fetch }), address, { rules: [], authenticatorRules: [] });
}
