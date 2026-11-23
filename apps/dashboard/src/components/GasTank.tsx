import type { EvmWindow } from "@qorechain/evm/window";
import { useState } from "react";
import type { Hex } from "viem";
import { planTopUp, TOPUP_GAS, withWindowHint } from "../lib/actions";
import type { Health } from "../lib/agent";
import { publicClient, readFees } from "../lib/chain";
import type { AgentConfig } from "../lib/config";
import { errorText, fmtAmount, fmtUqor, shortAddr, shortHash } from "../lib/format";
import { usePoll, type Polled } from "../lib/hooks";
import { big } from "../lib/incidents";
import { ensureDiana, walletClientFor } from "../lib/wallet";
import { useApp } from "../state";
import { Command, TxHash } from "./ui";
import { SwitchToDiana, useWalletConnect, WalletConnect } from "./WalletConnect";

type Send =
  | { state: "idle" }
  | { state: "busy"; step: string; hash?: Hex }
  | { state: "done"; hash: Hex; status: "success" | "reverted" }
  | { state: "error"; message: string; hash?: Hex };

/**
 * The guardian's QOR, read on chain (works with the agent offline; the alert threshold comes from /health), and a
 * top-up: a plain QOR transfer from the owner's wallet to the guardian, inside the owner's EVM window.
 */
export function GasTank({ cfg, health, win }: { cfg: AgentConfig; health: Health | undefined; win: Polled<EvmWindow> }) {
  const { config } = useApp();
  const wc = useWalletConnect();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("0.1");
  const [send, setSend] = useState<Send>({ state: "idle" });
  const balance = usePoll(() => publicClient.getBalance({ address: cfg.guardian }), 15_000, cfg.guardian);
  const fees = usePoll(readFees, 15_000, open ? "fees" : null);

  const b = balance.data ?? null;
  const threshold = health ? big(health.gas.threshold) : 0n;
  const low = !!health && (health.gas.low || (b !== null && b < threshold));
  const pct = b !== null && threshold > 0n ? Math.min(100, Number((b * 100n) / (threshold * 4n))) : 0;

  const wallet = wc.wallet;
  const plan = planTopUp({
    cfg,
    configOk: config.check?.ok === true,
    wallet: wallet?.account ?? null,
    chainId: wc.chainId,
    window: win.data,
    amountText: amount,
    maxFeePerGas: fees.data?.maxFeePerGas,
  });
  const busy = send.state === "busy";

  async function topUp() {
    const f = fees.data;
    const value = plan.value;
    if (!wallet || !f || value === null || plan.blockers.length) return;
    let hash: Hex | undefined;
    try {
      setSend({ state: "busy", step: "Switching the wallet to diana…" });
      await ensureDiana(wallet.provider);
      setSend({ state: "busy", step: `Confirm in ${wallet.name}…` });
      hash = await walletClientFor(wallet.provider, wallet.account).sendTransaction({
        to: cfg.guardian,
        value,
        gas: TOPUP_GAS,
        maxFeePerGas: f.maxFeePerGas,
        maxPriorityFeePerGas: f.maxPriorityFeePerGas,
      });
      setSend({ state: "busy", step: `Sent ${shortHash(hash)}, waiting for the block…`, hash });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      setSend({ state: "done", hash, status: receipt.status });
    } catch (e) {
      setSend({ state: "error", message: withWindowHint(errorText(e)), hash });
    } finally {
      balance.refresh();
      win.refresh();
    }
  }

  return (
    <section className="card">
      <div className="between">
        <h2>Gas tank</h2>
        <span className="mono" style={{ fontSize: 18, fontWeight: 500 }}>
          {b === null ? "—" : `${fmtAmount(b)} QOR`}
        </span>
      </div>
      <p style={{ margin: "8px 0 12px", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
        The guardian account <span className="mono">{shortAddr(cfg.guardian)}</span> pays every rescue tx and its own window. Balance read on chain
        {balance.error ? ` (last read failed: ${balance.error})` : ""}.
      </p>
      {threshold > 0n && b !== null ? (
        <div className={`bar ${low ? "low" : ""}`}>
          <div style={{ width: `${pct}%` }} />
        </div>
      ) : null}
      <div className="between" style={{ marginTop: 12, fontSize: 12, color: "var(--muted)" }}>
        <span>{health ? `You get an alert below ${fmtAmount(threshold)} QOR` : "Agent offline: no alert threshold"}</span>
        {low ? <span className="tag orange">Low</span> : null}
      </div>

      {!open ? (
        <div className="actions" style={{ marginTop: 14 }}>
          <button type="button" className="btn small" onClick={() => setOpen(true)}>
            Top up
          </button>
        </div>
      ) : (
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--line-soft)" }}>
          <div className="form">
            <label style={{ flex: "1 1 120px" }}>
              Amount (QOR)
              <input className="input mono" inputMode="decimal" value={amount} disabled={busy} onChange={(e) => setAmount(e.target.value)} />
            </label>
            {wallet ? (
              <button type="button" className="btn primary small" disabled={plan.blockers.length > 0 || busy} onClick={() => void topUp()}>
                {busy && send.state === "busy" ? send.step : `Send with ${wallet.name}`}
              </button>
            ) : (
              <WalletConnect w={wc} small />
            )}
            {!busy ? <SwitchToDiana w={wc} /> : null}
            {!busy ? (
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  setOpen(false);
                  setSend({ state: "idle" });
                }}
              >
                Close
              </button>
            ) : null}
          </div>
          {wc.error ? <div className="err">{wc.error}</div> : null}
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 8, lineHeight: 1.5 }}>
            A QOR transfer from your owner account to the guardian, inside your EVM window
            {plan.value !== null && fees.data && plan.value > 0n ? `: uses ${fmtUqor(plan.cost)} QOR of its budget (amount plus fee)` : ""}.
          </div>
          {plan.blockers.length && !busy ? <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 8 }}>To top up: {plan.blockers.join("; ")}.</div> : null}
          {plan.command && !busy ? (
            <Command cmd={plan.command}>
              <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>
                The default owner window covers fees only. This opens one (replacing the current one) with exactly this much extra value budget. A leaked
                ECDSA key could spend that headroom while the window is open, so keep it small and close the window when you are done.
              </div>
            </Command>
          ) : null}
          {fees.error && !fees.data ? <div className="err">Could not read the network fee: {fees.error}</div> : null}
          {send.state === "done" ? (
            <div className={send.status === "success" ? "ok-note" : "err"}>
              {send.status === "success" ? "Topped up" : "The transfer reverted on chain"} · tx{" "}
              <TxHash hash={send.hash} />
            </div>
          ) : null}
          {send.state === "error" ? (
            <div className="err">
              {send.message}
              {send.hash ? (
                <>
                  {" "}
                  (tx <TxHash hash={send.hash} />: its status is unknown, check its receipt)
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
