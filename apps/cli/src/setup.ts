import { loadAgentKey, loadOwner, loadTokens, loadVault, NETWORK, RESCUE_SELECTOR } from "@qday/core";
import { evmWindowCost } from "@qorechain/evm";
import {
  fetchAuthenticators,
  linkAuthenticatorMsgs,
  openEvmWindowMsg,
  signAuthenticatorLinkEd25519,
  type AuthenticatorView,
  type SpendingRuleInput,
} from "@qorechain/sdk";
import { createWalletClient, erc20Abi, http, maxUint256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { broadcast, chain, publicClient } from "./chain";

type Env = Record<string, string | undefined>;
type Tokens = { fUSD: Hex; fETH: Hex; fBTC: Hex };

export const WINDOW_BLOCKS = 600;
export const WINDOW_MAX_TXS = 10;
const APPROVE_GAS = 100_000n;
const AGENT_TTL_SECONDS = 7 * 24 * 3600;
const EXPIRY_MARGIN_SECONDS = 60;

/** Per-token cap (1000e18) on what the agent key can move per tx and per day. */
export const RESCUE_CAP = "1000000000000000000000";

/**
 * The agent's spending rule. It may call exactly `vault.rescue`. Since chain v3.2.2 a call that moves an
 * ERC-20 out of the account is refused unless the rule lists that token, so the three rescued tokens are
 * listed, each with an explicit non-zero cap (a zero or empty limit would mean NO limit).
 */
export function buildSetupRule(vault: string, tokens: Tokens) {
  const denoms = [tokens.fUSD, tokens.fETH, tokens.fBTC].map((a) => `erc20/${a.toLowerCase()}`);
  const rule = {
    id: "guardian",
    enabled: true,
    perTxLimit: "1000000",
    dailyLimit: "3000000",
    allowedDenoms: ["uqor", ...denoms],
    allowedEvmCalls: [`${vault.toLowerCase()}/${RESCUE_SELECTOR}`],
    denomLimits: denoms.map((denom) => ({ denom, perTxLimit: RESCUE_CAP, dailyLimit: RESCUE_CAP })),
  } satisfies SpendingRuleInput;
  return rule;
}

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

const norm = (hex: string) => hex.replace(/^0x/i, "").toLowerCase();

/**
 * Pick the link messages to send. `linkAuthenticatorMsgs` returns [MsgUpdateSpendingRules, MsgRegisterAuthenticator].
 * When the agent key is already linked and not revoked, only the rules update is needed (rules live on the
 * account, not on the key).
 */
export function selectLinkMsgs<T extends { typeUrl: string }>(
  allMsgs: T[],
  authenticators: Pick<AuthenticatorView, "pubkeyHex" | "revoked" | "expiryUnix">[],
  agentPk: Uint8Array,
  nowUnix: number = Math.floor(Date.now() / 1000),
): T[] {
  const want = norm(toHex(agentPk));
  // An expired key is not usable, so it counts as not linked (margin avoids expiring mid-demo).
  const linked = authenticators.some(
    (a) => !a.revoked && norm(a.pubkeyHex) === want && a.expiryUnix > BigInt(nowUnix + EXPIRY_MARGIN_SECONDS),
  );
  if (!linked) return allMsgs;
  const rules = allMsgs.find((m) => m.typeUrl.endsWith(".MsgUpdateSpendingRules"));
  if (!rules) throw new Error("linkAuthenticatorMsgs returned no MsgUpdateSpendingRules message");
  return [rules];
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

  const proof = signAuthenticatorLinkEd25519({ chainId: NETWORK.chainId, account: owner.cosmos, privateKey: agent.sk });
  const all = linkAuthenticatorMsgs({
    owner: owner.cosmos,
    chainId: NETWORK.chainId,
    ...proof,
    permissions: ["evm"],
    expiryUnix: Math.floor(Date.now() / 1000) + AGENT_TTL_SECONDS,
    label: "qday-guardian agent",
    spendingRule: buildSetupRule(vault, tokens),
  });
  const existing = await fetchAuthenticators({ rest: NETWORK.rest, address: owner.cosmos });
  const linkMsgs = selectLinkMsgs(all, existing, agent.pk);

  const window = openEvmWindowMsg(buildWindowParams(owner.cosmos, tokens, vault));
  const hash = await broadcast(owner, [window, ...linkMsgs], "qday: open window + link guardian");
  console.log(`window + link (${linkMsgs.length} link msg): ${hash}`);

  // Approvals are ECDSA EVM txs and cannot ride in the hybrid cosmos tx. They need the window opened above.
  const wallet = createWalletClient({ account: privateKeyToAccount(owner.privateKey as Hex), chain, transport: http() });
  for (const [symbol, address] of Object.entries(tokens)) {
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
