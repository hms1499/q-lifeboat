/** QoreChain diana testnet endpoints. */
export const NETWORK = {
  chainId: "qorechain-diana",
  evmChainId: 9800,
  rest: "https://api-testnet.qore.host",
  rpc: "https://rpc-testnet.qore.host",
  evmRpc: "https://evm-testnet.qore.host",
} as const;

/** Gas limit for `vault.withdraw` (CLI and dashboard). diana bills at least half of it (chain fact 5). */
export const WITHDRAW_GAS = 1_000_000n;

type Env = Record<string, string | undefined>;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function readAddress(env: Env, name: string): `0x${string}` {
  const raw = env[name]?.trim();
  if (!raw) throw new Error(`${name} is not set`);
  if (!ADDRESS_RE.test(raw)) throw new Error(`${name} must be a 0x-prefixed 20-byte address`);
  return raw as `0x${string}`;
}

/** The deployed GuardianVault address, from VAULT_ADDRESS. */
export function loadVault(env: Env = process.env): `0x${string}` {
  return readAddress(env, "VAULT_ADDRESS");
}

export type TokenSymbol = "fUSD" | "fETH" | "fBTC";

/** The faucet test tokens (contracts/src/TestToken.sol), from FUSD_ADDRESS / FETH_ADDRESS / FBTC_ADDRESS. */
export function loadTokens(env: Env = process.env): Record<TokenSymbol, `0x${string}`> {
  return {
    fUSD: readAddress(env, "FUSD_ADDRESS"),
    fETH: readAddress(env, "FETH_ADDRESS"),
    fBTC: readAddress(env, "FBTC_ADDRESS"),
  };
}
