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

/**
 * Provision the fire drill's own guardian account (never the real guardian: a drill agent sharing it would unscope
 * the real owner's EVM window). Idempotent: create the account only when the file is missing (written 0600 BEFORE
 * any QOR is sent), top it up to `DRILL_GUARDIAN_TARGET_UQOR` only when below it, register its ML-DSA-87 key
 * (classical, bootstrap-exempt, as `fresh-owner` does) only when not registered. Logs addresses and tx hashes only.
 */
export async function drillGuardianInit(env: Env, deps: DrillGuardianDeps) {
  const file = drillGuardianPath(deps.home);
  const existing = existsSync(file);
  const saved = existing ? readDrillFile(file) : undefined;
  const mnemonic = saved ? saved.mnemonic : deps.newMnemonic();
  const drill = await deriveSecret(mnemonic, existing ? "DRILL_GAS_MNEMONIC" : "the generated mnemonic");
  const address = drill.evm as Hex;
  if (saved && saved.address.toLowerCase() !== address.toLowerCase()) {
    throw new Error(`${file}: DRILL_GUARDIAN_ADDRESS does not match DRILL_GAS_MNEMONIC`);
  }

  // The drill guardian must be its own account: refuse any other role's account before anything is written or sent.
  const funderName = env.FUNDER_MNEMONIC?.trim() ? "FUNDER_MNEMONIC" : "OWNER_MNEMONIC";
  const funderMnemonic = env.FUNDER_MNEMONIC?.trim() || env.OWNER_MNEMONIC?.trim();
  const funder = funderMnemonic ? await deriveSecret(funderMnemonic, funderName) : undefined;
  for (const name of ["GAS_MNEMONIC", "OWNER_MNEMONIC", "FUNDER_MNEMONIC"]) {
    const m = env[name]?.trim();
    if (!m) continue;
    const role = name === funderName && funder ? funder : await deriveSecret(m, name);
    if (role.cosmos === drill.cosmos) throw new Error(`the drill guardian account is the ${name} account; it must be its own account`);
  }

  let created = false;
  if (!existing) {
    writeRunFile(
      dirname(file),
      DRILL_GUARDIAN_FILE,
      formatRunEnv({ DRILL_GAS_MNEMONIC: mnemonic, DRILL_GUARDIAN_ADDRESS: address }),
      { exclusive: true },
    );
    created = true;
  }
  deps.log(`drill guardian ${address} (${drill.cosmos}): ${created ? `created ${file}` : `using ${file}`}`);

  // Top up to the target only when below it.
  let fundTx: string | undefined;
  const balance = await deps.uqorBalance(drill.cosmos);
  if (balance < DRILL_GUARDIAN_TARGET_UQOR) {
    if (!funder || !funderMnemonic) throw new Error("FUNDER_MNEMONIC (or OWNER_MNEMONIC) is not set");
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

/** `pnpm cli drill-guardian init`. */
export async function runDrillGuardian(args: string[], env: Env = process.env): Promise<void> {
  if (args.length !== 1 || args[0] !== "init") throw new Error("usage: drill-guardian init");
  await drillGuardianInit(env, productionDrillGuardianDeps());
}
