import { APPROVE_GAS, buildGuardianLinkMsgs, loadAgentKey, loadOwner, loadTokens, loadVault, type TokenSymbol } from "@qday/core";
import { evmWindowCost } from "@qorechain/evm";
import { openEvmWindowMsg } from "@qorechain/sdk";
import { createWalletClient, erc20Abi, http, maxUint256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { fetchOwnerAuthenticators } from "./abstractaccount";
import { broadcast, chain, publicClient } from "./chain";

type Env = Record<string, string | undefined>;
type Tokens = { fUSD: Hex; fETH: Hex; fBTC: Hex };

export const WINDOW_BLOCKS = 600;
export const WINDOW_MAX_TXS = 10;
/** The tokens `setup` approves to the vault, one EVM tx each inside the window above. */
export const APPROVED_TOKENS: readonly TokenSymbol[] = ["fUSD", "fETH", "fBTC"];
// The builders live in @qday/core (browser-safe); these re-exports keep the CLI's import paths.
export { AGENT_TTL_SECONDS, buildGuardianLinkMsgs, buildSetupRule, selectLinkMsgs } from "@qday/core";

/** Parameters of the EVM window the owner opens: scoped to the three tokens and the vault. */
export function buildWindowParams(ownerCosmos: string, tokens: Tokens, vault: string) {
  const perTx = evmWindowCost({ gas: 3_000_000n, maxFeePerGas: 112_500_000_000n });
  return {
    sender: ownerCosmos,
    blocks: WINDOW_BLOCKS,
    maxTxs: WINDOW_MAX_TXS,
    maxValue: (perTx * BigInt(WINDOW_MAX_TXS)).toString(),
    allowedTargets: [tokens.fUSD, tokens.fETH, tokens.fBTC, vault],
  };
}

/** `pnpm cli setup`: hybrid tx (window + link), then token approvals. */
export async function runSetup(env: Env = process.env): Promise<void> {
  const owner = await loadOwner(env);
  const vault = loadVault(env);
  const tokens = loadTokens(env);
  const agent = loadAgentKey(env);

  // Fail before broadcasting anything if a configured token address has no contract code.
  for (const [symbol, address] of Object.entries(tokens)) {
    const code = await publicClient.getCode({ address: address as Hex });
    if (!code || code === "0x") throw new Error(`${symbol} (${address}) has no contract code on diana`);
  }

  // A fresh owner has no abstractaccount record until this first link: that 404 means "no keys linked".
  const existing = await fetchOwnerAuthenticators(owner.cosmos);
  const linkMsgs = buildGuardianLinkMsgs(owner, vault, agent, existing);

  const window = openEvmWindowMsg(buildWindowParams(owner.cosmos, tokens, vault));
  const hash = await broadcast(owner, [window, ...linkMsgs], "qday: open window + link guardian");
  console.log(`window + link (${linkMsgs.length} link msg): ${hash}`);

  // Approvals are ECDSA EVM txs and cannot ride in the hybrid cosmos tx. They need the window opened above.
  const wallet = createWalletClient({ account: privateKeyToAccount(owner.privateKey as Hex), chain, transport: http() });
  for (const symbol of APPROVED_TOKENS) {
    const address = tokens[symbol];
    const tx = await wallet.writeContract({
      address: address as Hex,
      abi: erc20Abi,
      functionName: "approve",
      args: [vault, maxUint256],
      gas: APPROVE_GAS,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: tx });
    if (receipt.status !== "success") throw new Error(`approve ${symbol} failed (tx ${tx})`);
    console.log(`approve ${symbol}: ${tx}`);
  }
}
