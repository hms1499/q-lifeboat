import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Hex } from "viem";
import type { OwnerStage } from "@qday/core";

/** Server-side record of one owner's hosted Guardian. Never sent to the browser as is. */
export type OwnerState = {
  owner: Hex;
  stage: OwnerStage;
  /** Set only by a successful `/api/starter`: onboard and topup require it, so they sit under the starter caps. */
  starter?: boolean;
  guardian?: Hex;
  vault?: Hex;
  /** The agent's loopback port (9100 upward), kept across restarts. */
  port?: number;
  /** Set by a signed `stop`: the supervisor does not start this owner on boot. A signed `arm` clears it. */
  stopped?: boolean;
  /** Retired, but the guardian's QOR was not yet swept back to the funder: `retireIdle` retries it. */
  sweepPending?: boolean;
  createdAt: number;
  lastActiveAt: number;
  topups: number;
  /** Arm refills of the guardian's gas on UTC day `day` (days since the epoch). */
  refills?: { day: number; n: number };
};

export type OwnerSecrets = { GAS_MNEMONIC: string; AGENT_ED25519_SK: string };

const OWNER_RE = /^0x[0-9a-fA-F]{40}$/;

export const isOwnerAddress = (s: string): boolean => OWNER_RE.test(s);

const key = (owner: string): string => {
  if (!OWNER_RE.test(owner)) throw new Error(`invalid owner address: ${owner}`);
  return owner.toLowerCase();
};

/** Temp file + rename: a crash leaves either the old file or the new one, never a torn file. */
function atomicWrite(path: string, data: string, mode: number): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function createStore(dir: string) {
  const root = join(resolve(dir), "owners");
  mkdirSync(root, { recursive: true });
  const ownerDir = (owner: string) => join(root, key(owner));
  const ensure = (owner: string) => {
    const d = ownerDir(owner);
    mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  };
  return {
    /** The owner's directory (absolute, created 0700): secrets, state and the agent's incidents file. */
    dir(owner: string): string {
      return ensure(owner);
    },
    get(owner: string): OwnerState | null {
      return readJson<OwnerState>(join(ownerDir(owner), "state.json"));
    },
    put(state: OwnerState): void {
      const s = { ...state, owner: key(state.owner) as Hex };
      atomicWrite(join(ensure(s.owner), "state.json"), JSON.stringify(s, null, 2), 0o600);
    },
    list(): OwnerState[] {
      const out: OwnerState[] = [];
      for (const name of readdirSync(root)) {
        if (!OWNER_RE.test(name)) continue;
        const s = readJson<OwnerState>(join(root, name, "state.json"));
        if (s) out.push(s);
      }
      return out;
    },
    writeSecrets(owner: string, secrets: OwnerSecrets): void {
      atomicWrite(join(ensure(owner), "secrets.json"), JSON.stringify(secrets), 0o600);
    },
    readSecrets(owner: string): OwnerSecrets | null {
      return readJson<OwnerSecrets>(join(ownerDir(owner), "secrets.json"));
    },
  };
}

export type Store = ReturnType<typeof createStore>;
