import { useState } from "react";
import { erc20Abi, type Hex } from "viem";
import { fetchHealth } from "../lib/agent";
import { publicClient, readAuthenticators, readFees, readWindow } from "../lib/chain";
import type { AgentConfig } from "../lib/config";
import { errorText, fmtUqor, shortHash } from "../lib/format";
import { usePoll } from "../lib/hooks";
import { APPROVE_GAS, TOKEN_SYMBOLS } from "../lib/protect";
import { planRevokeApprovals, tokensToRevoke, turnOffSteps, unlinkCommand } from "../lib/turnoff";
import { withWindowHint } from "../lib/actions";
import { ensureDiana, walletClientFor } from "../lib/wallet";
import { useApp } from "../state";
import { Command, TxHash, WindowCommand } from "./ui";
import { SwitchToDiana, useWalletConnect, WalletConnect } from "./WalletConnect";

type Run = { state: "idle" | "busy" | "done" | "error"; step?: string; hashes: { sym: string; hash: Hex }[]; error?: string };
const IDLE: Run = { state: "idle", hashes: [] };

async function readAllowances(cfg: AgentConfig) {
  const read = (token: Hex) => publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [cfg.owner, cfg.vault] });
  const [fUSD, fETH, fBTC] = await Promise.all(TOKEN_SYMBOLS.map((sym) => read(cfg.tokens[sym])));
  return { fUSD: fUSD!, fETH: fETH!, fBTC: fBTC! };
}

/**
 * "Turn off protection" (Task 6E step 4), folded away at the bottom of Rules. Three steps, each ticked from the chain or
 * the agent: revoke the vault approvals from the owner's wallet (this is what stops rescues), unlink the Guardian's key
 * with the CLI (a hybrid tx), stop the agent. Turning protection back on is the Protect screen.
 */
