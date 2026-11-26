import { MINT_AMOUNT, MINT_GAS } from "@qday/core";
import { useEffect, useRef, useState } from "react";
import { erc20Abi, parseAbi, type Hex } from "viem";
import { IDLE, RunView, track, type Run } from "../components/Run";
import { useKeys } from "./KeysProvider";
import { TxHash } from "./ui";
import { fetchPolicy } from "../lib/agent";
import { appSession, DIANA_TOKENS, ownerTx } from "../lib/appWallet";
import { ATTACK_AMOUNT, ATTACK_GAS, attackOutcome, attackTarget, elapsedSeconds, fusdRescue, incidentFor, rescueLine } from "../lib/attack";
import { big } from "../lib/incidents";
import { publicClient, readFees } from "../lib/chain";
import { fmtAmount, shortAddr } from "../lib/format";
import { testPlan } from "../lib/dashboard";
import { usePoll } from "../lib/hooks";
import { useApp } from "../state";

const mintAbi = parseAbi(["function mint(address to, uint256 amount)"]);
const FUSD = DIANA_TOKENS.fUSD;
/** How long to wait for the Guardian's report before saying so (it usually lands within seconds). */
const REPORT_WAIT_MS = 90_000;

type Sent = { transfer: Hex; block: bigint; target: Hex; balanceBefore: bigint; at: number };

/**
 * Step 5: a real 10 fUSD transfer from the owner's account to a random address nobody trusts, signed in this browser
 * inside a 1-tx window (the Guardian is armed first). The Guardian can't tell it from a thief's transfer: it rescues the
 * rest into the vault and its signed report shows up here.
 */
