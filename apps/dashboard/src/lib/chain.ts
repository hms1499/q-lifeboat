import { NETWORK } from "@qday/core";
import { evmWindowStatus, toQorAddress, type EvmWindow } from "@qorechain/evm/window";
import { fetchAuthenticators, fetchPqcStatus, fetchSpendingRules, type AuthenticatorView, type PqcStatus, type SpendingRules } from "@qorechain/sdk";
import { createPublicClient, defineChain, http, type Hex } from "viem";
import type { ReceiptLike } from "./verify";

/**
 * Browser reads. diana REST sends no CORS headers, so REST goes through the dev/preview server's same-origin proxy
 * (vite.config.ts); the EVM RPC allows any origin and is called direct.
 */
export const REST_PROXY_PATH = "/qore-rest";

export function restBase(): string {
  return new URL(REST_PROXY_PATH, window.location.origin).href.replace(/\/+$/, "");
}

export const EXPLORER = "https://explore.qore.network";
export const explorerTx = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const explorerAddress = (address: string) => `${EXPLORER}/address/${address}`;

export const diana = defineChain({
  id: NETWORK.evmChainId,
  name: "QoreChain diana testnet",
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [NETWORK.evmRpc] } },
  blockExplorers: { default: { name: "QoreChain Explorer", url: EXPLORER } },
  testnet: true,
});

/** `cacheTime: 0`: viem would otherwise cache the block number for 4 s on a chain without `blockTime`. */
export const publicClient = createPublicClient({ chain: diana, transport: http(NETWORK.evmRpc, { batch: true }), cacheTime: 0 });

export const qorAddress = (evm: string) => toQorAddress(evm);

export function readWindow(address: string): Promise<EvmWindow> {
  return evmWindowStatus({ rest: restBase(), address: address.startsWith("0x") ? toQorAddress(address) : address });
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** diana's abstractaccount REST answers this 404 for an account that never linked a key (chain fact 15): read as none. */
export function isAccountNotFound(e: unknown, address: string): boolean {
  return e instanceof Error && new RegExp(`^abstractaccount query failed: HTTP 404 from \\S+: account ${escape(address)} not found$`).test(e.message);
}

export async function readAuthenticators(ownerEvm: string): Promise<AuthenticatorView[]> {
  const address = toQorAddress(ownerEvm);
  try {
    return await fetchAuthenticators({ rest: restBase(), address });
  } catch (e) {
    if (isAccountNotFound(e, address)) return [];
    throw e;
  }
}

export async function readSpendingRules(ownerEvm: string): Promise<SpendingRules> {
  const address = toQorAddress(ownerEvm);
  try {
    return await fetchSpendingRules({ rest: restBase(), address });
  } catch (e) {
    if (isAccountNotFound(e, address)) return { rules: [], authenticatorRules: [] };
    throw e;
  }
}

export function readPqcStatus(ownerEvm: string): Promise<PqcStatus> {
  return fetchPqcStatus({ rest: restBase(), address: toQorAddress(ownerEvm) });
}

/** Receipts never change once mined: cache the found ones (a missing one is asked again next time). */
const receipts = new Map<string, ReceiptLike>();

export async function readReceipt(hash: Hex): Promise<ReceiptLike | null> {
  const key = hash.toLowerCase();
  const hit = receipts.get(key);
  if (hit) return hit;
  try {
    const r = await publicClient.getTransactionReceipt({ hash });
    const out: ReceiptLike = { status: r.status, to: r.to, blockNumber: r.blockNumber, logs: r.logs.map((l) => ({ address: l.address, topics: l.topics, data: l.data })) };
    receipts.set(key, out);
    return out;
  } catch (e) {
    if (e instanceof Error && e.name === "TransactionReceiptNotFoundError") return null;
    throw e;
  }
}
