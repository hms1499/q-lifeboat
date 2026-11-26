import type { Incident } from "@qday/core";
import { useEffect, useState } from "react";
import type { Hex } from "viem";
import { CheckRow, TxHash } from "./ui";
import { agentBase } from "../lib/agent";
import { readReceipt } from "../lib/chain";
import type { AgentConfig } from "../lib/config";
import { fmtAmount, fmtInt, shortAddr, shortHash, tokenSymbol, when } from "../lib/format";
import { describeIncident } from "../lib/explain";
import { big, triggerKind } from "../lib/incidents";
import type { VerifyResult } from "../lib/verify";

/** An incident's signed report: what happened, the timeline, and the checks run against the chain in this browser. */
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export function subtitle(i: Incident, cfg: AgentConfig | null): string {
  const t = i.trigger;
  const sym = tokenSymbol(cfg, t.token);
  return triggerKind(i) === "approval"
    ? `Trigger: approve ${shortAddr(t.to)} for ${fmtAmount(big(t.amount))} ${sym}`
    : `Trigger: ${fmtAmount(big(t.amount))} ${sym} to ${shortAddr(t.to)}`;
}

function VerifyBadge({ v }: { v: VerifyResult | undefined }) {
  if (!v) return <span className="badge">Checking…</span>;
  return v.ok ? (
    <span className="badge ok">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 12l5 5 9-10" />
      </svg>
      Report verified
    </span>
  ) : (
    <span className="badge bad">
      <span aria-hidden="true">✗</span> Not verified
    </span>
  );
}