export function TestProtection({ owner }: { owner: Hex }) {
  const keys = useKeys();
  const confirm = useRef<HTMLDialogElement>(null);
  const { incidents, verdictFor } = useApp();
  const fusd = usePoll(() => publicClient.readContract({ address: FUSD, abi: erc20Abi, functionName: "balanceOf", args: [owner] }), 6_000, owner);
  const [run_, setRun] = useState<Run>(IDLE);
  const [sent, setSent] = useState<Sent | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!sent) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [sent]);

  const incident = sent ? incidentFor(incidents, sent.transfer) : undefined;
  const rescueHash = incident ? (fusdRescue(incident, FUSD)?.hash as Hex | undefined) : undefined;
  // The Guardian also moves every other approved token it finds on the account.
  const alsoRescued = incident ? incident.rescues.filter((r) => r.success && r.token.toLowerCase() !== FUSD.toLowerCase() && big(r.amount) > 0n) : [];
  const rescueBlock = usePoll(async () => (await publicClient.getTransactionReceipt({ hash: rescueHash! })).blockNumber, 3_000, rescueHash ?? null);
  const outcome = incident && sent ? attackOutcome(incident, { token: FUSD, transferBlock: sent.block, rescueBlock: rescueBlock.data, balanceBefore: sent.balanceBefore }) : null;
  const verdict = incident ? verdictFor(incident) : undefined;

  async function attack() {
    const acc = appSession.account();
    if (!acc || !owner) return;
    await track(setRun, async (step, hashes) => {
      step("Reading your trusted list and balance…");
      // The target must not be trusted, or the Guardian would let it go. A random address never is; the list is checked anyway.
      const trusted = await fetchPolicy()
        .then((p) => p.trusted.map((t) => t.address))
        .catch(() => [] as string[]);
      const target = attackTarget(trusted);
      const balance = await publicClient.readContract({ address: FUSD, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
      const mint = balance < ATTACK_AMOUNT * 2n; // keep something on the account for the Guardian to rescue
      const fees = await readFees();
      step(`Arming your Guardian, then opening a ${mint ? 2 : 1}-tx window for fUSD only…`);
      let result: Sent | null = null;
      const out = await ownerTx.withOwnerWindow(acc, { txs: mint ? 2 : 1, scope: [FUSD] }, async (w) => {
        const txs: Hex[] = [];
        if (mint) {
          step("Minting 100 fUSD first…");
          const m = await w.writeContract({ address: FUSD, abi: mintAbi, functionName: "mint", args: [owner, MINT_AMOUNT], gas: MINT_GAS, ...fees });
          txs.push(m);
          hashes.push(m);
          const r = await publicClient.waitForTransactionReceipt({ hash: m });
          if (r.status !== "success") throw new Error(`the fUSD mint ${m} reverted on chain`);
        }
        const before = await publicClient.readContract({ address: FUSD, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
        step(`Sending 10 fUSD to ${shortAddr(target)}…`);
        const h = await w.writeContract({ address: FUSD, abi: erc20Abi, functionName: "transfer", args: [target, ATTACK_AMOUNT], gas: ATTACK_GAS, ...fees });
        txs.push(h);
        hashes.push(h);
        const r = await publicClient.waitForTransactionReceipt({ hash: h });
        if (r.status !== "success") throw new Error(`the transfer ${h} reverted on chain`);
        result = { transfer: h, block: r.blockNumber, target, balanceBefore: before, at: Date.now() };
        return txs;
      });
      hashes.unshift(out.windowTx);
      setSent(result);
      fusd.refresh();
      return "Transfer sent. Watching for your Guardian's rescue…";
    });
  }

  async function run() {
    confirm.current?.close();
    if (!(await keys.requireKeys("pqc"))) return;
    await attack();
  }

  const plan = testPlan(fusd.data);
  const busy = run_.state === "busy";
  const waitedTooLong = sent && !incident && now - sent.at > REPORT_WAIT_MS;
  return (
    <section className="card dash-test" aria-live="polite">
      <h2>Test your protection</h2>
      <p className="dash-hint">Act like a thief: send 10 fUSD from your account to an unknown address and watch your Guardian rescue the rest.</p>
      {!sent ? (
        <>
          <dl className="kv">
            <div>
              <dt>fUSD on your account</dt>
              <dd className="mono">{fusd.data === undefined ? "reading…" : fmtAmount(fusd.data)}</dd>
            </div>
          </dl>
          {plan === "mint-first" ? <p className="dash-hint">The test first mints 100 test fUSD to your account, so there is something to rescue.</p> : null}
          <div className="actions">
            <button type="button" className="btn rescue" disabled={busy || plan === "loading"} onClick={() => confirm.current?.showModal()}>
              Run the test
            </button>
          </div>
        </>
      ) : (
        <ol className="dash-timeline">
          <li className="bad">
            <span>Sent 10 fUSD to {shortAddr(sent.target)}</span>
            <small>block {sent.block.toString()}</small>
          </li>
          <li className={incident ? "" : "pending"}>
            <span>{incident ? "Guardian matched its rules (fixed rules, not AI)" : waitedTooLong ? "No report yet: check Activity in a minute" : `Waiting for your Guardian… ${elapsedSeconds(now, sent.at)} s`}</span>
          </li>
          <li className={rescueHash ? "good" : "pending"}>
            <span>
              {rescueHash && outcome
                ? rescueLine(outcome.rescued, outcome.blocksLater, alsoRescued.length > 0)
                : incident && !rescueHash
                  ? `No rescue landed: ${incident.reason}`
                  : "Rescue into your vault"}
            </span>
            {rescueHash ? <TxHash hash={rescueHash} /> : null}
          </li>
        </ol>
      )}
      <RunView run={run_} />
      {incident ? (
        <div className="actions">
          <a className="btn" href={`#/activity/${incident.id}`}>
            {verdict?.ok ? "See the signed report ✓" : "See the report"}
          </a>
          {rescueHash ? (
            <a className="btn primary" href="#/vault">
              Move tokens to a safe address
            </a>
          ) : null}
        </div>
      ) : null}
      <dialog ref={confirm} className="unlock-dialog" aria-labelledby="test-title">
        <div className="unlock-form">
          <h2 id="test-title">Run the protection test?</h2>
          <p className="hint">
            This sends a real 10 fUSD transfer from your account to an address nobody holds{plan === "mint-first" ? ", after minting 100 test fUSD" : ""}. Your
            Guardian should move the rest into your vault within a block or two. These are test tokens.
          </p>
          <div className="actions">
            <button type="button" className="btn" onClick={() => confirm.current?.close()}>
              Cancel
            </button>
            <button type="button" className="btn rescue" onClick={() => void run()}>
              Send 10 fUSD
            </button>
          </div>
        </div>
      </dialog>
    </section>
  );
}
