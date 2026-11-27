import { NETWORK, vaultAbi } from "@qday/core";
import { normalizeRecoveryCode, pqcKeyFromRecoveryCode } from "@qorechain/sdk";
import { useEffect, useState } from "react";
import { erc20Abi, getAddress, isAddress, parseUnits, type Hex } from "viem";
import { useApp } from "../state";
import { CheckRow, TxHash } from "../components/ui";
import { DIANA_TOKENS, hosted, readVaultRoles } from "../lib/appWallet";
import { publicClient, qorAddress, readPqcStatus } from "../lib/chain";
import { errorText, fmtAmount, shortAddr } from "../lib/format";
import { parseRecoveryTxt, restoreChecks, findOwnerVault, signedFile, sponsorBody, type RestoreCheck, type VaultLookup } from "../lib/restore";
import { CODE_POWER } from "../lib/setup";
import { checkWithdraw } from "../lib/vaultForm";
import { checksFor } from "../lib/vaultWithdraw";
import { signWithdrawalInBrowser, type ParsedWithdrawal, type WithdrawalCheck } from "../lib/withdrawal";
import type { TokenSymbol } from "@qday/core";

const SYMBOLS: TokenSymbol[] = ["fUSD", "fETH", "fBTC"];
const MAX_FILE_BYTES = 64 * 1024;

/**
 * Restore access from the recovery code alone: no seed, no wallet file, no session. The code makes the post-quantum
 * key, the browser signs the withdrawal with it, and the service pays the gas. Only the recipient the owner names can
 * be paid, and the code never leaves the tab.
 */
