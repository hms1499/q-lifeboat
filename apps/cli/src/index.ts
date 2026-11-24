import { runAttack } from "./attacker";
import { runDemoCheck } from "./democheck";
import { runDrillGuardian } from "./drillguardian";
import { runFreshOwner } from "./fresh";
import { runLink } from "./link";
import { runAgentMisuse } from "./misuse";
import { runSetup } from "./setup";
import { runSignWithdraw } from "./signer";
import { runStatus } from "./status";
import { runWithdraw } from "./withdraw";
import { runWindow } from "./window";

const USAGE = `Q-Lifeboat CLI (qorechain-diana testnet)

  pnpm cli setup                              open the EVM window, link the agent, approve the vault
  pnpm cli link [--expect 0xOWNER]            link the Guardian's key to a vault deployed from the browser (reads
                                              OWNER_MNEMONIC, VAULT_ADDRESS, AGENT_ED25519_SK; refuses a vault the owner
                                              does not own); one hybrid tx, no window
  pnpm cli sign-withdraw <to> <token> <amt>   Guardian Signer: write withdrawal.json (--out <file>)
  pnpm cli withdraw <withdrawal.json>         submit a signed withdrawal from any funded wallet
  pnpm cli agent-misuse <token> <to> <wei>    negative gate: agent key tries token.transfer directly (must be REFUSED)
  pnpm cli status                             read-only snapshot (window, rules, keys, balances)
  pnpm cli window open [--onboard] [--blocks N] [--txs N] [--topup QOR] [--expect 0xOWNER]
                                              open the owner's EVM window (default 1800 blocks, 5 txs), scoped to
                                              fUSD, fETH, fBTC, the vault and the guardian; maxValue covers fees only
                                              --topup: add that much value headroom (<= 100 QOR) for a QOR top-up of
                                              the guardian; a leaked ECDSA key can spend it while the window is open
                                              --onboard: UNSCOPED window (any target, default 5 txs) so the browser wallet can
                                              deploy the vault; needs no VAULT_ADDRESS. Close it with window close.
  pnpm cli window close [--expect 0xOWNER]    close the owner's EVM window (a leaked ECDSA key can then send nothing)
                                              --expect: refuse unless OWNER_MNEMONIC is that owner (demo.sh owners:
                                              set -a && . ~/.config/qday/runs/<run id>/run.env && set +a first)

Demo (Task 5, run by ./demo.sh):
  pnpm cli fresh-owner [--no-vault]           new owner funded by FUNDER_MNEMONIC (default OWNER_MNEMONIC): ML-DSA key,
                                              own vault, 100 fUSD; writes ~/.config/qday/runs/<id>/run.env
                                              --no-vault: skip the vault (onboard it from the dashboard's Protect screen)
  pnpm cli attack                             leaked owner ECDSA key drains 3 x 10 fUSD, then (a) forged withdraw,
                                              (b) agent key misuse; writes attack.json in the run dir
  pnpm cli demo-check [--wait <s>]            verdict: rescue <= 3 blocks, >= 80% kept, (a) and (b) refused
  pnpm cli drill-guardian init                create (once) and top up the fire drill's own guardian account in
                                              ~/.config/qday/drill-guardian.env, funded by FUNDER_MNEMONIC; run it
                                              again to top it up

  <token> is a 0x address, fUSD, fETH, fBTC or QOR. <amt> is a decimal amount (18 decimals).`;

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "setup":
      await runSetup();
      return 0;
    case "sign-withdraw":
      await runSignWithdraw(args);
      return 0;
    case "withdraw":
      await runWithdraw(args);
      return 0;
    case "agent-misuse":
      return runAgentMisuse(args);
    case "link":
      await runLink(args);
      return 0;
    case "window":
      await runWindow(args);
      return 0;
    case "status":
      await runStatus();
      return 0;
    case "fresh-owner":
      await runFreshOwner(args);
      return 0;
    case "attack":
      await runAttack();
      return 0;
    case "drill-guardian":
      await runDrillGuardian(args);
      return 0;
    case "demo-check":
      return runDemoCheck(args);
    default:
      console.error(USAGE);
      return 1;
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (e: unknown) => {
    // Message only: never print stacks or objects that could carry secrets.
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  },
);
