import { runAttack } from "./attacker";
import { runDemoCheck } from "./democheck";
import { runFreshOwner } from "./fresh";
import { runAgentMisuse } from "./misuse";
import { runSetup } from "./setup";
import { runSignWithdraw } from "./signer";
import { runStatus } from "./status";
import { runWithdraw } from "./withdraw";

const USAGE = `Q-Day Guardian CLI (qorechain-diana testnet)

  pnpm cli setup                              open the EVM window, link the agent, approve the vault
  pnpm cli sign-withdraw <to> <token> <amt>   Guardian Signer: write withdrawal.json (--out <file>)
  pnpm cli withdraw <withdrawal.json>         submit a signed withdrawal from any funded wallet
  pnpm cli agent-misuse <token> <to> <wei>    negative gate: agent key tries token.transfer directly (must be REFUSED)
  pnpm cli status                             read-only snapshot (window, rules, keys, balances)

Demo (Task 5, run by ./demo.sh):
  pnpm cli fresh-owner                        new owner funded by FUNDER_MNEMONIC (default OWNER_MNEMONIC): ML-DSA key,
                                              own vault, 100 fUSD; writes ~/.config/qday/runs/<id>/run.env
  pnpm cli attack                             leaked owner ECDSA key drains 3 x 10 fUSD, then (a) forged withdraw,
                                              (b) agent key misuse; writes attack.json in the run dir
  pnpm cli demo-check [--wait <s>]            verdict: rescue <= 3 blocks, >= 80% kept, (a) and (b) refused

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
    case "status":
      await runStatus();
      return 0;
    case "fresh-owner":
      await runFreshOwner();
      return 0;
    case "attack":
      await runAttack();
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
