import { vaultAbi } from "@qday/core";
import type { EvmWindow } from "@qorechain/evm/window";
import { useState } from "react";
import type { Hex } from "viem";
import { planRescueNow, RESCUE_GAS, withWindowHint, type RescueRow } from "../lib/actions";
import { explorerTx, publicClient, readFees } from "../lib/chain";
import type { AgentConfig } from "../lib/config";
import { errorText, fmtAmount, fmtUqor, shortHash } from "../lib/format";
import { usePoll, type Polled } from "../lib/hooks";
import { ensureDiana, walletClientFor } from "../lib/wallet";
import { useApp } from "../state";
import { ExtLink, WindowCommand } from "./ui";
import { useWalletConnect, WalletConnect } from "./WalletConnect";

type Sent = { sym: string; hash: Hex; status: "pending" | "success" | "reverted" };
type Run = { state: "idle" | "busy" | "done" | "error"; step?: string; sent: Sent[]; unsent: string[]; error?: string };

const IDLE: Run = { state: "idle", sent: [], unsent: [] };

/**
 * "Rescue now" from the owner's own wallet, for when the agent is down: one `vault.rescue(token)` per token with
 * something to move, sent one after the other through MetaMask inside the owner's EVM window.
 */
export function RescueNow({ cfg, rows, win, onSent }: { cfg: AgentConfig; rows: RescueRow[] | undefined; win: Polled<EvmWindow>; onSent: () => void }) {
  const { config } = useApp();
  const wc = useWalletConnect();
  const [open, setOpen] = useState(false);
  const [run, setRun] = useState<Run>(IDLE);
  const fees = usePoll(readFees, 15_000, open ? "fees" : null);

  if (!open) {
    return (
      <div className="actions" style={{ marginTop: 16 }}>
        <button type="button" className="btn" onClick={() => setOpen(true)} aria-expanded={false}>
          Rescue now
        </button>
      </div>
    );
  }

  const wallet = wc.wallet;
  const plan = planRescueNow({
    cfg,
    configOk: config.check?.ok === true,
    wallet: wallet?.account ?? null,
    chainId: wc.chainId,
    window: win.data,
    rows: rows ?? [],
    maxFeePerGas: fees.data?.maxFeePerGas,
  });
  const busy = run.state === "busy";
  const blockers = rows ? plan.blockers : ["reading balances"];

  async function send() {
    const f = fees.data;
    if (!wallet || !f || blockers.length) return;
    const tokens = plan.tokens;
    const sent: Sent[] = [];
    const busyStep = (step: string) => setRun({ state: "busy", step, sent: [...sent], unsent: [] });
    try {
      busyStep("Switching the wallet to diana…");
      await ensureDiana(wallet.provider);
      const client = walletClientFor(wallet.provider, wallet.account);
      for (const [k, t] of tokens.entries()) {
        busyStep(`Simulating the ${t.sym} rescue…`);
        const { request } = await publicClient.simulateContract({
          account: wallet.account,
          address: cfg.vault,
          abi: vaultAbi,
          functionName: "rescue",
          args: [t.token as Hex],
          gas: RESCUE_GAS,
          maxFeePerGas: f.maxFeePerGas,
          maxPriorityFeePerGas: f.maxPriorityFeePerGas,
        });
        busyStep(`Confirm rescue ${k + 1} of ${tokens.length} (${t.sym}) in ${wallet.name}…`);
        const hash = await client.writeContract(request);
        sent.push({ sym: t.sym, hash, status: "pending" });
        busyStep(`Sent ${shortHash(hash)}, waiting for the block…`);
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        sent[sent.length - 1] = { sym: t.sym, hash, status: receipt.status };
        if (receipt.status !== "success") throw new Error(`the ${t.sym} rescue reverted on chain`);
      }
      setRun({ state: "done", sent: [...sent], unsent: [] });
    } catch (e) {
      setRun({ state: "error", sent: [...sent], unsent: tokens.slice(sent.length).map((t) => t.sym), error: withWindowHint(errorText(e)) });
    } finally {
      onSent();
      win.refresh();
    }
  }

  const windowClosed = !!win.data && !win.data.live;
  return (
    <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--line-soft)" }}>
      <div className="between">
        <h3 className="h" style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>
          Rescue now
        </h3>
        {!busy ? (
          <button
            type="button"
            className="btn small"
            onClick={() => {
              setOpen(false);
              setRun(IDLE);
            }}
          >
            Close
          </button>
        ) : null}
      </div>
      <p style={{ margin: "6px 0 12px", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
        For when the agent is down: the Guardian does the same thing on its own when it sees a transfer you don't trust. Your wallet sends one{" "}
        <span className="mono">vault.rescue(token)</span> per token, each moving what the vault may pull (your balance, up to your allowance) into your
        vault. Needs your owner account and its open EVM window.
      </p>

      {rows && plan.tokens.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
          {plan.tokens.map((t) => (
            <div key={t.token} className="trusted">
              <span style={{ fontWeight: 600 }}>{t.sym}</span>
              <span className="mono">{fmtAmount(t.amount, 6)}</span>
            </div>
          ))}
          <div style={{ fontSize: 12, color: "var(--muted)" }}>
            {plan.tokens.length} tx{plan.tokens.length === 1 ? "" : "s"} from your window
            {fees.data ? `, up to ${fmtUqor(plan.cost)} QOR of its budget in fees` : ""}.
          </div>
        </div>
      ) : null}

      {!wallet ? (
        <div style={{ marginBottom: 12 }}>
          <WalletConnect w={wc} small />
        </div>
      ) : null}
      {wc.error ? <div className="err">{wc.error}</div> : null}
      {windowClosed && plan.tokens.length > 0 && !busy ? (
        <WindowCommand action="open" owner={cfg.owner}>
          Every EVM tx on diana needs a live window, opened by a hybrid tx the browser can't sign. Run this in the repo root, then come back.
        </WindowCommand>
      ) : null}

      {run.sent.length ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, margin: "12px 0" }}>
          {run.sent.map((s) => (
            <div key={s.hash} className="mono wrap-any" style={{ fontSize: 12, color: "var(--ink-2)" }}>
              {s.sym}: <ExtLink href={explorerTx(s.hash)}>{shortHash(s.hash)}</ExtLink> ·{" "}
              <span style={s.status === "reverted" ? { color: "var(--red)" } : undefined}>
                {s.status === "pending" ? (busy ? "waiting…" : "status unknown: check the explorer") : s.status}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {run.state === "done" ? (
        <div className="ok-note">Done: {run.sent.length} rescue{run.sent.length === 1 ? "" : "s"} confirmed. Balances above refresh.</div>
      ) : (
        <>
          <div style={{ marginTop: 12 }}>
            <button type="button" className="btn primary" disabled={blockers.length > 0 || busy} onClick={() => void send()}>
              {busy
                ? run.step
                : `Rescue ${plan.tokens.length ? `${plan.tokens.length} token${plan.tokens.length === 1 ? "" : "s"} ` : ""}with ${wallet?.name ?? "MetaMask"}`}
            </button>
          </div>
          {blockers.length && !busy ? <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 8 }}>To rescue: {blockers.join("; ")}.</div> : null}
          {fees.error && !fees.data ? <div className="err">Could not read the network fee: {fees.error}</div> : null}
        </>
      )}
      {run.state === "error" ? (
        <div className="err">
          {run.error}
          {run.unsent.length ? ` Not sent: ${run.unsent.join(", ")}.` : ""}
        </div>
      ) : null}
    </div>
  );
}
