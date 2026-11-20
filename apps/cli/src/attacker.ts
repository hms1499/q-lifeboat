import { randomBytes } from "node:crypto";
import { loadOwner, loadTokens, loadVault, vaultAbi } from "@qday/core";
import { ML_DSA_87_SIGNATURE_LENGTH } from "@qorechain/sdk";
import {
  BaseError,
  bytesToHex,
  ContractFunctionRevertedError,
  createWalletClient,
  erc20Abi,
  http,
  isAddress,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { chain, publicClient } from "./chain";
import { attemptAgentMisuse, type MisuseOutcome } from "./misuse";
import { runDirFromEnv, writeRunFile } from "./run";

type Env = Record<string, string | undefined>;

export const DRAIN_COUNT = 3;
export const DRAIN_AMOUNT = 10n * 10n ** 18n;
/** A TestToken transfer to a new holder is ~52k gas; diana charges >= 50% of the limit, so keep it tight. */
export const DRAIN_GAS = 60_000n;
export const FORGED_SIG_BYTES = ML_DSA_87_SIGNATURE_LENGTH;
/** Same limit as a real withdraw (`withdraw.ts`): the revert must come from the signature check, not out of gas. */
export const FORGED_WITHDRAW_GAS = 1_000_000n;
export const MISUSE_AMOUNT = 10n ** 18n;
/**
 * EVM txs the demo sends inside the owner's scoped setup window (`WINDOW_MAX_TXS`): 3 approvals (setup),
 * the drains, 1 forged withdraw, 1 recovery withdraw.
 */
export const OWNER_WINDOW_TXS_USED = 3 + DRAIN_COUNT + 1 + 1;
const RECEIPT_POLL_MS = 250;
const RECEIPT_TIMEOUT_MS = 60_000;
/** The chain's call-policy refusal (CLAUDE.md chain fact 1, docs/EVIDENCE.md tx 7E9B629F). */
const POLICY_REFUSAL = /authenticator not permitted for this action/i;

export type DrainRecord = { index: number; hash?: Hex; block?: string; status?: "success" | "reverted"; error?: string };
export type ForgedRecord = {
  amount: string;
  /** The revert error name from the eth_call (null when the call would not revert). */
  revert: string | null;
  hash?: Hex;
  block?: string;
  status?: "success" | "reverted";
  error?: string;
  pass: boolean;
};
export type MisuseRecord = { tx?: string; reason: string; executions: MisuseOutcome["executions"]; error?: string; pass: boolean };
export type AttackResult = { drains: DrainRecord[]; forged: ForgedRecord; misuse: MisuseRecord };

export type AttackDeps = {
  log(line: string): void;
  /** fUSD.transfer(ATTACKER_ADDR, 10 fUSD) from the owner (leaked ECDSA key); resolves once the node took it. */
  sendDrain(): Promise<Hex>;
  waitReceipt(hash: Hex): Promise<{ status: "success" | "reverted"; blockNumber: bigint }>;
  vaultTokenBalance(): Promise<bigint>;
  /** eth_call of vault.withdraw(ATTACKER_ADDR, fUSD, amount, sig): the revert error name, or null if it would succeed. */
  simulateWithdraw(amount: bigint, sig: Hex): Promise<string | null>;
  sendWithdraw(amount: bigint, sig: Hex): Promise<Hex>;
  /** The agent key calling fUSD.transfer(ATTACKER_ADDR, 1 fUSD) directly. */
  misuse(): Promise<MisuseOutcome>;
  randomBytes(n: number): Uint8Array;
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The custom error name (e.g. `BadSignature`) of a viem contract revert, else its short message. */
export function revertName(e: unknown): string {
  if (e instanceof BaseError) {
    const r = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.reason ?? r.shortMessage;
    return e.shortMessage;
  }
  return errorText(e);
}

async function sendAndWait(deps: AttackDeps, send: () => Promise<Hex>) {
  let hash: Hex;
  try {
    hash = await send();
  } catch (e) {
    return { error: errorText(e) };
  }
  try {
    const r = await deps.waitReceipt(hash);
    return { hash, block: r.blockNumber.toString(), status: r.status };
  } catch (e) {
    return { hash, error: errorText(e) };
  }
}

/**
 * The Task 5 attacker. Drain: DRAIN_COUNT fUSD transfers, each sent as soon as the previous one has a receipt
 * (one block apart); a refused or reverted transfer is recorded and the attack goes on. Then (a) a withdraw with
 * a random "signature" (eth_call for the revert reason, then a real tx), and (b) the agent key misuse.
 */
export async function attack(deps: AttackDeps): Promise<AttackResult> {
  const drains: DrainRecord[] = [];
  for (let index = 1; index <= DRAIN_COUNT; index++) {
    const d: DrainRecord = { index, ...(await sendAndWait(deps, () => deps.sendDrain())) };
    drains.push(d);
    deps.log(`drain ${index}: ${d.hash ?? "-"} block ${d.block ?? "-"} ${d.status ?? ""}${d.error ? ` error: ${d.error}` : ""}`);
  }

  const balance = await deps.vaultTokenBalance().catch(() => 0n);
  const amount = balance > 0n ? balance : 10n ** 18n;
  const sig = bytesToHex(deps.randomBytes(FORGED_SIG_BYTES));
  const revert = await deps.simulateWithdraw(amount, sig);
  const sent = await sendAndWait(deps, () => deps.sendWithdraw(amount, sig));
  const forged: ForgedRecord = {
    amount: amount.toString(),
    revert,
    ...sent,
    pass: revert === "BadSignature" && sent.status === "reverted",
  };
  deps.log(`(a) forged withdraw of ${amount}: eth_call ${revert ?? "did not revert"}; tx ${forged.hash ?? "-"} ${forged.status ?? forged.error ?? ""}`);

  let misuse: MisuseRecord;
  try {
    const o = await deps.misuse();
    misuse = { tx: o.tx, reason: o.reason, executions: o.executions, pass: o.code === 0 && POLICY_REFUSAL.test(o.reason) };
  } catch (e) {
    misuse = { reason: "", executions: [], pass: false, error: errorText(e) };
  }
  deps.log(`(b) agent key fUSD.transfer: tx ${misuse.tx ?? "-"} ${misuse.error ?? misuse.reason}`);

  return { drains, forged, misuse };
}

/** Diana wiring. The drain and (a) use ONLY the owner's ECDSA key; (b) uses the agent key (assumed stolen too). */
async function productionAttackDeps(env: Env, attacker: Hex) {
  const owner = await loadOwner(env); // only its secp256k1 key is used: the leaked key
  const vault = loadVault(env);
  const { fUSD } = loadTokens(env);
  const account = privateKeyToAccount(owner.privateKey as Hex);
  const wallet = createWalletClient({ account, chain, transport: http() });
  const withdrawArgs = (amount: bigint, sig: Hex) => [attacker, fUSD, amount, sig] as const;
  const deps: AttackDeps = {
    log: (line) => console.log(line),
    sendDrain: () => wallet.writeContract({ address: fUSD, abi: erc20Abi, functionName: "transfer", args: [attacker, DRAIN_AMOUNT], gas: DRAIN_GAS }),
    waitReceipt: (hash) => publicClient.waitForTransactionReceipt({ hash, pollingInterval: RECEIPT_POLL_MS, timeout: RECEIPT_TIMEOUT_MS }),
    vaultTokenBalance: () => publicClient.readContract({ address: fUSD, abi: erc20Abi, functionName: "balanceOf", args: [vault] }),
    simulateWithdraw: async (amount, sig) => {
      try {
        await publicClient.simulateContract({ account, address: vault, abi: vaultAbi, functionName: "withdraw", args: withdrawArgs(amount, sig) });
        return null;
      } catch (e) {
        return revertName(e);
      }
    },
    // writeContract does not simulate, and an explicit gas limit skips estimation, so the reverting tx is mined.
    sendWithdraw: (amount, sig) =>
      wallet.writeContract({ address: vault, abi: vaultAbi, functionName: "withdraw", args: withdrawArgs(amount, sig), gas: FORGED_WITHDRAW_GAS }),
    misuse: () => attemptAgentMisuse(fUSD, attacker, MISUSE_AMOUNT, env),
    randomBytes: (n) => new Uint8Array(randomBytes(n)),
  };
  return { deps, owner: owner.evm as Hex, vault, token: fUSD };
}

/** `pnpm cli attack`: run the attack and write `~/.config/qday/runs/<RUN_ID>/attack.json`. */
export async function runAttack(env: Env = process.env): Promise<void> {
  const attacker = env.ATTACKER_ADDR?.trim();
  if (!attacker || !isAddress(attacker, { strict: false })) throw new Error("ATTACKER_ADDR must be a 0x address");
  const dir = runDirFromEnv(env);
  const { deps, owner, vault, token } = await productionAttackDeps(env, attacker as Hex);
  const startedAt = new Date().toISOString();
  console.log(`attack on ${owner} (vault ${vault}) with the leaked ECDSA key -> ${attacker}`);
  const result = await attack(deps);
  const out = { runId: env.RUN_ID, owner, attacker, vault, token, startedAt, finishedAt: new Date().toISOString(), ...result };
  const file = writeRunFile(dir, "attack.json", `${JSON.stringify(out, null, 2)}\n`);
  const landed = result.drains.filter((d) => d.status === "success").length;
  console.log(`drains landed ${landed}/${DRAIN_COUNT}; (a) ${result.forged.pass ? "PASS" : "FAIL"}; (b) ${result.misuse.pass ? "PASS" : "FAIL"}`);
  console.log(`wrote ${file}`);
}
