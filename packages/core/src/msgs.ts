import { evmWindowCost } from "@qorechain/evm/window";
import {
  bank,
  buildRegisterPqcKeyMsg,
  linkAuthenticatorMsgs,
  revokeAuthenticatorMsg,
  signAuthenticatorLinkEd25519,
  signProofOfPossession,
  type AuthenticatorView,
  type SpendingRuleInput,
  type SpendingRules,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { bytesToHex, hexToBytes, toHex, type Hex } from "viem";
import { RESCUE_SELECTOR } from "./abi";
import { NETWORK } from "./config";

type Msg = { typeUrl: string; value: unknown };
type Tokens = { fUSD: string; fETH: string; fBTC: string };

/** Tight gas limits (chain fact 5): the vault deploy used 725168 gas on diana, an `approve` far less. */
export const DEPLOY_GAS = 950_000n;
export const APPROVE_GAS = 100_000n;
/** A TestToken mint to a new holder (mint fBTC used 68292 on diana). */
export const MINT_GAS = 100_000n;
export const MINT_AMOUNT = 100n * 10n ** 18n;

/**
 * 30 days: the event's re-link interval for an agent key (build.qorechain.io FAQ), so one link outlives the checks (3-5 Dec)
 * and judging (6-15 Dec). A live key is not renewed by `link` (only its rules are sent): renew with `unlink`, then `link`.
 */
export const AGENT_TTL_SECONDS = 30 * 24 * 3600;
const EXPIRY_MARGIN_SECONDS = 60;

/** Same per-tx budget as `setup`: a 3M-gas tx at 112.5 gwei. */
const PER_TX_GAS = 3_000_000n;
const PER_TX_MAX_FEE = 112_500_000_000n;

const norm = (hex: string) => hex.replace(/^0x/i, "").toLowerCase();

/**
 * The agent key's spending rule. It may call exactly `vault.rescue` and move only native uqor, with no
 * erc20/ denom: listing a token would let the key call that token's `transfer` directly, whatever
 * allowedEvmCalls says (docs/EVIDENCE.md, tx CADB1412). The agent rescues from its own guardian account,
 * so this key only signs incident reports and proves that the chain refuses direct token calls.
 */
export function buildSetupRule(vault: string) {
  const rule = {
    id: "guardian",
    enabled: true,
    perTxLimit: "1000000",
    dailyLimit: "3000000",
    allowedDenoms: ["uqor"],
    allowedEvmCalls: [`${vault.toLowerCase()}/${RESCUE_SELECTOR}`],
  } satisfies SpendingRuleInput;
  return rule;
}

/** The agent key's rule is exactly `vault.rescue` + `uqor`: the first enabled rule applies (chain fact 8). */
export function ruleIsExact(rules: SpendingRules, vault: string): boolean {
  const r = rules.rules.find((x) => x.enabled);
  if (!r) return false;
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  return r.allowedEvmCalls.length === 1 && same(r.allowedEvmCalls[0], `${vault}/${RESCUE_SELECTOR}`) && r.allowedDenoms.length === 1 && r.allowedDenoms[0] === "uqor";
}

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

/** The agent key's possession proof for one owner account, plus its public key as hex: all a browser needs to build the link. */
export type AgentLinkProof = ReturnType<typeof signAuthenticatorLinkEd25519> & { agentPubKeyHex: string };

/** `AgentLinkProof` as JSON (what `/api/onboard` returns): its byte fields as 0x hex. */
export type AgentLinkProofJson = { scheme: AgentLinkProof["scheme"]; pubkey: Hex; possessionProof: Hex; agentPubKeyHex: string };

export function encodeLinkProof(p: AgentLinkProof): AgentLinkProofJson {
  return { scheme: p.scheme, pubkey: bytesToHex(p.pubkey), possessionProof: bytesToHex(p.possessionProof), agentPubKeyHex: p.agentPubKeyHex };
}

/** Inverse of `encodeLinkProof`. Throws on a field that is not 0x hex. */
export function decodeLinkProof(j: AgentLinkProofJson): AgentLinkProof {
  const bytes = (h: unknown, name: string) => {
    if (typeof h !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(h)) throw new Error(`link proof ${name} must be 0x hex`);
    return hexToBytes(h as Hex);
  };
  return { scheme: j.scheme, pubkey: bytes(j.pubkey, "pubkey"), possessionProof: bytes(j.possessionProof, "possessionProof"), agentPubKeyHex: j.agentPubKeyHex };
}

/**
 * The messages that link the Guardian's ed25519 key from a possession proof (`signAuthenticatorLinkEd25519`), so the
 * caller never needs the agent's secret key: the rules update plus, unless the key is already linked and live, its
 * registration. No window message.
 */
export function buildGuardianLinkMsgsFromProof(
  owner: Pick<UnifiedAccount, "cosmos">,
  vault: string,
  proof: AgentLinkProof,
  existing: Pick<AuthenticatorView, "pubkeyHex" | "revoked" | "expiryUnix">[],
  nowUnix: number = Math.floor(Date.now() / 1000),
) {
  const { agentPubKeyHex: _hex, ...sdkProof } = proof;
  const all = linkAuthenticatorMsgs({
    owner: owner.cosmos,
    chainId: NETWORK.chainId,
    ...sdkProof,
    permissions: ["evm"],
    expiryUnix: nowUnix + AGENT_TTL_SECONDS,
    label: "qday-guardian agent",
    spendingRule: buildSetupRule(vault),
  });
  return selectLinkMsgs(all, existing, sdkProof.pubkey, nowUnix);
}

/**
 * The messages that link the Guardian's ed25519 key with the agent's spending rule (`buildSetupRule`): the rules
 * update plus, unless the key is already linked and live, its registration. No window message. `setup` and
 * `link` both build their link messages here, so the rule cannot drift between them.
 */
export function buildGuardianLinkMsgs(
  owner: Pick<UnifiedAccount, "cosmos">,
  vault: string,
  agent: { sk: Uint8Array; pk: Uint8Array },
  existing: Pick<AuthenticatorView, "pubkeyHex" | "revoked" | "expiryUnix">[],
  nowUnix: number = Math.floor(Date.now() / 1000),
) {
  const proof = signAuthenticatorLinkEd25519({ chainId: NETWORK.chainId, account: owner.cosmos, privateKey: agent.sk });
  return buildGuardianLinkMsgsFromProof(owner, vault, { ...proof, agentPubKeyHex: toHex(agent.pk) }, existing, nowUnix);
}

/**
 * The `MsgRevokeAuthenticator` that disables the Guardian's ed25519 key on the owner's account. Refuses, before anything
 * is signed, when that key is not linked there or every entry for it is already revoked. An expired entry is still
 * revoked: an expired key is not usable, but revoking it leaves no doubt.
 */
export function buildUnlinkMsg(
  owner: Pick<UnifiedAccount, "cosmos">,
  agent: { pk: Uint8Array },
  linked: Pick<AuthenticatorView, "pubkeyHex" | "revoked">[],
) {
  const want = norm(toHex(agent.pk));
  const entries = linked.filter((a) => norm(a.pubkeyHex) === want);
  if (!entries.length) throw new Error(`the Guardian's key ${want.slice(0, 8)}… is not linked to ${owner.cosmos}: nothing to unlink`);
  if (entries.every((a) => a.revoked)) throw new Error(`the Guardian's key ${want.slice(0, 8)}… is already revoked on ${owner.cosmos}`);
  return revokeAuthenticatorMsg({ owner: owner.cosmos, account: owner.cosmos, scheme: "ed25519", pubkey: agent.pk });
}

export function buildFundMsg(from: string, to: string, uqor: bigint): Msg {
  return bank.send({ fromAddress: from, toAddress: to, amount: [{ denom: "uqor", amount: uqor.toString() }] });
}

/**
 * `MsgRegisterPQCKeyV2` for the account's own ML-DSA-87 key (the one `deriveUnifiedAccount` derives from the
 * mnemonic, which is what the Guardian Signer signs with), with a proof of possession so the vault accepts it.
 */
export function buildRegisterMsg(acc: UnifiedAccount, chainId: string): Msg {
  const proofOfPossession = signProofOfPossession({ chainId, account: acc.cosmos, keypair: acc.pqc });
  return buildRegisterPqcKeyMsg(acc.cosmos, { pqcKeypair: acc.pqc, proofOfPossession });
}

/**
 * The owner's hand-driven window: scoped to the three tokens, the vault and the guardian. A withdraw, a manual rescue
 * and an approve fit. Against a leaked ECDSA key the window budget is the only cap (chain fact 4), so by default
 * `maxValue` covers fees only. A QOR top-up of the guardian moves value, which a window counts in `maxValue` too:
 * `topupUqor` (opt-in, `--topup`) adds exactly that much value headroom, which a leaked key can also spend while the
 * window is open.
 */
export function buildOwnerWindowParams(
  ownerCosmos: string,
  tokens: Tokens,
  vault: string,
  guardian: string,
  size: { blocks: number; txs: number; topupUqor?: bigint },
) {
  const allowedTargets = [tokens.fUSD, tokens.fETH, tokens.fBTC, vault, guardian];
  const seen = new Set(allowedTargets.map((t) => t.toLowerCase()));
  if (seen.size !== allowedTargets.length) throw new Error(`window targets contain a duplicate address: ${allowedTargets.join(", ")}`);
  const perTx = evmWindowCost({ gas: PER_TX_GAS, maxFeePerGas: PER_TX_MAX_FEE });
  return {
    sender: ownerCosmos,
    blocks: size.blocks,
    maxTxs: size.txs,
    maxValue: (perTx * BigInt(size.txs) + (size.topupUqor ?? 0n)).toString(),
    allowedTargets,
  };
}

/**
 * The onboarding window: UNSCOPED (no `allowedTargets` key at all), because a window with targets refuses contract
 * creation and the vault is deployed from the browser wallet. Same per-tx fee budget as the scoped window, plus the
 * opt-in top-up headroom. The window budget is the only cap against a leaked ECDSA key (chain fact 4).
 */
export function buildOnboardWindowParams(ownerCosmos: string, size: { blocks: number; txs: number; topupUqor: bigint }) {
  const perTx = evmWindowCost({ gas: PER_TX_GAS, maxFeePerGas: PER_TX_MAX_FEE });
  return {
    sender: ownerCosmos,
    blocks: size.blocks,
    maxTxs: size.txs,
    maxValue: (perTx * BigInt(size.txs) + size.topupUqor).toString(),
  };
}

/**
 * A fresh agent ed25519 secret key: 32 random bytes as 64 hex characters (the AGENT_ED25519_SK format
 * `loadAgentKey` reads). Each demo run needs its own: diana binds an authenticator key to ONE account.
 * Uses the global WebCrypto (Node 22 and browsers).
 */
export function newAgentKeyHex(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
