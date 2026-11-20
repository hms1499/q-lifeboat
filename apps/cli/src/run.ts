import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Env = Record<string, string | undefined>;

/** The repo root. Run files hold a fresh owner's mnemonic, so they must never land under it. */
const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../..");
const RUN_ID_RE = /^[0-9A-Za-z_-]+$/;
const KEY_RE = /^[A-Z_][A-Z0-9_]*$/;

/** A demo run's id: the UTC start time, e.g. `20261120T080509Z`. */
export function newRunId(now: Date = new Date()): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** `~/.config/qday/runs/<runId>`: outside the repo, so nothing a run writes can be committed. */
export function runDir(runId: string, home: string = homedir()): string {
  if (!RUN_ID_RE.test(runId)) throw new Error(`invalid run id "${runId}"`);
  const dir = join(resolve(home), ".config", "qday", "runs", runId);
  if (!relative(REPO_ROOT, dir).startsWith("..")) throw new Error(`run directory ${dir} is inside the repo; refusing`);
  return dir;
}

/** The current run's directory, from RUN_ID (set by run.env). */
export function runDirFromEnv(env: Env = process.env, home?: string): string {
  const id = env.RUN_ID?.trim();
  if (!id) throw new Error("RUN_ID is not set (load the run.env written by `pnpm cli fresh-owner`)");
  return runDir(id, home);
}

/**
 * `KEY="value"` lines that `set -a; . run.env` and `node --env-file` both read the same way. Values a shell
 * would expand or that would break the line are refused rather than escaped.
 */
export function formatRunEnv(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([k, v]) => {
      if (!KEY_RE.test(k)) throw new Error(`invalid env key "${k}"`);
      if (/["$`\\\n\r]/.test(v)) throw new Error(`${k} contains a character run.env cannot hold`);
      return `${k}="${v}"\n`;
    })
    .join("");
}

/** Write `name` in `dir` (created 0700) with mode 0600, and return its path. */
export function writeRunFile(dir: string, name: string, content: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, name);
  writeFileSync(file, content, { mode: 0o600 });
  chmodSync(file, 0o600); // an existing file keeps its old mode otherwise
  return file;
}
