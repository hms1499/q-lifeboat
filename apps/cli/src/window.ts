import { loadOwner, loadTokens, loadVault, NETWORK, vaultAbi } from "@qday/core";
import { evmWindowCost, evmWindowStatus, MAX_EVM_WINDOW_BLOCKS, MAX_EVM_WINDOW_TXS } from "@qorechain/evm";
import { closeEvmWindowMsg, openEvmWindowMsg } from "@qorechain/sdk";
import { formatUnits, type Hex } from "viem";
import { broadcast as chainBroadcast, publicClient } from "./chain";

type Env = Record<string, string | undefined>;
type Tokens = { fUSD: string; fETH: string; fBTC: string };

/** ~42 min at 1.4 s blocks: room to click MetaMask txs by hand (600 blocks ran out mid-session). */
export const OWNER_WINDOW_BLOCKS = 1800;
/** A recover withdraw, a manual rescue, an approve or a guardian top-up each take one. */
export const OWNER_WINDOW_TXS = 5;
/** The onboarding window: 1 vault deploy, 3 approvals, 1 guardian top-up. */
export const ONBOARD_WINDOW_TXS = 5;
/** Same per-tx budget as `setup`: a 3M-gas tx at 112.5 gwei. */
const PER_TX_GAS = 3_000_000n;
const PER_TX_MAX_FEE = 112_500_000_000n;

/** The most `--topup` headroom one window may carry: a leaked ECDSA key can spend it while the window is open. */
export const MAX_TOPUP_QOR = 100n;
const UQOR_PER_QOR = 1_000_000n;
const WEI_PER_UQOR = 1_000_000_000_000n;

/**
 * `expect`: the owner the caller means (the dashboard's watched owner); the command refuses any other account.
 * `onboard`: `--onboard`, an UNSCOPED window (no `allowedTargets`) so MetaMask can deploy the vault.
 * `topupUqor`: value headroom for a QOR top-up of the guardian, on top of the fee budget (0n without `--topup`).
 */
export type WindowArgs = { action: "open"; onboard: boolean; blocks: number; txs: number; topupUqor: bigint; expect?: string } | { action: "close"; expect?: string };

const USAGE = "usage: window open [--onboard] [--blocks N] [--txs N] [--topup QOR] [--expect 0xOWNER] | window close [--expect 0xOWNER]";

function readInt(name: string, raw: string | undefined, max: bigint): number {
  if (raw === undefined || !/^\d+$/.test(raw)) throw new Error(`${name} needs a positive integer (${USAGE})`);
  const n = BigInt(raw);
  if (n < 1n || n > max) throw new Error(`${name} must be between 1 and ${max}`);
  return Number(n);
}

/** A decimal QOR amount (e.g. `0.5`, `2`), > 0, at most 18 decimals and 100 QOR, in uqor rounded UP. */
function readTopup(raw: string | undefined): bigint {
  if (raw === undefined || !/^\d+(\.\d{1,18})?$/.test(raw)) throw new Error(`--topup needs a QOR amount such as 0.5, at most 18 decimals (${USAGE})`);
  const [int, frac = ""] = raw.split(".");
  const wei = BigInt(int) * 10n ** 18n + BigInt(frac.padEnd(18, "0"));
  if (wei === 0n) throw new Error(`--topup must be above 0 (${USAGE})`);
  if (wei > MAX_TOPUP_QOR * 10n ** 18n) throw new Error(`--topup is at most ${MAX_TOPUP_QOR} QOR: a leaked key can spend it (${USAGE})`);
  return (wei + WEI_PER_UQOR - 1n) / WEI_PER_UQOR;
}

/** `window open [--onboard] [--blocks N] [--txs N] [--topup QOR] [--expect 0x…]` or `window close [--expect 0x…]`. Throws on anything else. */
export function parseWindowArgs(args: string[]): WindowArgs {
  const [action, ...rest] = args;
  if (action !== "open" && action !== "close") throw new Error(USAGE);
  let blocks: number | undefined;
  let txs: number | undefined;
  let topupUqor: bigint | undefined;
  let expect: string | undefined;
  let onboard = false;
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    if (action === "open" && flag === "--onboard" && !onboard) {
      onboard = true;
      i -= 1; // a switch: it takes no value
    } else if (flag === "--expect" && expect === undefined) {
      const v = rest[i + 1];
      if (v === undefined || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`--expect needs the owner's 0x address (${USAGE})`);
      expect = v;
    } else if (action === "open" && flag === "--blocks" && blocks === undefined) blocks = readInt("--blocks", rest[i + 1], MAX_EVM_WINDOW_BLOCKS);
    else if (action === "open" && flag === "--txs" && txs === undefined) txs = readInt("--txs", rest[i + 1], MAX_EVM_WINDOW_TXS);
    else if (action === "open" && flag === "--topup" && topupUqor === undefined) topupUqor = readTopup(rest[i + 1]);
    else throw new Error(`unexpected "${flag}" (${USAGE})`);
  }
  if (action === "close") return { action: "close", expect };
  return { action: "open", onboard, blocks: blocks ?? OWNER_WINDOW_BLOCKS, txs: txs ?? (onboard ? ONBOARD_WINDOW_TXS : OWNER_WINDOW_TXS), topupUqor: topupUqor ?? 0n, expect };
}

/**
 * Refuse, before anything is signed, when OWNER_MNEMONIC is not the owner the caller means. The root .env owner is not
 * a demo.sh run's fresh owner: without this, `window close` could close another account's window and report success.
 */
