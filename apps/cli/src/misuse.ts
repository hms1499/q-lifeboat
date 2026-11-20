import { agentWallet, loadAgentKey, loadGasAccount, loadOwnerAddress, NETWORK } from "@qday/core";
import { broadcastTx } from "@qday/core/chain";
import {
  buildPhantomExecuteEvm,
  decodeAuthenticatorExecutions,
  fetchAuthNonce,
  resolveEvmAuthDigestVersion,
} from "@qorechain/sdk";
import { encodeFunctionData, erc20Abi, hexToBytes, type Hex } from "viem";

type Env = Record<string, string | undefined>;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const GAS_LIMIT = 200_000n;

/** The misuse attempt: the agent key calling `token.transfer(to, amount)` directly, not through the vault. */
export function misuseCall(token: Hex, to: Hex, amount: bigint) {
  return {
    to: token,
    value: "0",
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }),
    gasLimit: GAS_LIMIT,
  };
}

/** Chain fact 1: a call outside `allowedEvmCalls` is refused with "authenticator not permitted for this action". */
const POLICY_REFUSAL = /not permitted/i;

/**
 * 0 = the call policy refused it (the gate passes), 2 = the agent key moved tokens, 1 = inconclusive.
 * Any other failure (revert, spending-limit refusal) proves nothing about `allowedEvmCalls`, so it is
 * inconclusive rather than a pass.
 */
export function misuseExitCode(executions: { success: boolean; error?: string }[]): 0 | 1 | 2 {
  if (executions.length === 0) return 1;
  if (executions.some((x) => x.success)) return 2;
  return executions.every((x) => POLICY_REFUSAL.test(x.error ?? "")) ? 0 : 1;
}

/**
 * `pnpm cli agent-misuse <token> <to> <amountWei>`: on-chain negative gate. Needs OWNER_EVM_ADDRESS,
 * AGENT_ED25519_SK and GAS_MNEMONIC (the relayer); never loads OWNER_MNEMONIC.
 */
export async function runAgentMisuse(args: string[], env: Env = process.env): Promise<number> {
  const [token, to, amountRaw] = args;
  if (!token || !to || !amountRaw || !ADDRESS_RE.test(token) || !ADDRESS_RE.test(to) || !/^\d+$/.test(amountRaw)) {
    throw new Error("usage: agent-misuse <token 0x…> <to 0x…> <amountWei>");
  }
  const owner = loadOwnerAddress(env);
  const gas = await loadGasAccount(env);
  const agent = loadAgentKey(env);
  const { pk } = agent;
  const wallet = agentWallet(agent);

  const call = misuseCall(token as Hex, to as Hex, BigInt(amountRaw));
  const { nonce } = await fetchAuthNonce({ rest: NETWORK.rest, address: owner.cosmos, pubkey: pk });
  const msg = await buildPhantomExecuteEvm({
    wallet,
    relayer: gas.cosmos,
    chainId: NETWORK.chainId,
    account: owner.cosmos,
    to: call.to,
    value: call.value,
    data: hexToBytes(call.data),
    gasLimit: call.gasLimit,
    nonce,
    digestVersion: await resolveEvmAuthDigestVersion({ rest: NETWORK.rest }),
  });
  const res = await broadcastTx(gas, [msg], "qday-guardian: agent misuse gate");
  const executions = decodeAuthenticatorExecutions(res, [msg]).map((x) => ({
    success: x.success,
    error: x.success ? undefined : x.reason || x.vmError || "execution failed",
  }));
  console.log(`tx ${res.transactionHash} (height ${res.height})`);
  console.log(JSON.stringify(executions));
  const code = misuseExitCode(executions);
  const reason = executions.find((x) => !x.success)?.error ?? "none";
  if (code === 0) {
    console.log(`REFUSED: ${reason}`);
  } else if (code === 2) {
    console.log("NOT REFUSED — agent key can move tokens directly");
  } else {
    console.log(`INCONCLUSIVE: not a call-policy refusal (reason: ${reason})`);
  }
  return code;
}
