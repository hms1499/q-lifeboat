import { NETWORK } from "@qday/core";
import { StargateClient } from "@cosmjs/stargate";
import { EthNativeSigner, type UnifiedAccount } from "@qorechain/sdk";
import { createPublicClient, defineChain, http } from "viem";

export const chain = defineChain({
  id: NETWORK.evmChainId,
  name: NETWORK.chainId,
  nativeCurrency: { name: "QOR", symbol: "QOR", decimals: 18 },
  rpcUrls: { default: { http: [NETWORK.evmRpc] } },
});

export const publicClient = createPublicClient({ chain, transport: http() });

/** JSON.stringify replacer that renders bigint as a decimal string. */
export const bigintReplacer = (_: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

export async function getJson(path: string): Promise<any | null> {
  const r = await fetch(`${NETWORK.rest}${path}`);
  return r.status === 200 ? r.json() : null;
}

/** Native uqor balance of a bech32 account. */
export async function uqorBalance(cosmos: string): Promise<bigint> {
  const j = await getJson(`/cosmos/bank/v1beta1/balances/${cosmos}`);
  const coin = j?.balances?.find((c: { denom: string }) => c.denom === "uqor");
  return BigInt(coin?.amount ?? "0");
}

const HYBRID_GAS_LIMIT = 1_500_000;

/**
 * Sign (hybrid: secp256k1 + ML-DSA-87) and broadcast cosmos messages with a fixed gas limit,
 * fee 0.15 uqor per gas. Fails loudly when the chain refuses the tx. Returns the tx hash.
 */
export async function broadcast(acc: UnifiedAccount, messages: any[], memo: string): Promise<string> {
  const a = await getJson(`/cosmos/auth/v1beta1/accounts/${acc.cosmos}`);
  const base = a?.account?.base_account ?? a?.account ?? {};
  const signer = new EthNativeSigner(acc, { signMode: "hybrid", rest: NETWORK.rest });
  const transport = await StargateClient.connect(NETWORK.rpc);
  const req = {
    chainId: NETWORK.chainId,
    accountNumber: BigInt(base.account_number ?? 0),
    sequence: BigInt(base.sequence ?? 0),
    memo,
    messages,
  };
  try {
    // EthNativeSigner has no simulate() in @qorechain/sdk 0.14.0, so use a fixed limit (the spike's effective value, plus headroom).
    const gasLimit = HYBRID_GAS_LIMIT;
    const fee = { amount: [{ denom: "uqor", amount: String(Math.ceil(gasLimit * 0.15)) }], gas: String(gasLimit) };
    const res = await signer.signAndBroadcast(transport, { ...req, fee });
    if (res.code) throw new Error(`tx ${res.transactionHash} refused, code ${res.code}: ${res.rawLog}`);
    return res.transactionHash;
  } finally {
    transport.disconnect();
  }
}
