import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { NETWORK } from "@qday/core";
import { clearPqcStatusCache, fetchPqcStatus, generateMnemonic, type PqcStatus, type UnifiedAccount } from "@qorechain/sdk";
import { formatUnits, type Hex } from "viem";
import { broadcast, uqorBalance } from "./chain";
import { buildFundMsg, buildRegisterMsg, checkFunderBalance, deriveSecret, waitFor } from "./fresh";
import { assertOutsideRepo, formatRunEnv, writeRunFile } from "./run";
import { assertRegisteredKey } from "./signer";

type Env = Record<string, string | undefined>;
type Msg = { typeUrl: string; value: unknown };

export const DRILL_GUARDIAN_FILE = "drill-guardian.env";
/** What the drill guardian is topped up to: one drill costs it a window open (~0.225 QOR) plus rescue gas. */
export const DRILL_GUARDIAN_TARGET_UQOR = 2_000_000n;
/** Below this `drill-guardian check` (run by `demo.sh --drill` before the funder pays anything) refuses the drill. */
export const DRILL_GUARDIAN_MIN_UQOR = 500_000n;

const qor = (uqor: bigint) => `${formatUnits(uqor, 6)} QOR`;

/** `~/.config/qday/drill-guardian.env`: outside the repo, so it can never be committed. */
export function drillGuardianPath(home: string = homedir()): string {
  const file = join(resolve(home), ".config", "qday", DRILL_GUARDIAN_FILE);
  assertOutsideRepo(file);
  return file;
}

export type DrillGuardianDeps = {
  /** Base for ~/.config/qday (tests use a temp dir). */
  home?: string;
  newMnemonic(): string;
  log(line: string): void;
  sleep(ms: number): Promise<void>;
  uqorBalance(cosmos: string): Promise<bigint>;
  broadcast(acc: UnifiedAccount, msgs: Msg[], memo: string, mode: "hybrid" | "classical"): Promise<string>;
  pqcStatus(cosmos: string): Promise<PqcStatus>;
};

/** Read `KEY="value"` lines (the `formatRunEnv` format) of an existing drill guardian file. */
function readDrillFile(file: string): { mnemonic: string; address: string } {
  if ((statSync(file).mode & 0o077) !== 0) throw new Error(`${file} must be mode 0600 (it holds a mnemonic): run chmod 600 on it`);
  const vars: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^([A-Z_][A-Z0-9_]*)="(.*)"$/.exec(line);
    if (m) vars[m[1]] = m[2];
  }
  if (!vars.DRILL_GAS_MNEMONIC || !vars.DRILL_GUARDIAN_ADDRESS) {
    throw new Error(`${file} must hold DRILL_GAS_MNEMONIC and DRILL_GUARDIAN_ADDRESS`);
  }
  return { mnemonic: vars.DRILL_GAS_MNEMONIC, address: vars.DRILL_GUARDIAN_ADDRESS };
}

/** The drill guardian file's account, derived from its mnemonic and checked against its address. Never logs a secret. */
async function loadDrillGuardian(file: string): Promise<UnifiedAccount> {
  const saved = readDrillFile(file);
  const drill = await deriveSecret(saved.mnemonic, "DRILL_GAS_MNEMONIC");
  if (saved.address.toLowerCase() !== drill.evm.toLowerCase()) {
    throw new Error(`${file}: DRILL_GUARDIAN_ADDRESS does not match DRILL_GAS_MNEMONIC`);
  }
  return drill;
}

/**
 * The account that pays for drills: FUNDER_MNEMONIC only, never the OWNER_MNEMONIC fallback `fresh-owner` has for a
 * plain demo. It must not be the watched owner (OWNER_EVM_ADDRESS, or the root OWNER_MNEMONIC account): a drill
 * spends ~2 QOR of the funder and must never spend the watched owner's QOR.
 */
async function drillFunder(env: Env): Promise<UnifiedAccount> {
  const mnemonic = env.FUNDER_MNEMONIC?.trim();
  if (!mnemonic) {
    throw new Error("FUNDER_MNEMONIC is not set: a drill is funded by FUNDER_MNEMONIC only, never by the watched owner (OWNER_MNEMONIC)");
  }
  const funder = await deriveSecret(mnemonic, "FUNDER_MNEMONIC");
  const watched = env.OWNER_EVM_ADDRESS?.trim();
  if (watched && watched.toLowerCase() === funder.evm.toLowerCase()) {
    throw new Error(`the funder (FUNDER_MNEMONIC) ${funder.evm} is the watched owner (OWNER_EVM_ADDRESS): use a separate funder account`);
  }
  const ownerMnemonic = env.OWNER_MNEMONIC?.trim();
  if (ownerMnemonic && (await deriveSecret(ownerMnemonic, "OWNER_MNEMONIC")).cosmos === funder.cosmos) {
    throw new Error(`the funder (FUNDER_MNEMONIC) ${funder.evm} is the watched owner (OWNER_MNEMONIC): use a separate funder account`);
  }
  return funder;
}

/**
 * Provision the fire drill's own guardian account (never the real guardian: a drill agent sharing it would unscope
 * the real owner's EVM window). Idempotent: create the account only when the file is missing (written 0600 BEFORE
 * any QOR is sent), top it up to `DRILL_GUARDIAN_TARGET_UQOR` only when below it, register its ML-DSA-87 key
 * (classical, bootstrap-exempt, as `fresh-owner` does) only when not registered. Logs addresses and tx hashes only.
 */
