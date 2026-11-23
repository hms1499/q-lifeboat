import { NETWORK, vaultAbi, WITHDRAW_GAS } from "@qday/core";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { erc20Abi, zeroAddress, type Hex } from "viem";
import { CheckRow, Command, ExtLink, WindowCommand } from "../components/ui";
import { useWalletConnect, WalletConnect } from "../components/WalletConnect";
import { withWindowHint } from "../lib/actions";
import { explorerTx, publicClient, readPqcStatus, readWindow } from "../lib/chain";
import type { AgentConfig } from "../lib/config";
import { errorText, fmtAmount, fmtInt, shortAddr, shortHash, tokenSymbol } from "../lib/format";
import { usePoll } from "../lib/hooks";
import { windowTargetsLabel } from "../lib/overview";
import { ensureDiana, walletClientFor } from "../lib/wallet";
import { checkWithdrawal, parseWithdrawalJson, type ParsedWithdrawal, type WithdrawalCheck } from "../lib/withdrawal";
import { useApp } from "../state";

const MAX_FILE_BYTES = 64 * 1024;

function vaultBalance(cfg: AgentConfig, token: Hex): Promise<bigint> {
  if (token.toLowerCase() === zeroAddress) return publicClient.getBalance({ address: cfg.vault });
  return publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [cfg.vault] });
}

function runChecks(cfg: AgentConfig, w: ParsedWithdrawal): Promise<WithdrawalCheck[]> {
  return checkWithdrawal(w, {
    vault: cfg.vault,
    chainId: BigInt(NETWORK.evmChainId),
    readPqcStatus: () => readPqcStatus(cfg.owner),
    readOnChainMessage: (x) => publicClient.readContract({ address: cfg.vault, abi: vaultAbi, functionName: "withdrawalMessage", args: [x.to, x.token, x.amount, x.nonce] }),
    readNonce: () => publicClient.readContract({ address: cfg.vault, abi: vaultAbi, functionName: "nonce" }),
    readVaultBalance: (token) => vaultBalance(cfg, token),
  });
}

type Submit =
  | { state: "idle" }
  | { state: "busy"; step: string }
  | { state: "done"; hash: Hex; status: string; nonceBefore: bigint; nonceAfter: bigint | null; w: ParsedWithdrawal }
  | { state: "error"; message: string };

function Dot({ n, on, done }: { n: number; on: boolean; done: boolean }) {
  return <span className={`stepnum ${done ? "done" : on ? "on" : ""}`}>{n}</span>;
}

