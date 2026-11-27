import { buildOnboardWindowParams, NETWORK, vaultAbi, WITHDRAW_GAS, withdrawalMessage } from "@qday/core";
import { broadcastTx, chain as diana, publicClient, uqorBalance } from "@qday/core/chain";
import { fetchEvmWindow, fetchPqcStatus, openEvmWindowMsg, pqcStatusPublicKey, pqcVerify, type PqcStatus, type UnifiedAccount } from "@qorechain/sdk";
import { BaseError, ContractFunctionRevertedError, ContractFunctionZeroDataError, createWalletClient, erc20Abi, http, isAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { cosmosOf, type Reply } from "./auth.ts";
import { FUNDER_FLOOR_UQOR } from "./limits.ts";
import { isOwnerAddress, type Store } from "./store.ts";

/**
 * `POST /api/recover/submit`: the one funded path a browser that lost its wallet has. The withdrawal is signed by the
 * owner's recovery-code key, so the service can pay the gas without being able to change where it pays. Nothing here
 * can sign for the owner: it only re-checks the signature against the key registered on chain and sends it.
 */

/** Sponsored withdrawals per owner per UTC day, and overall across owners. */
export const RECOVERS_PER_DAY = 3;
export const RECOVERS_GLOBAL_PER_DAY = 10;
/** How long to wait for the sponsor's window to show live on REST. */
const LIVE_TRIES = 20;
const LIVE_DELAY_MS = 1_000;

export type Submit = { owner: Hex; vault: Hex; to: Hex; token: Hex; amount: bigint; nonce: bigint; sig: Hex };

const KEYS = ["owner", "vault", "to", "token", "amount", "nonce", "sig"];

/** Strict: exactly these seven keys, 0x addresses (EIP-55 checked), decimal amounts, a 4627-byte signature. */
export function parseSubmit(x: unknown): { ok: true; w: Submit } | { ok: false; error: string } {
  if (typeof x !== "object" || x === null || Array.isArray(x)) return { ok: false, error: "the body must hold one JSON object" };
  const o = x as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !KEYS.includes(k));
  if (extra.length) return { ok: false, error: `unexpected key(s): ${extra.join(", ")}` };
  const str = (k: string) => {
    const v = o[k];
    if (typeof v !== "string" || !v) throw new Error(`missing or non-string "${k}"`);
    return v;
  };
  try {
    const addr = (k: string): Hex => {
      const v = str(k);
      if (!/^0x[0-9a-fA-F]{40}$/.test(v) || !isAddress(v)) throw new Error(`"${k}" is not a 0x 20-byte address (or its checksum is wrong)`);
      return v as Hex;
    };
    const dec = (k: string): bigint => {
      const v = str(k);
      if (!/^\d{1,78}$/.test(v)) throw new Error(`"${k}" must be a decimal integer string`);
      return BigInt(v);
    };
    const w: Submit = { owner: addr("owner"), vault: addr("vault"), to: addr("to"), token: addr("token"), amount: dec("amount"), nonce: dec("nonce"), sig: str("sig") as Hex };
    if (!isOwnerAddress(w.owner)) throw new Error(`"owner" is not a hex address`);
    if (/^0x0{40}$/.test(w.to)) throw new Error(`"to" is the zero address: the funds would be burned`);
    if (w.amount === 0n) throw new Error(`"amount" must be greater than zero`);
    if (!/^0x([0-9a-fA-F]{2})+$/.test(w.sig) || (w.sig.length - 2) / 2 !== 4627) throw new Error(`"sig" must be 0x hex of exactly 4627 bytes`);
    return { ok: true, w };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export type RecoverDeps = {
  store: Store;
  chain: {
    readVault(vault: Hex): Promise<{ owner: Hex; guardian: Hex } | null>;
    /** `vault.withdrawalMessage(to, token, amount, nonce)` on chain. */
    readWithdrawalMessage(w: Submit): Promise<Hex>;
    readNonce(vault: Hex): Promise<bigint>;
    /** ERC-20 `balanceOf(vault)`; the vault's native balance for the zero address. */
    readVaultBalance(vault: Hex, token: Hex): Promise<bigint>;
    pqcStatus(cosmos: string): Promise<PqcStatus>;
    funderUqor(): Promise<bigint>;
    /** Open a 1-tx window for the sponsor, send `vault.withdraw`, wait for its receipt. */
    submit(w: Submit): Promise<{ hash: Hex; status: "success" | "reverted" }>;
  };
  /** ML-DSA-87 verification (default `pqcVerify`). */
  verify?(pk: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean;
  /** Milliseconds. */
  now(): number;
  log?(line: string): void;
};

const DAY_MS = 24 * 3600 * 1000;
const err = (code: number, error: string): Reply => ({ code, body: { error } });
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const norm = (h: string) => h.replace(/^0x/i, "").toLowerCase();

export function createRecoverer(deps: RecoverDeps) {
  const { store, chain } = deps;
  const log = deps.log ?? (() => {});
  const verify = deps.verify ?? pqcVerify;

  return {
    async submit(x: unknown): Promise<Reply> {
      const parsed = parseSubmit(x);
      if (!parsed.ok) return err(400, parsed.error);
      const w = parsed.w;
      const state = store.get(w.owner);
      if (!state) return err(404, "unknown owner");
      if (state.stage !== "active" && state.stage !== "retired") return err(409, "not-active");

      let roles: { owner: Hex; guardian: Hex } | null;
      let onChainMsg: Hex;
      let status: PqcStatus;
      let nonce: bigint;
      let balance: bigint;
      try {
        roles = await chain.readVault(w.vault);
        if (!roles) return err(422, "recover-vault");
        if (roles.owner.toLowerCase() !== w.owner.toLowerCase()) return err(422, "recover-vault");
        onChainMsg = await chain.readWithdrawalMessage(w);
        status = await chain.pqcStatus(cosmosOf(w.owner));
        nonce = await chain.readNonce(w.vault);
        balance = await chain.readVaultBalance(w.vault, w.token);
      } catch (e) {
        log(`recover reads for ${w.owner} failed: ${errorText(e)}`);
        return err(502, "chain unreachable");
      }

      const pk = pqcStatusPublicKey(status);
      if (!status.registered || status.possessionProven !== true || !pk) return err(422, "recover-signature");
      // The signature binds chain id, vault, recipient, token, amount and nonce: these are the exact values the service sends.
      const local = withdrawalMessage({ chainId: BigInt(NETWORK.evmChainId), vault: w.vault, to: w.to, token: w.token, amount: w.amount, nonce: w.nonce });
      if (norm(onChainMsg) !== norm(Buffer.from(local).toString("hex"))) return err(422, "recover-message");
      if (!verify(pk, local, Buffer.from(w.sig.slice(2), "hex"))) return err(422, "recover-signature");
      if (nonce !== w.nonce) return err(422, "recover-nonce");
      if (w.amount > balance) return err(422, "recover-balance");

      // Caps, re-read here so a concurrent submit sees the same store: counted before the send, so a failure still costs one.
      const day = Math.floor(deps.now() / DAY_MS);
      const perOwner = state.restores?.day === day ? state.restores.n : 0;
      if (perOwner >= RECOVERS_PER_DAY) return err(429, "recover-cap");
      const global = store.list().reduce((sum, s) => sum + (s.restores?.day === day ? s.restores.n : 0), 0);
      if (global >= RECOVERS_GLOBAL_PER_DAY) return err(429, "recover-cap");
      let funderUqor: bigint;
      try {
        funderUqor = await chain.funderUqor();
      } catch (e) {
        log(`funder balance unreadable: ${errorText(e)}`);
        return err(502, "chain unreachable");
      }
      if (funderUqor < FUNDER_FLOOR_UQOR) return err(503, "funder-low");
      const fresh = store.get(w.owner) ?? state;
      const used = fresh.restores?.day === day ? fresh.restores.n : 0;
      if (used >= RECOVERS_PER_DAY) return err(429, "recover-cap");
      store.put({ ...fresh, restores: { day, n: used + 1 } });

      try {
        const r = await chain.submit(w);
        log(`sponsored withdrawal for ${w.owner}: ${r.status} in ${r.hash}`);
        return { code: 200, body: { hash: r.hash, status: r.status } };
      } catch (e) {
        const s = store.get(w.owner);
        if (s && s.restores?.day === day) store.put({ ...s, restores: { day, n: Math.max(0, s.restores.n - 1) } });
        log(`sponsored withdrawal for ${w.owner} failed: ${errorText(e)}`);
        return err(502, "withdraw failed");
      }
    },
  };
}

export type Recoverer = ReturnType<typeof createRecoverer>;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Diana wiring: reads through `@qday/core/chain`, and sends from the funder's own EVM account inside a 1-tx window
 * scoped to the vault (the window is the chain's budget for one EVM tx from an account). One send at a time: they share
 * the funder's EVM nonce.
 */
export function productionRecoverDeps(store: Store, funder: UnifiedAccount): RecoverDeps {
  const wallet = createWalletClient({ account: privateKeyToAccount(funder.privateKey as Hex), chain: diana, transport: http(NETWORK.evmRpc) });
  let queue: Promise<unknown> = Promise.resolve();

  const send = async (w: Submit): Promise<{ hash: Hex; status: "success" | "reverted" }> => {
    const fees = await publicClient.estimateFeesPerGas();
    const params = buildOnboardWindowParams(funder.cosmos, { blocks: 600, txs: 1, topupUqor: 0n });
    const windowTx = await broadcastTx(funder, [openEvmWindowMsg({ ...params, allowedTargets: [w.vault] })], "qlifeboat: sponsored withdrawal window", { signMode: "hybrid" });
    let live = false;
    for (let i = 0; i < LIVE_TRIES && !live; i++) {
      if (i) await sleep(LIVE_DELAY_MS);
      live = (await fetchEvmWindow({ rest: NETWORK.rest, address: funder.cosmos })).live;
    }
    if (!live) throw new Error(`the window in tx ${windowTx} did not go live`);
    const hash = await wallet.writeContract({
      address: w.vault,
      abi: vaultAbi,
      functionName: "withdraw",
      args: [w.to, w.token, w.amount, w.sig],
      gas: WITHDRAW_GAS,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    const r = await publicClient.waitForTransactionReceipt({ hash });
    return { hash, status: r.status };
  };

  return {
    store,
    chain: {
      readVault: async (vault) => {
        try {
          const [owner, guardian] = await Promise.all([
            publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "owner" }),
            publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "guardian" }),
          ]);
          return { owner: owner as Hex, guardian: guardian as Hex };
        } catch (e) {
          // The node answered: no code at the address (zero data) or the call reverted. Anything else is transport.
          if (e instanceof BaseError && e.walk((c) => c instanceof ContractFunctionZeroDataError || c instanceof ContractFunctionRevertedError)) return null;
          throw e;
        }
      },
      readWithdrawalMessage: (x) => publicClient.readContract({ address: x.vault, abi: vaultAbi, functionName: "withdrawalMessage", args: [x.to, x.token, x.amount, x.nonce] }),
      readNonce: (vault) => publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "nonce" }),
      readVaultBalance: (vault, token) =>
        /^0x0{40}$/.test(token)
          ? publicClient.getBalance({ address: vault })
          : publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [vault] }),
      pqcStatus: (cosmos) => fetchPqcStatus({ rest: NETWORK.rest, address: cosmos }),
      funderUqor: () => uqorBalance(funder.cosmos),
      submit: (w) => {
        const run = queue.then(() => send(w));
        queue = run.catch(() => {});
        return run;
      },
    },
    now: Date.now,
  };
}