export function TurnOff({ cfg }: { cfg: AgentConfig }) {
  const { config } = useApp();
  const [open, setOpen] = useState(false);
  const wc = useWalletConnect();
  const [run, setRun] = useState<Run>(IDLE);
  const key = open ? `${cfg.owner}/${cfg.vault}` : null;
  const allowances = usePoll(() => readAllowances(cfg), 10_000, key);
  const auths = usePoll(() => readAuthenticators(cfg.owner), 15_000, key);
  const win = usePoll(() => readWindow(cfg.owner), 10_000, key);
  const fees = usePoll(readFees, 15_000, key);
  const health = usePoll(fetchHealth, 10_000, key);

  const wallet = wc.wallet;
  const tokens = allowances.data ? tokensToRevoke(allowances.data, cfg.tokens) : [];
  const plan = planRevokeApprovals({
    cfg,
    configOk: config.check?.ok === true,
    wallet: wallet?.account ?? null,
    chainId: wc.chainId,
    window: win.data,
    maxFeePerGas: fees.data?.maxFeePerGas,
    tokens,
  });
  const busy = run.state === "busy";
  const blockers = allowances.data ? plan.blockers : ["reading the allowances"];
  const steps = turnOffSteps({
    allowances: allowances.data,
    authenticators: auths.data,
    agent: health.data ? "online" : health.error ? "offline" : "unknown",
    nowUnix: Math.floor(Date.now() / 1000),
  });
  const done = (id: string) => steps.find((s) => s.id === id)!.done;

  async function revoke() {
    const f = fees.data;
    if (!wallet || !f || blockers.length) return;
    const hashes: Run["hashes"] = [];
    try {
      setRun({ state: "busy", step: "Switching the wallet to diana…", hashes });
      await ensureDiana(wallet.provider);
      const client = walletClientFor(wallet.provider, wallet.account);
      for (const [i, t] of tokens.entries()) {
        // The plan comes from a poll up to 10 s old: skip a token already at 0 (no window tx or fee burnt).
        const left = await publicClient.readContract({ address: t.token as Hex, abi: erc20Abi, functionName: "allowance", args: [cfg.owner, cfg.vault] });
        if (left === 0n) continue;
        setRun({ state: "busy", step: `Confirm approve(vault, 0) for ${t.sym} (${i + 1} of ${tokens.length}) in ${wallet.name}…`, hashes: [...hashes] });
        const hash = await client.writeContract({
          address: t.token as Hex,
          abi: erc20Abi,
          functionName: "approve",
          args: [cfg.vault, 0n],
          gas: APPROVE_GAS,
          maxFeePerGas: f.maxFeePerGas,
          maxPriorityFeePerGas: f.maxPriorityFeePerGas,
        });
        hashes.push({ sym: t.sym, hash });
        setRun({ state: "busy", step: `Sent ${shortHash(hash)}, waiting for the block…`, hashes: [...hashes] });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error(`approve ${t.sym} reverted on chain; the rest were not sent`);
      }
      setRun({ state: "done", hashes: [...hashes] });
    } catch (e) {
      setRun({ state: "error", hashes: [...hashes], error: withWindowHint(errorText(e)) });
    } finally {
      allowances.refresh();
      win.refresh();
    }
  }

  const mark = (ok: boolean, n: number) => <span className={`stepnum ${ok ? "done" : "on"}`}>{ok ? "✓" : n}</span>;

  return (
    <details className="card turnoff" onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary>
        <h2>Turn off protection</h2>
        <span className="caption">Revoke the vault's allowances, unlink the Guardian and stop the agent</span>
      </summary>
      <div className="turnoff-body">
        <ul className="turnoff-notes">
          <li>Tokens already in your vault stay there. Only your ML-DSA-87 key takes them out (Recover).</li>
          <li>
            While the agent runs, each <span className="mono">approve(vault, 0)</span> raises an alert. That is on purpose: an attacker with your ECDSA
            key doing the same is flagged too.
          </li>
          <li>While the Guardian's key is unlinked, past incident reports show "Not verified": the chain no longer vouches for that key. Linking it again restores them.</li>
          <li>Close your EVM window when you are done: with protection off, nothing watches what a leaked key sends through it.</li>
          <li>To turn protection back on, use Protect: approve the tokens again and link the Guardian.</li>
        </ul>

        <div className="turnoff-step">
          {mark(done("approvals"), 1)}
          <div className="turnoff-main">
            <h3>Revoke the vault's allowances</h3>
            <p className="step-text">
              This is what stops rescues: with no allowance, <span className="mono">vault.rescue</span> has nothing to pull. One{" "}
              <span className="mono">approve(vault, 0)</span> per token from your owner wallet, inside your EVM window.
            </p>
            {done("approvals") ? (
              <>
                <div className="ok-note">No allowance left on fUSD, fETH or fBTC.</div>
                {win.data?.live ? (
                  <WindowCommand action="close" owner={cfg.owner}>
                    Your EVM window is still open, and with protection off nothing watches it. Close it now: a leaked ECDSA key can use it until
                    then.
                  </WindowCommand>
                ) : null}
              </>
            ) : (
              <>
                {allowances.error ? <div className="err">Could not read the allowances: {allowances.error}</div> : null}
                {tokens.length ? (
                  <div className="caption" style={{ marginTop: 8 }}>
                    {tokens.map((t) => t.sym).join(", ")}: {tokens.length} tx{tokens.length === 1 ? "" : "s"} from your window
                    {fees.data ? `, up to ${fmtUqor(plan.cost)} QOR of its budget in fees` : ""}.
                  </div>
                ) : null}
                {!wallet ? (
                  <div style={{ marginTop: 12 }}>
                    <WalletConnect w={wc} small />
                  </div>
                ) : !busy ? (
                  <div style={{ marginTop: 12 }}>
                    <SwitchToDiana w={wc} />
                  </div>
                ) : null}
                {wc.error ? <div className="err">{wc.error}</div> : null}
                {plan.command && !busy ? (
                  <WindowCommand action="open" owner={cfg.owner}>
                    The default owner window lists fUSD, fETH and fBTC. Run this in the repo root (it replaces the current window), then come back.
                  </WindowCommand>
                ) : null}
                <div style={{ marginTop: 12 }}>
                  <button type="button" className="btn danger" disabled={blockers.length > 0 || busy} onClick={() => void revoke()}>
                    {busy
                      ? run.step
                      : tokens.length
                        ? `Revoke ${tokens.length} allowance${tokens.length === 1 ? "" : "s"} with ${wallet?.name ?? "MetaMask"}`
                        : `Revoke allowances with ${wallet?.name ?? "MetaMask"}`}
                  </button>
                </div>
                {blockers.length && !busy ? <div className="caption" style={{ marginTop: 8 }}>To revoke: {blockers.join("; ")}.</div> : null}
                {fees.error && !fees.data ? <div className="err">Could not read the network fee: {fees.error}</div> : null}
              </>
            )}
            {run.hashes.map((h) => (
              <div key={h.hash} className="tl-meta wrap-any">
                {h.sym}: <TxHash hash={h.hash} />
              </div>
            ))}
            {run.state === "error" ? <div className="err">{run.error}</div> : null}
          </div>
        </div>

        <div className="turnoff-step">
          {mark(done("unlink"), 2)}
          <div className="turnoff-main">
            <h3>Unlink the Guardian</h3>
            <p className="step-text">
              Revokes the agent's key on your account. The spending rule stays on the account, but no live key can use it. A hybrid tx the browser
              can't sign, so it runs in the CLI.
            </p>
            {done("unlink") ? (
              <div className="ok-note">No live key is linked to your account.</div>
            ) : (
              <Command cmd={unlinkCommand(cfg.owner)}>
                <div className="caption">
                  Load this owner's run.env (OWNER_MNEMONIC, AGENT_ED25519_SK) first; the command refuses another account.
                </div>
              </Command>
            )}
            {auths.error ? <div className="err">Could not read the linked keys: {auths.error}</div> : null}
          </div>
        </div>

        <div className="turnoff-step">
          {mark(done("agent"), 3)}
          <div className="turnoff-main">
            <h3>Stop the agent</h3>
            <p className="step-text">
              {done("agent")
                ? "The agent does not answer here (stopped, or not reachable from this browser)."
                : "Press Ctrl-C in the terminal running pnpm agent. Watching and alerts end there."}
            </p>
          </div>
        </div>
      </div>
    </details>
  );
}