export function Recover() {
  const { config } = useApp();
  const wc = useWalletConnect();
  const { wallet, chainId, error: walletError } = wc;
  const cfg = config.cfg;
  const [file, setFile] = useState<{ name: string; w: ParsedWithdrawal } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [checks, setChecks] = useState<WithdrawalCheck[] | null>(null);
  const [over, setOver] = useState(false);
  const [submit, setSubmit] = useState<Submit>({ state: "idle" });
  const input = useRef<HTMLInputElement>(null);

  const vault = usePoll(
    async () => {
      if (!cfg) throw new Error("no config");
      const syms = ["fUSD", "fETH", "fBTC"] as const;
      const tokens = await Promise.all(syms.map(async (s) => ({ s, a: await vaultBalance(cfg, cfg.tokens[s]) })));
      return [...tokens, { s: "QOR", a: await vaultBalance(cfg, zeroAddress) }];
    },
    10_000,
    cfg ? cfg.vault : null,
  );
  const submitterWindow = usePoll(() => readWindow(wallet!.account), 10_000, wallet ? wallet.account : null);

  // Re-check whenever the file or the vault changes.
  useEffect(() => {
    setChecks(null);
    if (!cfg || !file) return;
    let live = true;
    void runChecks(cfg, file.w).then((c) => live && setChecks(c));
    return () => {
      live = false;
    };
  }, [cfg, file]);

  async function load(f: File | undefined) {
    setFile(null);
    setFileError(null);
    setSubmit({ state: "idle" });
    if (!f) return;
    if (f.size > MAX_FILE_BYTES) return setFileError(`${f.name} is larger than 64 KiB: not a withdrawal.json`);
    try {
      setFile({ name: f.name, w: parseWithdrawalJson(await f.text()) });
    } catch (e) {
      setFileError(`${f.name}: ${errorText(e)}`);
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setOver(false);
    void load(e.dataTransfer.files[0]);
  }

  async function send() {
    if (!cfg || !file || !wallet) return;
    const w = file.w;
    try {
      setSubmit({ state: "busy", step: "Switching the wallet to diana…" });
      await ensureDiana(wallet.provider);
      const nonceBefore = await publicClient.readContract({ address: cfg.vault, abi: vaultAbi, functionName: "nonce" });
      setSubmit({ state: "busy", step: "Simulating withdraw…" });
      const { request } = await publicClient.simulateContract({
        account: wallet.account,
        address: cfg.vault,
        abi: vaultAbi,
        functionName: "withdraw",
        args: [w.to, w.token, w.amount, w.sig],
        gas: WITHDRAW_GAS,
      });
      setSubmit({ state: "busy", step: `Confirm in ${wallet.name}…` });
      const hash = await walletClientFor(wallet.provider, wallet.account).writeContract(request);
      setSubmit({ state: "busy", step: `Sent ${shortHash(hash)}, waiting for the block…` });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const nonceAfter = await publicClient.readContract({ address: cfg.vault, abi: vaultAbi, functionName: "nonce" }).catch(() => null);
      setSubmit({ state: "done", hash, status: receipt.status, nonceBefore, nonceAfter, w });
      vault.refresh();
    } catch (e) {
      setSubmit({ state: "error", message: withWindowHint(errorText(e)) });
    }
  }

  if (!cfg) return null;

  const allPass = !!checks && checks.every((c) => c.status === "pass");
  const win = submitterWindow.data;
  const winAllowsVault = !!win && (win.allowedTargets.length === 0 || win.allowedTargets.some((t) => t.toLowerCase() === cfg.vault.toLowerCase()));
  const onDiana = chainId === NETWORK.evmChainId;
  const configOk = config.check?.ok === true;
  const isOwner = !!wallet && wallet.account.toLowerCase() === cfg.owner.toLowerCase();
  const blockers = [
    !file && "load a signed withdrawal.json",
    file && !checks && "checks are running",
    checks && !allPass && "every check must pass",
    !configOk && "the agent config must match the vault on chain",
    !wallet && "connect a wallet",
    wallet && !onDiana && "switch the wallet to diana (9800)",
    wallet && win && !win.live && "the submitting account has no live EVM window",
    wallet && win?.live && !winAllowsVault && "the window does not allow the vault",
    wallet && !win && "reading the window",
  ].filter(Boolean) as string[];
  const busy = submit.state === "busy";
  const done = submit.state === "done";

  return (
    <>
      <h1>Recover from your vault</h1>
      <p className="lead">
        Only your ML-DSA-87 key can release funds. You sign on your own machine with Guardian Signer, then any wallet can submit the signed file.
      </p>
      <div className="row">
        <div className="stack" style={{ flex: "999 1 600px", minWidth: 0 }}>
          <section className="card" style={{ padding: 24 }}>
            <div className="step">
              <Dot n={1} on={false} done />
              <h2>Sign on your machine</h2>
            </div>
            <p className="indent" style={{ margin: "10px 0 0 36px", fontSize: 14, color: "var(--ink-2)", lineHeight: 1.55 }}>
              QoreX can't sign arbitrary messages, so the post-quantum signature comes from Guardian Signer, which keeps your ML-DSA key on your machine.
              It writes <span className="mono">withdrawal.json</span> in the repo root.
            </p>
            <div className="indent">
              <Command cmd="pnpm cli sign-withdraw <to> <token> <amount>">
                <span style={{ fontSize: 13, color: "var(--muted)" }}>
                  <span className="mono">&lt;token&gt;</span> is fUSD, fETH, fBTC, QOR or a 0x address; <span className="mono">&lt;amount&gt;</span> a decimal
                  amount, e.g. <span className="mono">pnpm cli sign-withdraw 0x… fUSD 1</span>
                </span>
              </Command>
            </div>
          </section>

          <section className="card" style={{ padding: 24 }}>
            <div className="step">
              <Dot n={2} on={!file} done={!!file && allPass} />
              <h2>Load the signed file</h2>
            </div>
            <div className="indent">
              <div
                className={`drop ${over ? "over" : ""}`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOver(true);
                }}
                onDragLeave={() => setOver(false)}
                onDrop={onDrop}
              >
                <div style={{ fontSize: 15, fontWeight: 600 }}>{file ? `Loaded ${file.name}` : "Drop withdrawal.json here"}</div>
                <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 4 }}>Nothing leaves your browser until you submit</div>
                <input ref={input} type="file" accept="application/json,.json" hidden onChange={(e) => void load(e.target.files?.[0])} />
                <button type="button" className="btn small" style={{ marginTop: 14 }} onClick={() => input.current?.click()}>
                  {file ? "Choose another file" : "Choose file"}
                </button>
              </div>
              {fileError ? <div className="err">{fileError}</div> : null}
              {file ? (
                <div style={{ marginTop: 14 }}>
                  <div className="fields">
                    {[
                      { k: "Pay to", v: file.w.to },
                      { k: "Token", v: `${tokenSymbol(cfg, file.w.token)}${tokenSymbol(cfg, file.w.token).startsWith("0x") ? "" : ` · ${shortAddr(file.w.token)}`}` },
                      { k: "Amount", v: fmtAmount(file.w.amount, 6) },
                      { k: "Vault nonce", v: file.w.nonce.toString() },
                      { k: "Vault", v: file.w.vault },
                      { k: "Signature", v: `ML-DSA-87 · ${fmtInt((file.w.sig.length - 2) / 2)} bytes` },
                    ].map((f) => (
                      <div key={f.k} className="field">
                        <div className="k">{f.k}</div>
                        <div className="v">{f.v}</div>
                      </div>
                    ))}
                  </div>
                  <div className="between" style={{ margin: "18px 0 8px" }}>
                    <span className="lbl">Checks before you submit</span>
                    <button type="button" className="btn small" onClick={() => setFile({ ...file })}>
                      Check again
                    </button>
                  </div>
                  <div className="checks">
                    {checks ? checks.map((c) => <CheckRow key={c.id} status={c.status} title={c.title} detail={c.detail} />) : <CheckRow status="pending" title="Checking against the chain…" />}
                  </div>
                </div>
              ) : null}
            </div>
          </section>

          <section className="card" style={{ padding: 24 }}>
            <div className="step">
              <Dot n={3} on={!!file && allPass && !done} done={done} />
              <h2>Submit</h2>
            </div>
            <p className="indent" style={{ margin: "10px 0 14px 36px", fontSize: 14, color: "var(--ink-2)", lineHeight: 1.55 }}>
              The signature is what authorizes the payout, so any funded wallet with an open EVM window can send it. Use a fresh one if you think this
              account is compromised.
            </p>
            <div className="indent">
              {!wallet ? (
                <WalletConnect w={wc} />
              ) : (
                <dl className="kv" style={{ marginTop: 0, marginBottom: 14 }}>
                  <div>
                    <dt>Submitting account</dt>
                    <dd className="mono">
                      {shortAddr(wallet.account)}
                      <small>{isOwner ? "the owner" : "not the owner: fine, the signature authorizes the payout"}</small>
                    </dd>
                  </div>
                  <div>
                    <dt>Network</dt>
                    <dd style={onDiana ? undefined : { color: "var(--orange)" }}>{onDiana ? "diana · 9800" : `chain ${chainId ?? "?"}: switch to diana`}</dd>
                  </div>
                  <div>
                    <dt>Its EVM window</dt>
                    <dd style={win && (!win.live || !winAllowsVault) ? { color: "var(--orange)" } : undefined}>
                      {!win ? (submitterWindow.error ? "could not read" : "…") : win.live ? `open · ${fmtInt(win.remainingBlocks)} blocks, ${fmtInt(win.remainingTxs)} txs left` : "closed"}
                      {win?.live ? <small>targets: {windowTargetsLabel(win.allowedTargets, cfg)}</small> : null}
                    </dd>
                  </div>
                </dl>
              )}
              {walletError ? <div className="err">{walletError}</div> : null}
              {wallet && win && !win.live ? (
                isOwner ? (
                  <WindowCommand action="open" owner={cfg.owner}>
                    Every EVM tx on diana needs a live window, opened by a hybrid tx the browser can't sign. Run this in the repo root (it opens the owner's
                    window, scoped to the vault among others), then come back. Close it afterwards with{" "}
                    <span className="mono">pnpm cli window close --expect {cfg.owner}</span>.
                  </WindowCommand>
                ) : (
                  <div className="banner warn" style={{ marginBottom: 14 }}>
                    This account has no live EVM window. <span className="mono">pnpm cli window open</span> opens the owner's window only: connect the owner
                    account, or open a window for this account first.
                  </div>
                )
              ) : null}

              {done && submit.state === "done" ? (
                <div className="done-box" style={{ marginTop: 14 }}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#1E4FD8" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M5 12l5 5 9-10" />
                  </svg>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 600 }}>
                      {submit.status === "success"
                        ? `${fmtAmount(submit.w.amount, 6)} ${tokenSymbol(cfg, submit.w.token)} sent to ${shortAddr(submit.w.to)}`
                        : "The withdraw reverted on chain"}
                    </div>
                    <div className="mono wrap-any" style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 4 }}>
                      tx <ExtLink href={explorerTx(submit.hash)}>{submit.hash}</ExtLink> · vault nonce {submit.nonceBefore.toString()} →{" "}
                      {submit.nonceAfter === null ? "?" : submit.nonceAfter.toString()}
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ marginTop: 14 }}>
                    <button type="button" className="btn primary" disabled={blockers.length > 0 || busy} onClick={() => void send()}>
                      {busy && submit.state === "busy" ? submit.step : wallet ? `Submit with ${wallet.name}` : "Submit with MetaMask"}
                    </button>
                  </div>
                  {blockers.length && !busy ? <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 8 }}>To submit: {blockers.join("; ")}.</div> : null}
                  {submit.state === "error" ? <div className="err">{submit.message}</div> : null}
                </>
              )}
            </div>
          </section>
        </div>

        <aside className="side">
          <section className="card">
            <div className="lbl">Your vault</div>
            <div className="mono wrap-any" style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 4 }}>
              {cfg.vault}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14 }}>
              {vault.data
                ? vault.data.map((v) => (
                    <div key={v.s} className="between" style={{ fontSize: 15 }}>
                      <span style={{ fontWeight: 600 }}>{v.s}</span>
                      <span className="mono">{fmtAmount(v.a)}</span>
                    </div>
                  ))
                : <div className="empty">{vault.error ?? "Reading…"}</div>}
            </div>
          </section>
          <section className="card">
            <h3 className="h" style={{ margin: "0 0 8px", fontSize: 17, fontWeight: 600 }}>
              What the signature binds
            </h3>
            <p style={{ margin: 0, fontSize: 13, color: "var(--muted)", lineHeight: 1.6 }}>
              Tag, chain ID, this vault, the recipient, the token, the amount and the vault's current nonce. Change any of them and the vault rejects it. A used
              signature can't be replayed.
            </p>
          </section>
        </aside>
      </div>
    </>
  );
}
