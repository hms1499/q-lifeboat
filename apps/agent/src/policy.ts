import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { Hex } from "viem";
import type { Policy } from "./rules";

/** A wallet or app the owner trusts: transfers to it (within maxOutbound) and approvals to it never trigger a rescue. */
export type TrustedEntry = { label: string; address: Hex; kind: "wallet" | "app" };
/** The owner-editable policy file (`data/policy-<owner>.json`). `maxOutbound` is wei, a decimal integer string. */
export type PolicyFile = { trusted: TrustedEntry[]; maxOutbound: string };

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const MAX_ENTRIES = 200;
const MAX_LABEL = 64;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function exactKeys(o: Record<string, unknown>, keys: string[], where: string): void {
  const unknown = Object.keys(o).filter((k) => !keys.includes(k));
  if (unknown.length) throw new Error(`${where}: unknown key(s) ${unknown.join(", ")}`);
  for (const k of keys) if (!(k in o)) throw new Error(`${where}: missing ${k}`);
}

/** Validate an untrusted policy (file content or PUT body). Throws an Error naming the first problem. */
export function parsePolicy(json: unknown): PolicyFile {
  if (!isObject(json)) throw new Error("policy must be an object {trusted, maxOutbound}");
  exactKeys(json, ["trusted", "maxOutbound"], "policy");
  const { trusted, maxOutbound } = json;
  if (!Array.isArray(trusted)) throw new Error("policy.trusted must be an array");
  if (trusted.length > MAX_ENTRIES) throw new Error(`policy.trusted has more than ${MAX_ENTRIES} entries`);
  const seen = new Set<string>();
  const entries = trusted.map((e: unknown, i): TrustedEntry => {
    const where = `policy.trusted[${i}]`;
    if (!isObject(e)) throw new Error(`${where} must be an object {label, address, kind}`);
    exactKeys(e, ["label", "address", "kind"], where);
    if (typeof e.label !== "string") throw new Error(`${where}.label must be a string`);
    const label = e.label.trim();
    if (label.length < 1 || label.length > MAX_LABEL) throw new Error(`${where}.label must be 1..${MAX_LABEL} characters`);
    if (typeof e.address !== "string" || !ADDRESS_RE.test(e.address)) throw new Error(`${where}.address must be a 0x address`);
    if (e.kind !== "wallet" && e.kind !== "app") throw new Error(`${where}.kind must be "wallet" or "app"`);
    const key = e.address.toLowerCase();
    if (seen.has(key)) throw new Error(`${where}.address ${e.address} is a duplicate`);
    seen.add(key);
    return { label, address: e.address as Hex, kind: e.kind };
  });
  if (typeof maxOutbound !== "string" || !/^\d{1,78}$/.test(maxOutbound)) {
    throw new Error("policy.maxOutbound must be a decimal integer string (wei)");
  }
  return { trusted: entries, maxOutbound };
}

/** One file per owner: demo.sh makes a fresh owner each run and shares data/. */
export function policyFilePath(dataDir: string, owner: Hex): string {
  if (!ADDRESS_RE.test(owner)) throw new Error("policy owner must be a 0x address");
  return join(dataDir, `policy-${owner.toLowerCase()}.json`);
}

/** The env seed (ALLOWLIST / MAX_OUTBOUND) for a missing policy file. */
export function seedPolicy(allowlist: Hex[], maxOutbound: bigint): PolicyFile {
  const seen = new Set<string>();
  const trusted: TrustedEntry[] = [];
  for (const address of allowlist) {
    if (seen.has(address.toLowerCase())) continue;
    seen.add(address.toLowerCase());
    trusted.push({ label: "ALLOWLIST", address, kind: "wallet" });
  }
  return { trusted, maxOutbound: maxOutbound.toString() };
}

/** The rules.ts view: wallets and apps alike go to the allowlist. `guardian`: the vault's immutable guardian. */
export function toRulesPolicy(vault: Hex, guardian: Hex, p: PolicyFile): Policy {
  return { vault, guardian, allowlist: p.trusted.map((t) => t.address), maxOutbound: BigInt(p.maxOutbound) };
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const fingerprint = (s: Stats) => `${s.mtimeMs}:${s.size}:${s.ino}`;

/** Temp file in the same directory, then rename: a reader sees the old file or the new one, never half of one. */
function writeAtomic(file: string, p: PolicyFile): void {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(p, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // nothing to clean up
    }
    throw e;
  }
}

function readPolicy(file: string): PolicyFile {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`policy file ${file} is not valid JSON: ${errorText(e)}`);
  }
  return parsePolicy(json);
}

export type PolicyStore = { get(): PolicyFile; set(input: unknown): PolicyFile };

/**
 * The owner's policy on disk. A missing file is created from `seed`; an invalid file at startup throws (the agent
 * refuses to start). `get()` re-reads the file only when its (mtime, size, inode) changed, and keeps the last good
 * policy when it turns invalid or goes missing (logged once per change). It never throws.
 */
export function createPolicyStore(opts: { file: string; seed: PolicyFile; log: (line: string) => void }): PolicyStore {
  const { file, log } = opts;
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true });
    writeAtomic(file, parsePolicy(opts.seed));
    log(`policy ${file} created from ALLOWLIST / MAX_OUTBOUND`);
  }
  let seen = fingerprint(statSync(file)); // stat before read: a write in between is picked up by the next get()
  let current = readPolicy(file);

  return {
    get() {
      let now: string;
      try {
        now = fingerprint(statSync(file));
      } catch (e) {
        if (seen !== "missing") log(`policy ${file} unreadable, keeping the last good policy: ${errorText(e)}`);
        seen = "missing";
        return current;
      }
      if (now === seen) return current;
      seen = now;
      try {
        current = readPolicy(file);
        log(`policy reloaded: ${current.trusted.length} trusted, maxOutbound ${current.maxOutbound}`);
      } catch (e) {
        log(`policy ${file} invalid, keeping the last good policy: ${errorText(e)}`);
      }
      return current;
    },
    set(input) {
      const p = parsePolicy(input);
      writeAtomic(file, p);
      current = p;
      seen = fingerprint(statSync(file));
      log(`policy updated: ${p.trusted.length} trusted, maxOutbound ${p.maxOutbound}`);
      return p;
    },
  };
}
