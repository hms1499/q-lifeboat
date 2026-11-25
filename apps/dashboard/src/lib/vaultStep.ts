import type { TokenSymbol } from "@qday/core";
import type { Hex } from "viem";

const SYMBOLS: TokenSymbol[] = ["fUSD", "fETH", "fBTC"];
/** Deploy + one mint per test token. */
export const VAULT_STEP_TXS = 1 + SYMBOLS.length;

export type VaultStepDeps = {
  /** This owner's vault for its guardian, read fresh from the chain (`locateVault`); throws when it can't read. */
  locate(): Promise<Hex | null>;
  /** Open an owner window of exactly `txs` txs and run `run` in it. */
  withWindow(txs: number, run: () => Promise<Hex[]>): Promise<{ windowTx: string; txs: Hex[] }>;
  /** Send `GuardianVault(owner, guardian)`; resolves to the tx hash. */
  deploy(): Promise<Hex>;
  /** The deployed contract's address once the receipt succeeds; throws on a revert. */
  deployed(tx: Hex): Promise<Hex>;
  /** Remember the vault in this browser. */
  save(vault: Hex): void;
  /** Throws unless the contract's `owner()` and `guardian()` are this owner and its Guardian. */
  checkRoles(vault: Hex): Promise<void>;
  /** `mint(owner, MINT_AMOUNT)` on one token, waited for; resolves to the tx hash, throws on a revert. */
  mint(sym: TokenSymbol): Promise<Hex>;
  progress(step: string, tx?: Hex): void;
};

/**
 * The vault step (onboarding step 6). The chain is read fresh first, so a stale "no vault" (a poll that has not caught
 * up with a deploy, a receipt read that failed) never leads to a second deploy; a read error aborts. The vault is
 * saved as soon as its receipt names it, before anything else can fail, so a retry finds it.
 */
export async function runVaultStep(d: VaultStepDeps): Promise<{ vault: Hex; windowTx: string; txs: Hex[] }> {
  const existing = await d.locate();
  if (existing) throw new Error(`this account already has a vault (${existing}); reload to continue with the next step`);
  let vault: Hex | null = null;
  const out = await d.withWindow(VAULT_STEP_TXS, async () => {
    const sent: Hex[] = [];
    d.progress("Deploying your vault…");
    const tx = await d.deploy();
    sent.push(tx);
    d.progress("Waiting for the deploy…", tx);
    vault = await d.deployed(tx);
    d.save(vault);
    await d.checkRoles(vault);
    for (const s of SYMBOLS) {
      d.progress(`Minting ${s}…`);
      const h = await d.mint(s);
      sent.push(h);
      d.progress(`Minted ${s}`, h);
    }
    return sent;
  });
  return { vault: vault!, ...out };
}
