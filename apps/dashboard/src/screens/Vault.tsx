import type { TokenSymbol } from "@qday/core";
import { useState } from "react";
import { erc20Abi, formatUnits, getAddress, parseUnits, type Hex } from "viem";
import { useKeys } from "../components/KeysProvider";
import { CheckRow, TxHash } from "../components/ui";
import { appSession, DIANA_TOKENS, hosted, readVaultRoles } from "../lib/appWallet";
import { publicClient } from "../lib/chain";
import { fmtAmount, shortAddr } from "../lib/format";
import { usePoll } from "../lib/hooks";
import { ownerVault } from "../lib/ownerVault";
import { loadProtectState } from "../lib/protect";
import { browserStorage } from "../lib/storage";
import { checkWithdraw } from "../lib/vaultForm";
import { WithdrawFailed, withdrawFromVault } from "../lib/vaultWithdraw";
import type { WithdrawalCheck } from "../lib/withdrawal";

const SYMBOLS: TokenSymbol[] = ["fUSD", "fETH", "fBTC"];
type Done = { hash: Hex; ok: boolean; sym: TokenSymbol; amount: string; to: Hex };

/** The vault: what it holds, and a 3-step withdrawal (what, where, review) signed with the recovery-code key. */
export function Vault({ owner }: { owner: Hex }) {
  const keys = useKeys();
  const vault = usePoll(
    async () => {
      const fromService = await hosted
        .owner(owner)
        .then((s) => s.vault)
        .catch(() => undefined);
      return ownerVault(owner, [fromService, loadProtectState(browserStorage(), owner).vault], readVaultRoles);
    },
    30_000,
    owner,
  );
  const v = vault.data ?? null;
  const balances = usePoll(
    () => Promise.all(SYMBOLS.map((s) => publicClient.readContract({ address: DIANA_TOKENS[s], abi: erc20Abi, functionName: "balanceOf", args: [v!] }))),
    8_000,
    v,
  );
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [sym, setSym] = useState<TokenSymbol>("fUSD");
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ message: string; checks?: WithdrawalCheck[]; hash?: Hex } | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  const bal = balances.data ? balances.data[SYMBOLS.indexOf(sym)] : undefined;
  const errs = v ? checkWithdraw({ amount, balance: bal, to, owner, vault: v }) : {};

  async function sign() {
    if (!v || errs.amount || errs.to) return;
    if (!(await keys.requireKeys("pqc"))) return;
    const acc = appSession.account();
    if (!acc) return;
    setFailed(null);
    try {
      const recipient = getAddress(to.trim());
      const r = await withdrawFromVault(acc, { owner, vault: v, to: recipient, token: DIANA_TOKENS[sym], amount: parseUnits(amount.trim(), 18) }, setBusy);
      setDone({ hash: r.hash, ok: r.ok, sym, amount: amount.trim(), to: recipient });
      balances.refresh();
    } catch (e) {
      setFailed(e instanceof WithdrawFailed ? { message: e.message, checks: e.checks, hash: e.hash } : { message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(null);
    }
  }

  const holdings = (
    <section className="card">
      <h2>In your vault</h2>
      <dl className="kv">
        {SYMBOLS.map((s, i) => (
          <div key={s}>
            <dt>{s}</dt>
            <dd className="mono">{balances.data ? fmtAmount(balances.data[i]!) : balances.error ? "could not read" : "…"}</dd>
          </div>
        ))}
      </dl>
      {v ? <p className="dash-hint" style={{ marginTop: 10 }}>Vault <span className="mono">{shortAddr(v)}</span>. Only your recovery code can release what it holds.</p> : null}
    </section>
  );

  let body: JSX.Element;
  if (!v) {
    body = (
      <section className="card">
        <p className="dash-hint">{vault.data === null ? "No vault owned by this account was found on chain." : vault.error ? `Could not read your vault: ${vault.error}` : "Looking up your vault…"}</p>
      </section>
    );
  } else if (done) {
    body = (
      <section className={`dash-hero ${done.ok ? "safe" : "alert"}`} role="status">
        <div className="dash-eyebrow">{done.ok ? "Withdrawn" : "The withdrawal reverted"}</div>
        <h2>
          {done.amount} {done.sym} {done.ok ? "sent to" : "was not sent to"} {shortAddr(done.to)}
        </h2>
        <p>
          <TxHash hash={done.hash} full />
        </p>
        <div className="actions">
          <button
            type="button"
            className="btn"
            onClick={() => {
              setDone(null);
              setStep(1);
              setAmount("");
            }}
          >
            Withdraw something else
          </button>
          <a className="btn" href="#/dashboard">
            Back to dashboard
          </a>
        </div>
      </section>
    );
  } else {
    const stepper = (
      <ol className="vault-steps" aria-label="Withdrawal steps">
        {["What", "Where", "Review"].map((x, i) => (
          <li key={x} className={i + 1 === step ? "on" : i + 1 < step ? "done" : ""} aria-current={i + 1 === step ? "step" : undefined}>
            {i + 1}. {x}
          </li>
        ))}
      </ol>
    );
    body = (
      <section className="card vault-card">
        <h2>Withdraw</h2>
        {stepper}
        {step === 1 ? (
          <>
            <div className="vault-tokens" role="radiogroup" aria-label="Token">
              {SYMBOLS.map((s, i) => (
                <button key={s} type="button" role="radio" aria-checked={sym === s} className={`btn ${sym === s ? "primary" : ""}`} onClick={() => setSym(s)}>
                  {s} · {balances.data ? fmtAmount(balances.data[i]!) : "…"}
                </button>
              ))}
            </div>
            <label className="setup-field">
              Amount
              <span className="vault-amount">
                <input className="input mono" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
                <button type="button" className="btn" disabled={bal === undefined} onClick={() => bal !== undefined && setAmount(formatUnits(bal, 18))}>
                  Max
                </button>
              </span>
            </label>
            {amount && errs.amount ? <p className="err">{errs.amount}</p> : null}
            <div className="actions">
              <button type="button" className="btn primary" disabled={!!errs.amount} onClick={() => setStep(2)}>
                Next
              </button>
            </div>
          </>
        ) : step === 2 ? (
          <>
            <label className="setup-field">
              Send to
              <input className="input mono" value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" />
            </label>
            <p className="dash-hint">Use a fresh address whose key never touched this account's key.</p>
            {to && errs.to ? <p className="err">{errs.to}</p> : null}
            <div className="actions">
              <button type="button" className="btn" onClick={() => setStep(1)}>
                Back
              </button>
              <button type="button" className="btn primary" disabled={!!errs.to} onClick={() => setStep(3)}>
                Next
              </button>
            </div>
          </>
        ) : (
          <>
            <dl className="kv vault-review">
              <div>
                <dt>Send</dt>
                <dd>
                  <b>
                    {amount.trim()} {sym}
                  </b>
                </dd>
              </div>
              <div>
                <dt>From</dt>
                <dd>your vault</dd>
              </div>
              <div>
                <dt>To</dt>
                <dd className="mono wrap-any">{to.trim()}</dd>
              </div>
              <div>
                <dt>Signed with</dt>
                <dd>your recovery-code key, in this tab</dd>
              </div>
            </dl>
            {busy ? (
              <p className="dash-hint" role="status">
                {busy}
              </p>
            ) : null}
            {failed ? (
              <div role="alert">
                <p className="err">{failed.message}</p>
                {failed.hash ? (
                  <p className="dash-hint">
                    The withdrawal was sent: check its receipt before trying again. <TxHash hash={failed.hash} full />
                  </p>
                ) : null}
                {failed.checks?.map((c) => <CheckRow key={c.id} status={c.status} title={c.title} detail={c.detail} />)}
              </div>
            ) : null}
            <div className="actions">
              <button type="button" className="btn" disabled={!!busy} onClick={() => setStep(2)}>
                Back
              </button>
              <button type="button" className="btn rescue" disabled={!!busy || !!errs.amount || !!errs.to} onClick={() => void sign()}>
                {busy ? "Working…" : "Sign and withdraw"}
              </button>
            </div>
          </>
        )}
      </section>
    );
  }

  return (
    <>
      <h1>Vault</h1>
      <p className="lead">Tokens here leave only with a signature from your recovery code. After a rescue, move them to a fresh address.</p>
      <div className="row">
        <div className="stack grow">{body}</div>
        <div className="side">{holdings}</div>
      </div>
    </>
  );
}
