import { MINT_AMOUNT, MINT_GAS } from "@qday/core";
import { clearPqcStatusCache } from "@qorechain/sdk";
import { useEffect, useState } from "react";
import { erc20Abi, parseAbi, type Hex } from "viem";
import { IDLE, NeedKeys, RunView, track, useStoredSeed, type Run } from "../components/Keys";
import { TxHash } from "../components/ui";
import { fetchPolicy } from "../lib/agent";
import { appSession, DIANA_TOKENS, hosted, ownerTx } from "../lib/appWallet";
import { ATTACK_AMOUNT, ATTACK_GAS, attackOutcome, attackTarget, fusdRescue, incidentFor } from "../lib/attack";
import { big } from "../lib/incidents";
import { publicClient, readFees, readPqcStatus } from "../lib/chain";
import { fmtAmount, shortAddr } from "../lib/format";
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
export function Attack() {
  const stored = useStoredSeed();
  const owner = (stored?.evm ?? null) as Hex | null;
  const { incidents, verdictFor } = useApp();
  const [, setVer] = useState(0);
  const bump = () => setVer((v) => v + 1);
  const state = usePoll(() => hosted.owner(owner!), 15_000, owner);
  const pqc = usePoll(() => {
    clearPqcStatusCache();
    return readPqcStatus(owner!);
  }, 30_000, owner);
  const fusd = usePoll(() => publicClient.readContract({ address: FUSD, abi: erc20Abi, functionName: "balanceOf", args: [owner!] }), 6_000, owner);
  const [run, setRun] = useState<Run>(IDLE);
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

  if (stored === undefined) return <p className="muted">Checking this browser for a wallet…</p>;
  if (!stored || !owner) {
    return (
      <section className="card roomy">
        <h1>Try an attack</h1>
        <p>This browser has no wallet yet.</p>
        <a className="btn primary" href="#/start">
          Get protected first
        </a>
      </section>
    );
  }
  const active = state.data?.stage === "active" || state.data?.stage === "retired";
  const waitedTooLong = sent && !incident && now - sent.at > REPORT_WAIT_MS;

  return (
    <>
      <h1>Try an attack</h1>
      <p className="lead">
        Act like a thief who has your wallet key: send 10 fUSD from your account to an address nobody trusts. Your Guardian sees the same thing it would see
        in a real theft and moves the rest of your fUSD into your vault, usually a block or two later.
      </p>
      <div className="row">
        <div className="stack grow">
          <section className="card roomy">
            <h2>1. Send 10 fUSD to an unknown address</h2>
            <p style={{ fontSize: 14, color: "var(--muted)" }}>
              A real transfer you sign here, in a window of one transaction scoped to fUSD. The 10 fUSD are gone for good (nobody holds that address's key);
              they are test tokens.
            </p>
            {!state.data ? (
              <p className="muted">{state.error ? `Could not read your Guardian: ${state.error}` : "Reading your Guardian…"}</p>
            ) : !active ? (
              <p>
                Your Guardian is not on yet. <a href="#/start">Finish the steps first.</a>
              </p>
            ) : (
              <NeedKeys pqc={pqc.data} onChange={bump}>
                <dl className="kv" style={{ marginTop: 0 }}>
                  <div>
                    <dt>fUSD on your account</dt>
                    <dd className="mono">{fusd.data === undefined ? "reading…" : fmtAmount(fusd.data)}</dd>
                  </div>
                </dl>
                <div className="actions">
                  <button type="button" className="btn primary" disabled={run.state === "busy"} onClick={() => void attack()}>
                    Send 10 fUSD to an unknown address
                  </button>
                </div>
                <RunView run={run} />
              </NeedKeys>
            )}
          </section>

          {sent ? (
            <section className="card roomy" aria-live="polite">
              <h2>2. Your Guardian's response</h2>
              <dl className="kv" style={{ marginTop: 0 }}>
                <div>
                  <dt>Transfer</dt>
                  <dd>
                    10 fUSD to <span className="mono">{shortAddr(sent.target)}</span> in block {sent.block.toString()}
                    <small>
                      <TxHash hash={sent.transfer} />
                    </small>
                  </dd>
                </div>
                <div>
                  <dt>Rescue</dt>
                  <dd>
                    {!incident ? (
                      waitedTooLong ? (
                        <span style={{ color: "var(--danger)" }}>No report yet after {Math.round(REPORT_WAIT_MS / 1000)} s. Check Overview and Incidents.</span>
                      ) : (
                        `waiting for the Guardian's report… (${Math.round((now - sent.at) / 1000)} s)`
                      )
                    ) : !rescueHash ? (
                      <span style={{ color: "var(--danger)" }}>The Guardian reported the transfer but no rescue landed: {incident.reason}</span>
                    ) : (
                      <>
                        {outcome ? `${fmtAmount(outcome.rescued)} fUSD moved into your vault` : "…"}
                        {outcome?.blocksLater !== undefined ? `, ${outcome.blocksLater.toString()} block${outcome.blocksLater === 1n ? "" : "s"} after the transfer` : ""}
                        <small>
                          <TxHash hash={rescueHash} />
                        </small>
                      </>
                    )}
                  </dd>
                </div>
                {alsoRescued.length ? (
                  <div>
                    <dt>Also moved</dt>
                    <dd>
                      {alsoRescued
                        .map((r) => `${fmtAmount(big(r.amount))} ${r.token.toLowerCase() === DIANA_TOKENS.fETH.toLowerCase() ? "fETH" : r.token.toLowerCase() === DIANA_TOKENS.fBTC.toLowerCase() ? "fBTC" : shortAddr(r.token)}`)
                        .join(", ")}{" "}
                      into your vault, in the same response
                    </dd>
                  </div>
                ) : null}
                {outcome && rescueHash ? (
                  <div>
                    <dt>Kept</dt>
                    <dd>
                      {outcome.keptPct}% of the {fmtAmount(sent.balanceBefore)} fUSD you had
                    </dd>
                  </div>
                ) : null}
                {incident ? (
                  <div>
                    <dt>Signed report</dt>
                    <dd>
                      {verdict === undefined ? "checking its signatures…" : verdict.ok ? "✓ every check passes" : "✗ a check fails: open it to see which"}
                      <small>
                        <a href={`#/incidents/${incident.id}`}>Open the report</a>
                      </small>
                    </dd>
                  </div>
                ) : null}
              </dl>
              {incident && rescueHash ? (
                <div className="actions">
                  <a className="btn primary" href="#/recover">
                    Withdraw from your vault
                  </a>
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      </div>
    </>
  );
}
