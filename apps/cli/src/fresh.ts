import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAgentKey, NETWORK, vaultAbi } from "@qday/core";
import { evmWindowCost, evmWindowStatus } from "@qorechain/evm";
import {
  bank,
  buildRegisterPqcKeyMsg,
  clearPqcStatusCache,
  deriveUnifiedAccount,
  fetchPqcStatus,
  generateMnemonic,
  openEvmWindowMsg,
  signProofOfPossession,
  type PqcStatus,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { createWalletClient, formatUnits, http, isAddress, parseAbi, type Abi, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { broadcast, chain, publicClient, uqorBalance } from "./chain";
import { formatRunEnv, newRunId, runDir, writeRunFile } from "./run";
import { assertRegisteredKey } from "./signer";

type Env = Record<string, string | undefined>;
type Msg = { typeUrl: string; value: unknown };

export const FRESH_FUND_UQOR_DEFAULT = 1_500_000n;
/** What the funder keeps for its own fees on top of the amount it sends. */
export const FEE_RESERVE_UQOR = 500_000n;
const DEPLOY_WINDOW_BLOCKS = 600;
const DEPLOY_WINDOW_MAX_TXS = 3;
/** v3 deploy used 725168 gas on diana; diana charges >= 50% of the limit, so keep it tight. */
export const DEPLOY_GAS = 950_000n;
/** A TestToken mint to a new holder (mint fBTC used 68292 on diana). */
export const MINT_GAS = 100_000n;
/** Fee cap of the deploy and the mint; the window budget is sized from it. */
export const FRESH_MAX_FEE_PER_GAS = 150_000_000_000n;
const FRESH_PRIORITY_FEE_PER_GAS = 10_000_000_000n;
export const MINT_AMOUNT = 100n * 10n ** 18n;
const POLL_TRIES = 20;
const POLL_DELAY_MS = 1_500;

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const VAULT_ARTIFACT = resolve(REPO_ROOT, "contracts/out/GuardianVault.sol/GuardianVault.json");
const mintAbi = parseAbi(["function mint(address to, uint256 amount)"]);

const qor = (uqor: bigint) => `${formatUnits(uqor, 6)} QOR`;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** FRESH_FUND_UQOR: what the funder sends the fresh owner (default 1.5 QOR). */
export function parseFundUqor(env: Env): bigint {
  const raw = env.FRESH_FUND_UQOR?.trim();
  if (!raw) return FRESH_FUND_UQOR_DEFAULT;
  if (!/^\d+$/.test(raw) || BigInt(raw) === 0n) throw new Error("FRESH_FUND_UQOR must be a positive integer (uqor)");
  return BigInt(raw);
}

export function checkFunderBalance(balance: bigint, fund: bigint): void {
  const need = fund + FEE_RESERVE_UQOR;
  if (balance < need) {
    throw new Error(`funder has ${qor(balance)}, needs ${qor(need)} (${qor(fund)} for the fresh owner + ${qor(FEE_RESERVE_UQOR)} fees); claim the faucet`);
  }
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

/** The fresh owner's deploy window: UNSCOPED (a window with targets refuses contract creation), deploy + mint. */
export function buildDeployWindowParams(cosmos: string) {
  const budget =
    evmWindowCost({ gas: DEPLOY_GAS, maxFeePerGas: FRESH_MAX_FEE_PER_GAS }) + evmWindowCost({ gas: MINT_GAS, maxFeePerGas: FRESH_MAX_FEE_PER_GAS });
  return { sender: cosmos, blocks: DEPLOY_WINDOW_BLOCKS, maxTxs: DEPLOY_WINDOW_MAX_TXS, maxValue: budget.toString() };
}

/**
 * A fresh agent ed25519 secret key: 32 random bytes as 64 hex characters (the AGENT_ED25519_SK format
 * `loadAgentKey` reads). Each demo run needs its own: diana binds an authenticator key to ONE account.
 */
export function newAgentKeyHex(): string {
  return randomBytes(32).toString("hex");
}

export function checkVaultRoles(onChain: { owner: string; guardian: string }, want: { owner: string; guardian: string }): void {
  if (onChain.owner.toLowerCase() !== want.owner.toLowerCase()) throw new Error(`deployed vault owner() is ${onChain.owner}, expected ${want.owner}`);
  if (onChain.guardian.toLowerCase() !== want.guardian.toLowerCase()) {
    throw new Error(`deployed vault guardian() is ${onChain.guardian}, expected ${want.guardian}`);
  }
}

/** The compiled GuardianVault (forge artifact): abi + creation bytecode, constructor (owner, guardian). */
export function loadVaultArtifact(path: string = VAULT_ARTIFACT): { abi: Abi; bytecode: Hex } {
  if (!existsSync(path)) throw new Error(`${path} not found: run \`cd contracts && forge build\` first`);
  const j = JSON.parse(readFileSync(path, "utf8")) as { abi?: Abi; bytecode?: { object?: string } };
  const ctor = j.abi?.find((x) => x.type === "constructor") as { inputs?: { type: string }[] } | undefined;
  if (!ctor || ctor.inputs?.map((i) => i.type).join(",") !== "address,address") {
    throw new Error(`${path}: expected a constructor(address owner_, address guardian_)`);
  }
  const bytecode = j.bytecode?.object;
  if (!bytecode || !/^0x[0-9a-fA-F]+$/.test(bytecode)) throw new Error(`${path}: no creation bytecode`);
  return { abi: j.abi!, bytecode: bytecode as Hex };
}

export type FreshDeps = {
  /** Base for ~/.config/qday/runs (tests use a temp dir). */
  home?: string;
  now(): Date;
  newMnemonic(): string;
  /** A fresh AGENT_ED25519_SK (64 hex characters). */
  newAgentKey(): string;
  /** A fresh random address whose key is thrown away. */
  randomAddress(): Hex;
  log(line: string): void;
  sleep(ms: number): Promise<void>;
  uqorBalance(cosmos: string): Promise<bigint>;
  broadcast(acc: UnifiedAccount, msgs: Msg[], memo: string, mode: "hybrid" | "classical"): Promise<string>;
  pqcStatus(cosmos: string): Promise<PqcStatus>;
  windowLive(cosmos: string): Promise<boolean>;
  evmNonce(evm: Hex): Promise<number>;
  deployVault(acc: UnifiedAccount, owner: Hex, guardian: Hex): Promise<{ hash: Hex; address: Hex }>;
  readRoles(vault: Hex): Promise<{ owner: Hex; guardian: Hex }>;
  mint(acc: UnifiedAccount, token: Hex, to: Hex, amount: bigint): Promise<Hex>;
};

function readAddress(env: Env, name: string): Hex {
  const v = env[name]?.trim();
  if (!v) throw new Error(`${name} is not set`);
  if (!isAddress(v, { strict: false })) throw new Error(`${name} must be a 0x address`);
  return v as Hex;
}

export async function deriveSecret(mnemonic: string, name: string): Promise<UnifiedAccount> {
  try {
    return await deriveUnifiedAccount(mnemonic);
  } catch (e) {
    throw new Error(`${name} could not be used to derive an account (${e instanceof Error ? e.name : "UnknownError"})`);
  }
}

export async function waitFor<T>(deps: { sleep(ms: number): Promise<void> }, read: () => Promise<T>, ok: (v: T) => boolean, what: string): Promise<T> {
  let v = await read();
  for (let i = 1; i < POLL_TRIES && !ok(v); i++) {
    await deps.sleep(POLL_DELAY_MS);
    v = await read();
  }
  if (!ok(v)) throw new Error(`timed out waiting for ${what}`);
  return v;
}

/**
 * Provision a brand-new demo owner (Task 5, decision 1): fund it from the FUNDER, register its ML-DSA-87 key
 * (own tx), open an unscoped deploy window, deploy its own GuardianVault(owner, GUARDIAN_ADDRESS), mint it
 * 100 fUSD. With `noVault` (`--no-vault`) no vault is deployed: the owner is onboarded from the dashboard's
 * Protect screen. A fresh agent ed25519 key is generated too (an authenticator key binds to one account).
 * `~/.config/qday/runs/<runId>/run.env` is written with both secrets and RUN_COMPLETE=0 BEFORE the fund
 * tx, and completed (vault, attacker, safe, RUN_COMPLETE=1) only when every step succeeded; only then is the
 * `RUN_ENV=` line printed. On failure the incomplete run dir is printed so its QOR can be recovered.
 * Logs addresses and tx hashes only, never a secret.
 */
export async function freshOwner(env: Env, deps: FreshDeps, opts: { noVault?: boolean } = {}) {
  const noVault = opts.noVault === true;
  // --no-vault: the owner deploys its own vault from MetaMask, so no guardian is needed here.
  const guardian = noVault ? undefined : readAddress(env, "GUARDIAN_ADDRESS");
  const fusd = readAddress(env, "FUSD_ADDRESS");
  const fund = parseFundUqor(env);
  const funderMnemonic = env.FUNDER_MNEMONIC?.trim() || env.OWNER_MNEMONIC?.trim();
  if (!funderMnemonic) throw new Error("FUNDER_MNEMONIC (or OWNER_MNEMONIC) is not set");
  const funder = await deriveSecret(funderMnemonic, env.FUNDER_MNEMONIC?.trim() ? "FUNDER_MNEMONIC" : "OWNER_MNEMONIC");

  // 1. Fresh owner, attacker and safe addresses.
  const runId = newRunId(deps.now());
  const dir = runDir(runId, deps.home);
  const mnemonic = deps.newMnemonic();
  const fresh = await deriveSecret(mnemonic, "the generated mnemonic");
  const owner = fresh.evm as Hex;
  // The agent key for this run: the root AGENT_ED25519_SK is already bound to another account.
  const agentSk = deps.newAgentKey();
  loadAgentKey({ AGENT_ED25519_SK: agentSk }); // same format check setup, the agent and (b) apply; never echoes it
  const attacker = deps.randomAddress();
  const safe = deps.randomAddress();
  deps.log(`run ${runId}: fresh owner ${owner} (${fresh.cosmos}), attacker ${attacker}, safe ${safe}`);

  // 2. Persist the fresh owner's key BEFORE any QOR is sent to it: a later failure must not lose the account.
  checkFunderBalance(await deps.uqorBalance(funder.cosmos), fund);
  const base = { RUN_ID: runId, OWNER_MNEMONIC: mnemonic, OWNER_EVM_ADDRESS: owner, AGENT_ED25519_SK: agentSk };
  const runEnv = writeRunFile(dir, "run.env", formatRunEnv({ ...base, RUN_COMPLETE: "0" }), { exclusive: true });
  try {
    // Fund it (step 2 of R1).
    const fundTx = await deps.broadcast(funder, [buildFundMsg(funder.cosmos, fresh.cosmos, fund)], "qday: fund fresh demo owner", "hybrid");
    deps.log(`fund ${qor(fund)} from ${funder.cosmos}: ${fundTx}`);
    await waitFor(deps, () => deps.uqorBalance(fresh.cosmos), (b) => b >= fund, "the fresh owner's balance");

    // 3. Register its ML-DSA-87 key: its own tx, signed classically (the bootstrap-exempt message).
    let regTx: string;
    try {
      regTx = await deps.broadcast(fresh, [buildRegisterMsg(fresh, NETWORK.chainId)], "qday: register ML-DSA-87 key", "classical");
    } catch (e) {
      throw new Error(`register ML-DSA-87 key for ${fresh.cosmos} failed: ${errorText(e)}`);
    }
    deps.log(`register ML-DSA-87 key: ${regTx}`);
    const status = await waitFor(deps, () => deps.pqcStatus(fresh.cosmos), (s) => s.registered, "the PQC registration to show on REST");
    assertRegisteredKey(status, fresh.pqc.publicKey); // what sign-withdraw will check: registered, proven, same key

    // 4. Unscoped window for the deploy + mint (setup later replaces it with the scoped one).
    const nonceBefore = await deps.evmNonce(owner);
    const winTx = await deps.broadcast(fresh, [openEvmWindowMsg(buildDeployWindowParams(fresh.cosmos))], "qday: deploy window", "hybrid");
    deps.log(`deploy window (unscoped, ${DEPLOY_WINDOW_BLOCKS} blocks, ${DEPLOY_WINDOW_MAX_TXS} txs): ${winTx}`);
    await waitFor(deps, () => deps.windowLive(fresh.cosmos), (live) => live, "the deploy window to be live");
    // Opening the window advances the account's EVM nonce; wait until the EVM RPC sees it.
    await waitFor(deps, () => deps.evmNonce(owner), (n) => n > nonceBefore, "the EVM nonce to advance after the window open");

    // 5. Deploy GuardianVault(owner, guardian), check it (unless --no-vault), mint 100 fUSD.
    let vault: { hash: Hex; address: Hex } | undefined;
    if (!noVault) {
      vault = await deps.deployVault(fresh, owner, guardian!);
      deps.log(`deploy GuardianVault ${vault.address}: ${vault.hash}`);
      checkVaultRoles(await deps.readRoles(vault.address), { owner, guardian: guardian! });
    }
    const mintTx = await deps.mint(fresh, fusd, owner, MINT_AMOUNT);
    deps.log(`mint 100 fUSD to ${owner}: ${mintTx}`);

    // 6. Complete the run's env file (still outside the repo, 0600).
    writeRunFile(
      dir,
      "run.env",
      formatRunEnv({ ...base, ...(vault ? { VAULT_ADDRESS: vault.address } : {}), ATTACKER_ADDR: attacker, SAFE_ADDR: safe, RUN_COMPLETE: "1" }),
    );
    deps.log(`RUN_ENV=${runEnv}`); // only for a complete run: demo.sh keys on this line
    if (noVault) {
      deps.log(
        `next: open http://127.0.0.1:5173/#/protect and import OWNER_MNEMONIC from ${runEnv} into MetaMask (the file holds it; it is not printed)`,
      );
      deps.log(
        `the unscoped deploy window stays open (~14 min, ${DEPLOY_WINDOW_BLOCKS} blocks); close it with: set -a && . ${runEnv} && set +a && pnpm cli window close`,
      );
      deps.log(
        "the Protect screen needs the agent's /config for the guardian before this owner has a vault: `pnpm agent` can run with the root .env now " +
          "(any running agent serves the guardian address)",
      );
      deps.log(
        `after the browser deploy, \`pnpm cli link\` and \`pnpm agent\` need this run.env loaded AND VAULT_ADDRESS=<vault> exported ` +
          "(the root .env's VAULT_ADDRESS would otherwise fill in: tsx --env-file does not override set vars)",
      );
    }
    return { runId, runEnv, owner, vault: vault?.address, attacker, safe };
  } catch (e) {
    deps.log(`incomplete run: ${dir} (run.env has RUN_COMPLETE=0 and the fresh owner's key, to inspect or recover its QOR)`);
    throw e;
  }
}

/** Diana wiring for `freshOwner`. Loads the vault artifact first, so a missing build fails before any tx. */
export function productionFreshDeps(): FreshDeps {
  const artifact = loadVaultArtifact();
  const wallet = (acc: UnifiedAccount) => createWalletClient({ account: privateKeyToAccount(acc.privateKey as Hex), chain, transport: http() });
  const fees = { maxFeePerGas: FRESH_MAX_FEE_PER_GAS, maxPriorityFeePerGas: FRESH_PRIORITY_FEE_PER_GAS };
  return {
    now: () => new Date(),
    newMnemonic: () => generateMnemonic(),
    newAgentKey: newAgentKeyHex,
    randomAddress: () => privateKeyToAccount(generatePrivateKey()).address,
    log: (line) => console.log(line),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    uqorBalance,
    broadcast: (acc, msgs, memo, mode) => broadcast(acc, msgs, memo, mode),
    pqcStatus: (cosmos) => {
      clearPqcStatusCache(); // a cached "not registered" answer would hide the new registration
      return fetchPqcStatus({ rest: NETWORK.rest, address: cosmos });
    },
    windowLive: async (cosmos) => (await evmWindowStatus({ rest: NETWORK.rest, address: cosmos })).live,
    evmNonce: (evm) => publicClient.getTransactionCount({ address: evm, blockTag: "pending" }),
    deployVault: async (acc, owner, guardian) => {
      const hash = await wallet(acc).deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [owner, guardian], gas: DEPLOY_GAS, ...fees });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`vault deploy failed (tx ${hash})`);
      return { hash, address: receipt.contractAddress };
    },
    readRoles: async (vault) => ({
      owner: await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "owner" }),
      guardian: await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "guardian" }),
    }),
    mint: async (acc, token, to, amount) => {
      const hash = await wallet(acc).writeContract({ address: token, abi: mintAbi, functionName: "mint", args: [to, amount], gas: MINT_GAS, ...fees });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`fUSD mint failed (tx ${hash})`);
      return hash;
    },
  };
}

/** `pnpm cli fresh-owner [--no-vault]`. */
export async function runFreshOwner(args: string[] = [], env: Env = process.env): Promise<void> {
  if (args.some((a) => a !== "--no-vault") || args.length > 1) throw new Error("usage: fresh-owner [--no-vault]");
  await freshOwner(env, productionFreshDeps(), { noVault: args.length === 1 });
}
