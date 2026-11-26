import { normalizeRecoveryCode } from "@qorechain/sdk";
import type { JourneyStep } from "./onboard";

/** The three setup phases the owner sees: wallet + recovery code, starter QOR, turn on protection. */
export function phaseOf(step: JourneyStep): 1 | 2 | 3 | "done" {
  if (step === "account" || step === "code") return 1;
  if (step === "starter") return 2;
  if (step === "register" || step === "guardian" || step === "vault" || step === "protect") return 3;
  return "done";
}

/** The recovery code in its display form: QRC1 then the 14 groups of four. */
export function formatRecoveryCode(code: string): string {
  return ["QRC1", ...(normalizeRecoveryCode(code).match(/.{1,4}/g) ?? [])].join("-");
}

/**
 * What the recovery code can do, shown next to Copy/Download and written into the file. The vault's withdraw can be
 * sent by anyone and the ML-DSA-87 key comes from the code alone, so the code alone empties the vault.
 */
export const CODE_POWER = "Anyone with this code can withdraw everything in your vault.";
export const RECOVERY_WARNING = `${CODE_POWER} Keep this file private.`;

/** The text of the downloadable recovery-code file. */
export function recoveryFile(code: string, account: string): string {
  return [
    "Q-Lifeboat recovery code (diana testnet)",
    `Account: ${account}`,
    "",
    formatRecoveryCode(code),
    "",
    "This code makes the key that signs withdrawals from your vault.",
    RECOVERY_WARNING,
    "",
  ].join("\n");
}

export type SetupStep = "register" | "guardian" | "vault" | "protect";
const PHASE3: readonly string[] = ["register", "guardian", "vault", "protect"];

export type AutoInput = {
  /** The current onboarding step (`nextOnboardStep`), or "finished". */
  step: string;
  /** Its status text (`nextOnboardStep`'s detail). */
  detail: string;
  /** The owner started the auto-run (Turn on protection, or Retry). */
  auto: boolean;
  /** A step is running. */
  busy: boolean;
  /** The last step failed. */
  failed: boolean;
  /** The last step the auto-run started. */
  last: string | null;
  /** The signing keys are in this tab. */
  unlocked: boolean;
  /** The account's post-quantum key is registered; undefined while reading. */
  registered: boolean | undefined;
  /** The vault lookup: still reading (or failing), no vault for this owner and Guardian, or one found. */
  vaultLookup: "reading" | "none" | "found";
  /** The vault lookup's last error. */
  vaultError: string | null;
  /** A vault address is known. */
  vault: boolean;
};

export type AutoDecision =
  | { kind: "idle" }
  | { kind: "run"; step: SetupStep }
  | { kind: "wait"; detail: string }
  | { kind: "blocked"; detail: string; retry: boolean }
  | { kind: "locked" };

/**
 * Phase 3's auto-run: which step to run next, or why it waits or is blocked. Each step runs only once its inputs are
 * read (never on an unknown answer: the vault step needs a definite "no vault") and never twice in one run. Blocked
 * states hold whether the run is on or not (only a running step goes first), so the screen says why instead of spinning.
 */
export function autoRun(i: AutoInput): AutoDecision {
  // A running step is never interrupted, and its own progress is what the screen shows.
  if (!PHASE3.includes(i.step) || i.busy) return { kind: "idle" };
  if (i.step === "register" && i.registered === true) return { kind: "blocked", detail: i.detail, retry: false };
  if (i.step === "vault" && i.vaultLookup === "found") return { kind: "blocked", detail: i.detail, retry: false };
  if (i.step === "vault" && i.vaultLookup === "reading" && i.vaultError) {
    return { kind: "blocked", detail: `could not look for your vault on chain (${i.vaultError})`, retry: true };
  }
  if (!i.auto || i.failed) return { kind: "idle" };
  if (!i.unlocked) return { kind: "locked" };
  const ready =
    i.step === "register"
      ? i.registered === false
      : i.step === "guardian"
        ? true
        : i.step === "vault"
          ? i.vaultLookup === "none"
          : i.vault && !i.detail.startsWith("reading");
  if (!ready || i.last === i.step) return { kind: "wait", detail: i.detail };
  return { kind: "run", step: i.step as SetupStep };
}
