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

/** The text of the downloadable recovery-code file. */
export function recoveryFile(code: string, account: string): string {
  return [
    "Q-Lifeboat recovery code (diana testnet)",
    `Account: ${account}`,
    "",
    formatRecoveryCode(code),
    "",
    "This code makes the key that signs withdrawals from your vault. Keep this file private:",
    "Anyone with this code and your wallet password can sign withdrawals.",
    "",
  ].join("\n");
}
