import { resolve } from "node:path";

/**
 * Resolve a user-supplied path against the directory the user ran the command from.
 * `pnpm -F` changes the cwd to apps/cli, but pnpm exports the original directory as INIT_CWD.
 */
export function resolveUserPath(p: string, env: Record<string, string | undefined> = process.env): string {
  return resolve(env.INIT_CWD ?? process.cwd(), p);
}
