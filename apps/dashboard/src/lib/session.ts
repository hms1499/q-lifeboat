import {
  generatePqcRecoveryCode,
  normalizeRecoveryCode,
  pqcStatusPublicKey,
  unifiedAccountFromSeed,
  type PqcStatus,
  type UnifiedAccount,
} from "@qorechain/sdk";
import { bytesToHex, type Hex } from "viem";
import { decryptSeed, DEFAULT_ITERATIONS, encryptSeed, indexedDbStore, type KvStore } from "./keystore";

const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

export type SessionOptions = { store?: KvStore; iter?: number };

/** Holds the decrypted seed and the derived account in memory only. */
export function createSession(opts: SessionOptions = {}) {
  const store = opts.store ?? indexedDbStore();
  const iter = opts.iter ?? DEFAULT_ITERATIONS;
  let seed: Uint8Array | null = null;
  let acct: UnifiedAccount | null = null;

  const clear = () => {
    seed?.fill(0);
    seed = null;
    acct = null;
  };

  return {
    /** New seed + recovery code. The code is returned once; neither it nor the PQ key is kept or stored. */
    async create(password: string): Promise<{ evm: Hex; code: string }> {
      clear();
      const s = crypto.getRandomValues(new Uint8Array(32));
      const code = generatePqcRecoveryCode();
      unifiedAccountFromSeed(s, { recoveryCode: code }); // refuses a seed equal to the PQ secret
      const e = await encryptSeed(s, password, iter);
      await store.put(e);
      seed = s;
      return { evm: e.evm, code };
    },

    async unlock(password: string): Promise<void> {
      const e = await store.get();
      if (!e) throw new Error("no wallet on this device");
      const s = await decryptSeed(e, password);
      clear();
      seed = s;
    },

    /** Derive the ML-DSA key from the code. Nothing is derived when the code is bad or the account differs. */
    providePqc(code: string, registered: PqcStatus | null): void {
      if (!seed) throw new Error("wallet is locked");
      normalizeRecoveryCode(code); // early, readable error on a malformed code
      const a = unifiedAccountFromSeed(seed, { recoveryCode: code }); // throws on a checksum mismatch
      if (registered?.registered) {
        const onChain = pqcStatusPublicKey(registered);
        if (!onChain || !sameBytes(onChain, a.pqc.publicKey)) {
          throw new Error("this recovery code does not belong to this account");
        }
      }
      acct = a;
    },

    account: (): UnifiedAccount | null => acct,

    classical(): { evm: Hex; privateKey: Hex } | null {
      if (!seed) return null;
      const privateKey = bytesToHex(seed);
      return { evm: (acct?.evm as Hex | undefined) ?? deriveEvm(seed), privateKey };
    },

    lock: clear,
  };
}

function deriveEvm(seed: Uint8Array): Hex {
  // The address depends on the seed only; a throwaway PQ secret is enough to build the account and is not kept.
  return unifiedAccountFromSeed(seed, { recoveryCode: generatePqcRecoveryCode() }).evm as Hex;
}

export type Session = ReturnType<typeof createSession>;

/** Three distinct group numbers (1-14) the user must re-type to prove they saved the code. */
export function confirmPicks(code: string): number[] {
  normalizeRecoveryCode(code);
  const picks = new Set<number>();
  const buf = new Uint32Array(1);
  while (picks.size < 3) {
    crypto.getRandomValues(buf);
    picks.add((buf[0] % 14) + 1);
  }
  return [...picks].sort((a, b) => a - b);
}

export function checkConfirm(code: string, picks: number[], typed: string[]): boolean {
  if (picks.length !== typed.length) return false;
  const norm = normalizeRecoveryCode(code);
  return picks.every((p, i) => {
    if (!Number.isInteger(p) || p < 1 || p > 14) return false;
    const want = norm.slice((p - 1) * 4, p * 4);
    let got: string;
    try {
      got = typed[i].toUpperCase().replace(/[\s\-_.]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
    } catch {
      return false;
    }
    return got === want;
  });
}