export function checkExpectedOwner(derived: string, expect: string | undefined): void {
  if (expect !== undefined && expect.toLowerCase() !== derived.toLowerCase()) {
    throw new Error(
      `--expect ${expect} but OWNER_MNEMONIC is ${derived}: refusing to sign. For a demo.sh owner, load its env first: ` +
        "(set -a && . ~/.config/qday/runs/<run id>/run.env && set +a && pnpm cli window …)",
    );
  }
}

/**
 * The owner's hand-driven window: scoped to the three tokens, the vault and the guardian. A withdraw, a manual rescue
 * and an approve fit. Against a leaked ECDSA key the window budget is the only cap (chain fact 4), so by default
 * `maxValue` covers fees only. A QOR top-up of the guardian moves value, which a window counts in `maxValue` too:
 * `topupUqor` (opt-in, `--topup`) adds exactly that much value headroom, which a leaked key can also spend while the
 * window is open.
 */
export function buildOwnerWindowParams(
  ownerCosmos: string,
  tokens: Tokens,
  vault: string,
  guardian: string,
  size: { blocks: number; txs: number; topupUqor?: bigint },
) {
  const allowedTargets = [tokens.fUSD, tokens.fETH, tokens.fBTC, vault, guardian];
  const seen = new Set(allowedTargets.map((t) => t.toLowerCase()));
  if (seen.size !== allowedTargets.length) throw new Error(`window targets contain a duplicate address: ${allowedTargets.join(", ")}`);
  const perTx = evmWindowCost({ gas: PER_TX_GAS, maxFeePerGas: PER_TX_MAX_FEE });
  return {
    sender: ownerCosmos,
    blocks: size.blocks,
    maxTxs: size.txs,
    maxValue: (perTx * BigInt(size.txs) + (size.topupUqor ?? 0n)).toString(),
    allowedTargets,
  };
}

/**
 * The onboarding window: UNSCOPED (no `allowedTargets` key at all), because a window with targets refuses contract
 * creation and the vault is deployed from the browser wallet. Same per-tx fee budget as the scoped window, plus the
 * opt-in top-up headroom. The window budget is the only cap against a leaked ECDSA key (chain fact 4).
 */
export function buildOnboardWindowParams(ownerCosmos: string, size: { blocks: number; txs: number; topupUqor: bigint }) {
  const perTx = evmWindowCost({ gas: PER_TX_GAS, maxFeePerGas: PER_TX_MAX_FEE });
  return {
    sender: ownerCosmos,
    blocks: size.blocks,
    maxTxs: size.txs,
    maxValue: (perTx * BigInt(size.txs) + size.topupUqor).toString(),
  };
}

/** Injectable I/O of `runWindow`; defaults are the production wiring. */
export type WindowDeps = {
  broadcast: typeof chainBroadcast;
  windowStatus: (address: string) => Promise<Pick<Awaited<ReturnType<typeof evmWindowStatus>>, "live" | "remainingBlocks" | "remainingTxs">>;
  log: (line: string) => void;
};

const defaultDeps: WindowDeps = {
  broadcast: chainBroadcast,
  windowStatus: (address) => evmWindowStatus({ rest: NETWORK.rest, address }),
  log: (line) => console.log(line),
};

/** `pnpm cli window open|close`: a hybrid-signed tx from the OWNER_MNEMONIC account. Prints the tx hash. */
export async function runWindow(args: string[], env: Env = process.env, deps: Partial<WindowDeps> = {}): Promise<void> {
  const { broadcast, windowStatus, log } = { ...defaultDeps, ...deps };
  const parsed = parseWindowArgs(args);
  const owner = await loadOwner(env);
  checkExpectedOwner(owner.evm, parsed.expect);
  log(`owner ${owner.evm} (${owner.cosmos})`);

  if (parsed.action === "close") {
    const hash = await broadcast(owner, [closeEvmWindowMsg(owner.cosmos)], "qday: close owner window");
    log(`window close: ${hash}`);
  } else if (parsed.onboard) {
    const params = buildOnboardWindowParams(owner.cosmos, parsed);
    const hash = await broadcast(owner, [openEvmWindowMsg(params)], "qday: open onboarding window");
    const headroom = parsed.topupUqor > 0n ? `, top-up headroom ${formatUnits(parsed.topupUqor, 6)} QOR` : "";
    log(`window open (onboard, UNSCOPED: any target, ${params.blocks} blocks, ${params.maxTxs} txs${headroom}): ${hash}`);
    log("unscoped: until it expires or you run `pnpm cli window close`, a leaked ECDSA key can send any tx within this budget");
  } else {
    const vault = loadVault(env);
    const tokens = loadTokens(env);
    // The vault's immutable guardian, read on chain: the env may not name it (a demo run.env).
    const guardian = (await publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "guardian" })) as Hex;
    const params = buildOwnerWindowParams(owner.cosmos, tokens, vault, guardian, parsed);
    const hash = await broadcast(owner, [openEvmWindowMsg(params)], "qday: open owner window");
    const headroom = parsed.topupUqor > 0n ? `, top-up headroom ${formatUnits(parsed.topupUqor, 6)} QOR` : "";
    log(`window open (${params.blocks} blocks, ${params.maxTxs} txs${headroom}, targets fUSD fETH fBTC vault guardian): ${hash}`);
  }

  // Informational only: the tx above already succeeded, so a REST hiccup here must not turn it into an error.
  try {
    const w = await windowStatus(owner.cosmos);
    log(w.live ? `owner window live: ${w.remainingBlocks} blocks, ${w.remainingTxs} txs left` : "owner window closed");
  } catch (e) {
    log(`owner window status unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }
}