function download(i: Incident) {
  // Exactly as the agent served it: the signature covers these values, so anyone can re-verify the file.
  const blob = new Blob([`${JSON.stringify(i, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `incident-${i.id}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function IncidentReport({ i, cfg, v }: { i: Incident; cfg: AgentConfig | null; v: VerifyResult | undefined }) {
  const [blocks, setBlocks] = useState<Record<string, bigint | null>>({});
  useEffect(() => {
    let live = true;
    const hashes = i.rescues.filter((r) => r.success && HASH_RE.test(r.hash)).map((r) => r.hash as Hex);
    void Promise.all(hashes.map(async (h) => [h, await readReceipt(h).then((r) => r?.blockNumber ?? null, () => null)] as const)).then((pairs) => {
      if (live) setBlocks(Object.fromEntries(pairs));
    });
    return () => {
      live = false;
    };
  }, [i]);

  const t = i.trigger;
  const kind = triggerKind(i);
  const sym = tokenSymbol(cfg, t.token);
  const done = i.rescues.filter((r) => r.success);
  const triggerBlock = big(t.block);
  const rescueBlocks = Object.values(blocks).filter((b): b is bigint => b !== null);
  const lastRescue = rescueBlocks.length ? rescueBlocks.reduce((a, b) => (b > a ? b : a)) : null;
  const keptSame = done.filter((r) => r.token.toLowerCase() === t.token.toLowerCase()).reduce((s, r) => s + big(r.amount), 0n);
  const lost = kind === "transfer" ? big(t.amount) : 0n;
  const pct = kind === "transfer" && keptSame + lost > 0n ? Number((keptSame * 1000n) / (keptSame + lost)) / 10 : null;

  const stats = [
    { k: "Drain to last rescue", v: !done.length ? "—" : lastRescue === null ? "…" : `${fmtInt(lastRescue - triggerBlock)} block${lastRescue - triggerBlock === 1n ? "" : "s"}` },
    { k: `Value kept (${sym})`, v: pct === null || !done.length ? "—" : `${pct}%` },
    { k: kind === "approval" ? "Spender got" : "Attacker got", v: kind === "approval" ? "an allowance" : `${fmtAmount(lost)} ${sym}` },
    { k: "Rescue txs", v: i.rescues.length ? `${done.length} of ${i.rescues.length} ok` : "none (alert)" },
  ];

  return (
    <div className="stack inc-detail">
      <section className="card roomy">
        <div className="inc-head">
          <div style={{ minWidth: 0 }}>
            <div className="lbl wrap-any">
              Incident <span className="mono">{i.id}</span>
            </div>
            <h2 className="inc-title">{describeIncident(i, cfg).headline}</h2>
            <p className="inc-sub">{describeIncident(i, cfg).detail}</p>
          </div>
          <VerifyBadge v={v} />
        </div>

        <dl className="stats">
          {stats.map((s) => (
            <div key={s.k} className="stat">
              <dt className="k">{s.k}</dt>
              <dd className="v">{s.v}</dd>
            </div>
          ))}
        </dl>

        <div className="agent-note">
          <div className="lbl">
            Agent's summary <span className="tag">{i.summarySource === "llm" ? "Written by AI" : "Template"}</span>
          </div>
          <p className="wrap-any">{i.summary}</p>
        </div>

        <div className="timeline">
          <h3>Timeline</h3>
          <div className="tl">
            <span className="tl-when">Block {fmtInt(String(t.block))}</span>
            <div style={{ minWidth: 0 }}>
              <div className="tl-what">
                <span className="who attacker">Your ECDSA key</span>
                <span className="tl-act">
                  {kind === "approval" ? `Approved ${shortAddr(t.to)} for ${fmtAmount(big(t.amount))} ${sym}` : `Sent ${fmtAmount(big(t.amount))} ${sym} to ${shortAddr(t.to)}`}
                </span>
              </div>
              <div className="tl-meta wrap-any">
                Tx <TxHash hash={t.hash} />
              </div>
            </div>
          </div>
          <div className="tl">
            <span className="tl-when">{when(i.detectedAt)}</span>
            <div style={{ minWidth: 0 }}>
              <div className="tl-what">
                <span className="who guardian">Guardian</span>
                <span className="tl-act wrap-any">
                  Rule matched: {i.reason}
                </span>
              </div>
              <div className="tl-meta">Decided by fixed rules, not by AI</div>
            </div>
          </div>
          {i.rescues.map((r, n) => (
            <div key={`${r.hash}/${r.token}/${n}`} className="tl">
              <span className="tl-when">{blocks[r.hash] ? `Block ${fmtInt(blocks[r.hash]!)}` : "—"}</span>
              <div style={{ minWidth: 0 }}>
                <div className="tl-what">
                  <span className="who guardian">Guardian</span>
                  <span className="tl-act">
                    {r.success
                      ? `vault.rescue(${tokenSymbol(cfg, r.token)}): ${fmtAmount(big(r.amount))} ${tokenSymbol(cfg, r.token)} into your vault`
                      : `vault.rescue(${tokenSymbol(cfg, r.token)}) failed`}
                  </span>
                </div>
                <div className="tl-meta wrap-any">
                  {HASH_RE.test(r.hash) ? (
                    <>
                      Tx <TxHash hash={r.hash} />
                    </>
                  ) : r.hash ? (
                    `Tx ${shortHash(r.hash)}`
                  ) : null}
                  {r.error ? `${r.hash ? ", " : ""}${r.error}` : null}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="actions">
          {done.length ? (
            agentBase().owner ? (
              <a className="btn primary" href="#/vault">
                Move tokens to a safe address
              </a>
            ) : (
              <a className="btn primary" href="#/recover">
                Recover funds
              </a>
            )
          ) : null}
          <button type="button" className="btn" onClick={() => download(i)}>
            Download signed report
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Why you can trust this report</h2>
        <p className="caption" style={{ marginBottom: 14 }}>
          Checked in your browser against the chain, not taken from the agent's word{cfg ? ` (owner ${shortAddr(cfg.owner)})` : ""}
        </p>
        <div className="checks">
          {v ? v.checks.map((c) => <CheckRow key={c.id} status={c.status} title={c.title} detail={c.detail} />) : <CheckRow status="pending" title="Checking against the chain…" />}
        </div>
      </section>
    </div>
  );
}