export function Restore() {
  const { config } = useApp();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [account, setAccount] = useState("");
  const [code, setCode] = useState("");
  const [fileError, setFileError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [checks, setChecks] = useState<RestoreCheck[] | null>(null);
  const [lookup, setLookup] = useState<(VaultLookup & { balances: Record<TokenSymbol, bigint> }) | null>(null);

  const [sym, setSym] = useState<TokenSymbol>("fUSD");
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [signed, setSigned] = useState<ParsedWithdrawal | null>(null);
  const [vaultChecks, setVaultChecks] = useState<WithdrawalCheck[] | null>(null);
  const [sent, setSent] = useState<{ hash: string; status: string } | null>(null);

  const parsed = isAddress(account.trim(), { strict: false }) ? (account.trim() as Hex) : null;
  const bal = lookup?.balances[sym];

  // Once a signed file exists, the submitted hash may take a moment: nothing else runs meanwhile.
  useEffect(() => setError(null), [step]);

  async function loadFile(f: File | undefined) {
    setFileError(null);
    if (!f) return;
    if (f.size > MAX_FILE_BYTES) return setFileError(`${f.name} is larger than 64 KiB: not a recovery file`);
    try {
      const r = parseRecoveryTxt(await f.text());
      setAccount(r.account);
      setCode(r.code);
    } catch (e) {
      setFileError(`${f.name}: ${errorText(e)}`);
    }
  }

  async function verify() {
    if (!parsed) return;
    setError(null);
    setLookup(null);
    setChecks(null);
    try {
      setBusy("Reading your key and vault from the chain…");
      const status = await readPqcStatus(parsed);
      // Derive exactly what this code makes for this account; the key dies with this call.
      const key = pqcKeyFromRecoveryCode(normalizeRecoveryCode(code), qorAddress(parsed));
      let derived: Uint8Array;
      try {
        derived = key.publicKey;
      } finally {
        key.secretKey.fill(0);
      }
      const known = await hosted
        .owner(parsed)
        .then((s) => s.vault ?? null)
        .catch(() => null);
      const found = await findOwnerVault(parsed, { txCount: (a) => publicClient.getTransactionCount({ address: a }), roles: readVaultRoles }, known);
      const c = restoreChecks({ account: parsed, derived, status, roles: found?.roles ?? null });
      setChecks(c);
      if (found) {
        const balances = await Promise.all(SYMBOLS.map((s) => publicClient.readContract({ address: DIANA_TOKENS[s], abi: erc20Abi, functionName: "balanceOf", args: [found.address] })));
        setLookup({ ...found, balances: { fUSD: balances[0]!, fETH: balances[1]!, fBTC: balances[2]! } });
      }
      setStep(2);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function sign() {
    if (!parsed || !lookup) return;
    setError(null);
    try {
      setBusy("Reading the vault's nonce…");
      const [status, nonce] = await Promise.all([
        readPqcStatus(parsed),
        publicClient.readContract({ address: lookup.address, abi: vaultAbi, functionName: "nonce" }),
      ]);
      setBusy("Signing with your recovery-code key…");
      const key = pqcKeyFromRecoveryCode(normalizeRecoveryCode(code), qorAddress(parsed));
      let w: ParsedWithdrawal;
      try {
        w = signWithdrawalInBrowser({ pqc: key }, { vault: lookup.address, to: getAddress(to.trim()), token: DIANA_TOKENS[sym], amount: parseUnits(amount.trim(), 18), nonce }, status);
      } finally {
        key.secretKey.fill(0);
      }
      setBusy("Checking the signature against the vault…");
      const c = await checksFor(lookup.address, w, parsed);
      setSigned(w);
      setVaultChecks(c);
      setStep(3);
      if (!c.every((x) => x.status === "pass")) setError("The vault would refuse this withdrawal: read the checks below.");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  async function submit() {
    if (!parsed || !signed) return;
    setError(null);
    try {
      setBusy("Asking the service to send it…");
      setSent(await hosted.submitWithdrawal(sponsorBody(signed, parsed)));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  }

  const errs = lookup && parsed ? checkWithdraw({ amount, balance: bal, to, owner: parsed, vault: lookup.address }) : {};
  const okChecks = !!checks && checks.every((c) => c.status === "pass");
  const okVault = !!vaultChecks && vaultChecks.every((c) => c.status === "pass");

  return (
    <>
      <h1>Restore access</h1>
      <p className="lead">
        Lost this browser, or the wallet file? Your recovery code still makes the key that signs withdrawals from your vault. Nothing is stored: the code is
        used in this tab and dropped.
      </p>

      {step === 1 ? (
        <section className="card setup-card">
          <h2>Your account and code</h2>
          <p className="setup-hint">
            Either drop the <span className="mono">.txt</span> you downloaded when you set up, or type both values. The file holds your account address and
            the code.
          </p>
          <label className="setup-field">
            Recovery file
            <input
              className="input"
              type="file"
              accept="text/plain,.txt"
              onChange={(e) => void loadFile(e.target.files?.[0])}
              style={{ paddingTop: 9 }}
            />
          </label>
          {fileError ? <p className="err">{fileError}</p> : null}
          <label className="setup-field">
            Account
            <input className="input mono" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" />
          </label>
          <label className="setup-field">
            Recovery code
            <input
              className="input mono"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="QRC1-…"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="characters"
            />
          </label>
          <p className="banner warn" role="note" style={{ margin: 0 }}>
            {CODE_POWER} Keep it private: this screen never stores it.
          </p>
          <div className="actions">
            <button type="button" className="btn primary" disabled={!parsed || !code.trim() || !!busy} onClick={() => void verify()}>
              {busy ?? "Continue"}
            </button>
            <a className="btn" href="#/home">
              Back
            </a>
          </div>
          {error ? <p className="err">{error}</p> : null}
        </section>
      ) : null}

      {step >= 2 ? (
        <section className="card setup-card">
          <h2>What the chain says</h2>
          <div className="checks">
            {(checks ?? []).map((c) => (
              <CheckRow key={c.id} status={c.status === "pass" ? "pass" : "fail"} title={c.title} detail={c.detail} />
            ))}
          </div>
          {lookup ? (
            <dl className="kv">
              <div>
                <dt>Vault</dt>
                <dd className="mono wrap-any">{lookup.address}</dd>
              </div>
              {SYMBOLS.map((s) => (
                <div key={s}>
                  <dt>{s}</dt>
                  <dd className="mono">{fmtAmount(lookup.balances[s])}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {!okChecks ? (
            <p className="err">
              A check failed, so nothing can be signed yet. Check the account and the code: this recovers your vault, not the account's own key.
            </p>
          ) : null}
        </section>
      ) : null}

      {step === 2 && okChecks && lookup ? (
        <section className="card setup-card">
          <h2>Withdraw</h2>
          <div className="vault-tokens" role="radiogroup" aria-label="Token">
            {SYMBOLS.map((s) => (
              <button key={s} type="button" role="radio" aria-checked={sym === s} className={`btn ${sym === s ? "primary" : ""}`} onClick={() => setSym(s)}>
                {s} · {fmtAmount(lookup.balances[s])}
              </button>
            ))}
          </div>
          <label className="setup-field">
            Amount
            <input className="input mono" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
          </label>
          {amount && errs.amount ? <p className="err">{errs.amount}</p> : null}
          <label className="setup-field">
            Send to
            <input className="input mono" value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" spellCheck={false} autoComplete="off" />
          </label>
          <p className="setup-hint">Use a fresh address whose key never touched this account's key.</p>
          {to && errs.to ? <p className="err">{errs.to}</p> : null}
          <div className="actions">
            <button type="button" className="btn rescue" disabled={!!errs.amount || !!errs.to || !!busy} onClick={() => void sign()}>
              {busy ?? "Sign and withdraw"}
            </button>
          </div>
          {error ? <p className="err">{error}</p> : null}
        </section>
      ) : null}

      {step === 3 && signed ? (
        <section className={`dash-hero ${sent?.status === "success" ? "safe" : ""}`} role="status">
          <div className="dash-eyebrow">{sent ? (sent.status === "success" ? "Withdrawn" : "The withdrawal reverted") : "Signed"}</div>
          <h2>
            {fmtAmount(signed.amount)} {sym} {sent ? (sent.status === "success" ? "sent to" : "was not sent to") : "for"} {shortAddr(signed.to)}
          </h2>
          {sent ? (
            <p>
              <TxHash hash={sent.hash} full />
            </p>
          ) : (
            <p>The vault accepts this signed withdrawal from any account, so the service can send it and pay the fee. It cannot change the recipient.</p>
          )}
          {vaultChecks ? (
            <div className="checks">
              {vaultChecks.map((c) => (
                <CheckRow key={c.id} status={c.status} title={c.title} detail={c.detail} />
              ))}
            </div>
          ) : null}
          <div className="actions">
            {!sent ? (
              <button type="button" className="btn primary" disabled={!okVault || !!busy} onClick={() => void submit()}>
                {busy ?? "Send it"}
              </button>
            ) : null}
            <button
              type="button"
              className="btn"
              onClick={() => {
                const blob = new Blob([signedFile(signed)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "withdrawal.json";
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              }}
            >
              Download the signed file
            </button>
            <a className="btn" href={config.cfg ? "#/dashboard" : "#/home"}>
              {config.cfg ? "Back to dashboard" : "Back to the homepage"}
            </a>
          </div>
          {error ? <p className="err">{error}</p> : null}
          <p className="setup-hint">
            The file is the same one a wallet submits: anyone with a funded diana account can send it, and nobody can change where it pays. Chain id{" "}
            {NETWORK.evmChainId}.
          </p>
        </section>
      ) : null}
    </>
  );
}
