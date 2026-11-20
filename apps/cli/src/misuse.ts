import { loadAgentKey, NETWORK } from "@qday/core";
import { broadcastTx } from "@qday/core/chain";
import { ed25519 } from "@noble/curves/ed25519";
import {
  addressesFrom20,
  buildPhantomExecuteEvm,
  decodeAuthenticatorExecutions,
  deriveUnifiedAccount,
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

/** 0 = the chain refused (the gate passes), 2 = the agent key moved tokens, 1 = inconclusive (no result). */
export function misuseExitCode(executions: { success: boolean; error?: string }[]): 0 | 1 | 2 {
  if (executions.length === 0) return 1;
  return executions.some((x) => x.success) ? 2 : 0;
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
  const ownerEvm = env.OWNER_EVM_ADDRESS?.trim();
  if (!ownerEvm || !ADDRESS_RE.test(ownerEvm)) throw new Error("OWNER_EVM_ADDRESS must be a 0x-prefixed 20-byte address");
  const mnemonic = env.GAS_MNEMONIC?.trim();
  if (!mnemonic) throw new Error("GAS_MNEMONIC is not set");
  const gas = await deriveUnifiedAccount(mnemonic).catch((e: unknown) => {
    // Only the error name is safe to surface; the message could contain the secret.
    throw new Error(`GAS_MNEMONIC could not be used to derive an account (${e instanceof Error ? e.name : "UnknownError"})`);
  });
  const ownerCosmos = addressesFrom20(hexToBytes(ownerEvm as Hex)).cosmos;
  const { sk, pk } = loadAgentKey(env);
  const wallet = { publicKey: pk, async signMessage(m: Uint8Array) { return { signature: ed25519.sign(m, sk) }; } };

  const call = misuseCall(token as Hex, to as Hex, BigInt(amountRaw));
  const { nonce } = await fetchAuthNonce({ rest: NETWORK.rest, address: ownerCosmos, pubkey: pk });
  const msg = await buildPhantomExecuteEvm({
    wallet,
    relayer: gas.cosmos,
    chainId: NETWORK.chainId,
    account: ownerCosmos,
    to: call.to,
    value: call.value,
    data: hexToBytes(call.data),
    gasLimit: call.gasLimit,
    nonce,
    digestVersion: await resolveEvmAuthDigestVersion({ rest: NETWORK.rest }),
  });
  const res = await broadcastTx(gas, [msg], "qday-guardian: agent misuse gate");
  const executions = decodeAuthenticatorExecutions(res, [msg]);
  console.log(`tx ${res.transactionHash} (height ${res.height})`);
  console.log(JSON.stringify(executions.map((x) => ({ success: x.success, error: x.success ? undefined : x.reason || x.vmError })) ));
  const code = misuseExitCode(executions);
  if (code === 0) {
    const x = executions.find((e) => !e.success);
    console.log(`REFUSED: ${x?.reason || x?.vmError || "execution failed"}`);
  } else if (code === 2) {
    console.log("NOT REFUSED — agent key can move tokens directly");
  } else {
    console.log("INCONCLUSIVE: no execution result decoded from the tx");
  }
  return code;
}