export async function drillGuardianInit(env: Env, deps: DrillGuardianDeps) {
  // The funder first: no FUNDER_MNEMONIC (or the watched owner as funder) refuses before anything is written or sent.
  const funder = await drillFunder(env);
  const file = drillGuardianPath(deps.home);
  const existing = existsSync(file);
  const mnemonic = existing ? undefined : deps.newMnemonic();
  const drill = mnemonic ? await deriveSecret(mnemonic, "the generated mnemonic") : await loadDrillGuardian(file);
  const address = drill.evm as Hex;

  // The drill guardian must be its own account: refuse any other role's account before anything is written or sent.
  for (const name of ["GAS_MNEMONIC", "OWNER_MNEMONIC", "FUNDER_MNEMONIC"]) {
    const m = env[name]?.trim();
    if (!m) continue;
    const role = name === "FUNDER_MNEMONIC" ? funder : await deriveSecret(m, name);
    if (role.cosmos === drill.cosmos) throw new Error(`the drill guardian account is the ${name} account; it must be its own account`);
  }

  let created = false;
  if (!existing) {
    writeRunFile(
      dirname(file),
      DRILL_GUARDIAN_FILE,
      formatRunEnv({ DRILL_GAS_MNEMONIC: mnemonic as string, DRILL_GUARDIAN_ADDRESS: address }),
      { exclusive: true },
    );
    created = true;
  }
  deps.log(`drill guardian ${address} (${drill.cosmos}): ${created ? `created ${file}` : `using ${file}`}`);

  // Top up to the target only when below it.
  let fundTx: string | undefined;
  const balance = await deps.uqorBalance(drill.cosmos);
  if (balance < DRILL_GUARDIAN_TARGET_UQOR) {
    const topUp = DRILL_GUARDIAN_TARGET_UQOR - balance;
    checkFunderBalance(await deps.uqorBalance(funder.cosmos), topUp, "the drill guardian");
    fundTx = await deps.broadcast(funder, [buildFundMsg(funder.cosmos, drill.cosmos, topUp)], "qday: fund drill guardian", "hybrid");
    deps.log(`fund ${qor(topUp)} from ${funder.cosmos}: ${fundTx}`);
    await waitFor(deps, () => deps.uqorBalance(drill.cosmos), (b) => b >= DRILL_GUARDIAN_TARGET_UQOR, "the drill guardian's balance");
  } else {
    deps.log(`balance ${qor(balance)} is at or above the target ${qor(DRILL_GUARDIAN_TARGET_UQOR)}: no top-up`);
  }

  // Register its ML-DSA-87 key (own tx, signed classically) only when missing; it needs the fee funded above.
  let registerTx: string | undefined;
  let status = await deps.pqcStatus(drill.cosmos);
  if (!status.registered) {
    try {
      registerTx = await deps.broadcast(drill, [buildRegisterMsg(drill, NETWORK.chainId)], "qday: register ML-DSA-87 key", "classical");
    } catch (e) {
      throw new Error(`register ML-DSA-87 key for ${drill.cosmos} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    deps.log(`register ML-DSA-87 key: ${registerTx}`);
    status = await waitFor(deps, () => deps.pqcStatus(drill.cosmos), (s) => s.registered, "the PQC registration to show on REST");
  } else {
    deps.log("ML-DSA-87 key already registered");
  }
  assertRegisteredKey(status, drill.pqc.publicKey);

  return { address, cosmos: drill.cosmos, created, fundTx, registerTx };
}

/**
 * `drill-guardian check` (read-only, run by `demo.sh --drill` before `fresh-owner`): the funder is FUNDER_MNEMONIC
 * and not the watched owner, the drill guardian file is sound, and the drill guardian holds at least
 * `DRILL_GUARDIAN_MIN_UQOR`. Throws otherwise, so a dry drill guardian stops the drill before the funder pays anything.
 * Logs the address and balance only.
 */
export async function drillGuardianCheck(env: Env, deps: Pick<DrillGuardianDeps, "home" | "log" | "uqorBalance">) {
  await drillFunder(env);
  const file = drillGuardianPath(deps.home);
  if (!existsSync(file)) throw new Error(`no drill guardian file ${file} (create and fund it: run pnpm cli drill-guardian init)`);
  const drill = await loadDrillGuardian(file);
  const balance = await deps.uqorBalance(drill.cosmos);
  if (balance < DRILL_GUARDIAN_MIN_UQOR) {
    throw new Error(`drill guardian has ${qor(balance)}, needs at least ${qor(DRILL_GUARDIAN_MIN_UQOR)}: run pnpm cli drill-guardian init`);
  }
  deps.log(`drill guardian ${drill.evm} has ${qor(balance)} (at least ${qor(DRILL_GUARDIAN_MIN_UQOR)})`);
  return { address: drill.evm as Hex, cosmos: drill.cosmos, balance };
}

/** Diana wiring for `drillGuardianInit`. */
export function productionDrillGuardianDeps(): DrillGuardianDeps {
  return {
    newMnemonic: () => generateMnemonic(),
    log: (line) => console.log(line),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    uqorBalance,
    broadcast: (acc, msgs, memo, mode) => broadcast(acc, msgs, memo, mode),
    pqcStatus: (cosmos) => {
      clearPqcStatusCache(); // a cached "not registered" answer would hide the new registration
      return fetchPqcStatus({ rest: NETWORK.rest, address: cosmos });
    },
  };
}

/** `pnpm cli drill-guardian init|check`. */
export async function runDrillGuardian(args: string[], env: Env = process.env): Promise<void> {
  if (args.length !== 1 || (args[0] !== "init" && args[0] !== "check")) throw new Error("usage: drill-guardian init|check");
  if (args[0] === "check") await drillGuardianCheck(env, productionDrillGuardianDeps());
  else await drillGuardianInit(env, productionDrillGuardianDeps());
}
