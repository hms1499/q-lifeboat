import { NETWORK, vaultAbi, WITHDRAW_GAS, type TokenSymbol } from "@qday/core";
import { clearPqcStatusCache } from "@qorechain/sdk";
import { useState } from "react";
import { erc20Abi, getAddress, isAddress, parseUnits, zeroAddress, type Hex } from "viem";
import { appSession, DIANA_TOKENS, ownerTx } from "../lib/appWallet";
import { publicClient, readFees, readPqcStatus } from "../lib/chain";
import { errorText, fmtAmount, shortAddr } from "../lib/format";
import { usePoll } from "../lib/hooks";
import { checkWithdrawal, signWithdrawalInBrowser, type ParsedWithdrawal, type WithdrawalCheck } from "../lib/withdrawal";
import { NeedKeys } from "./Keys";
import { CheckRow, TxHash } from "./ui";

const SYMBOLS: TokenSymbol[] = ["fUSD", "fETH", "fBTC"];

type State =
  | { s: "idle" }
  | { s: "busy"; step: string; checks?: WithdrawalCheck[] }
  | { s: "failed"; message: string; checks?: WithdrawalCheck[]; windowTx?: string; hash?: Hex }
  | { s: "done"; hash: Hex; windowTx: string; ok: boolean; w: ParsedWithdrawal; checks: WithdrawalCheck[] };

function checksFor(vault: Hex, w: ParsedWithdrawal, owner: Hex) {
  return checkWithdrawal(w, {
    vault,
    chainId: BigInt(NETWORK.evmChainId),
    readPqcStatus: () => readPqcStatus(owner),
    readOnChainMessage: (x) => publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "withdrawalMessage", args: [x.to, x.token, x.amount, x.nonce] }),
    readNonce: () => publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "nonce" }),
    readVaultBalance: (token) =>
      token.toLowerCase() === zeroAddress
        ? publicClient.getBalance({ address: vault })
        : publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [vault] }),
  });
}

/**
 * Step 6 with the in-app wallet: the withdrawal is signed in this browser with the post-quantum key from the recovery
 * code (never stored), every vault check runs against the chain, and only then is `vault.withdraw` sent in a 1-tx
 * window scoped to the vault.
 */
export function BrowserWithdraw({ owner, vault }: { owner: Hex; vault: Hex }) {
  const [, setVer] = useState(0);
  const bump = () => setVer((v) => v + 1);
  const pqc = usePoll(() => {
    clearPqcStatusCache();
    return readPqcStatus(owner);
  }, 30_000, owner);
  const balances = usePoll(
    () => Promise.all(SYMBOLS.map((s) => publicClient.readContract({ address: DIANA_TOKENS[s], abi: erc20Abi, functionName: "balanceOf", args: [vault] }))),
    8_000,
    vault,
  );
  const [to, setTo] = useState("");
  const [sym, setSym] = useState<TokenSymbol>("fUSD");
  const [amount, setAmount] = useState("");
  const [st, setSt] = useState<State>({ s: "idle" });

  const inVault = balances.data ? balances.data[SYMBOLS.indexOf(sym)]! : undefined;
  let parsed: bigint | null = null;
  let amountProblem: string | null = null;
  try {
    parsed = amount.trim() ? parseUnits(amount.trim(), 18) : null;
    if (parsed !== null && parsed <= 0n) amountProblem = "the amount must be above zero";
    else if (parsed !== null && inVault !== undefined && parsed > inVault) amountProblem = `the vault holds ${fmtAmount(inVault)} ${sym}`;
  } catch {
    amountProblem = "not a decimal amount";
  }
  const toOk = isAddress(to.trim()) && to.trim().toLowerCase() !== zeroAddress;
  const toIsOwner = toOk && to.trim().toLowerCase() === owner.toLowerCase();
  const toIsVault = toOk && to.trim().toLowerCase() === vault.toLowerCase();
  const blockers = [
    !toOk && "a 0x recipient address",
    toIsOwner && "a recipient other than this account",
    toIsVault && "a recipient other than the vault itself",
    (!parsed || amountProblem) && (amountProblem ?? "an amount"),
  ].filter(Boolean) as string[];
  const busy = st.s === "busy";

  async function withdraw() {
    const acc = appSession.account();
    if (!acc || !parsed || !toOk) return;
    const recipient = getAddress(to.trim());
    const token = DIANA_TOKENS[sym];
    let checks: WithdrawalCheck[] | undefined;
    let windowTx: string | undefined;
    let hash: Hex | null = null;
    try {
      setSt({ s: "busy", step: "Reading your key and the vault nonce…" });
      clearPqcStatusCache();
      const [status, nonce] = await Promise.all([readPqcStatus(owner), publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "nonce" })]);
      setSt({ s: "busy", step: "Signing with your post-quantum key (ML-DSA-87)…" });
      // Throws, before signing, unless the session's key is the one registered and proven on chain.
      const w = signWithdrawalInBrowser(acc, { vault, to: recipient, token, amount: parsed, nonce }, status);
      setSt({ s: "busy", step: "Checking it against the vault…" });
      checks = await checksFor(vault, w, owner);
      if (!checks.every((c) => c.status === "pass")) {
        setSt({ s: "failed", message: "A check failed, so nothing was sent.", checks });
        return;
      }
      const fees = await readFees();
      setSt({ s: "busy", step: "Arming your Guardian, then opening a 1-tx window for the vault…", checks });
      const out = await ownerTx.withOwnerWindow(acc, { txs: 1, scope: [vault] }, async (wl) => {
        setSt({ s: "busy", step: "Sending the withdraw…", checks });
        hash = await wl.writeContract({ address: vault, abi: vaultAbi, functionName: "withdraw", args: [w.to, w.token, w.amount, w.sig], gas: WITHDRAW_GAS, ...fees });
        return [hash];
      });
      windowTx = out.windowTx;
      setSt({ s: "busy", step: "Waiting for the block…", checks });
      const r = await publicClient.waitForTransactionReceipt({ hash: hash! });
      setSt({ s: "done", hash: hash!, windowTx: out.windowTx, ok: r.status === "success", w, checks });
      balances.refresh();
    } catch (e) {
      setSt({ s: "failed", message: errorText(e), checks, windowTx, hash: hash ?? undefined });
    }
  }

  const shownChecks = st.s === "idle" ? undefined : st.checks;
  return (
    <section className="card roomy">
      <h2>Withdraw with your recovery code</h2>
      <p style={{ fontSize: 14, color: "var(--muted)", marginTop: 0 }}>
        Your post-quantum key signs the withdrawal here, in this tab: tag, chain, this vault, the recipient, the token, the amount and the vault's nonce.
        Nothing else can release your tokens.
      </p>
      <dl className="kv" style={{ marginTop: 0 }}>
        {SYMBOLS.map((s, i) => (
          <div key={s}>
            <dt>{s} in your vault</dt>
            <dd className="mono">{balances.data ? fmtAmount(balances.data[i]!) : balances.error ? "could not read" : "reading…"}</dd>
          </div>
        ))}
      </dl>
      <NeedKeys pqc={pqc.data} onChange={bump}>
        <div className="form">
          <label>
            Send to (a fresh address you control)
            <input className="input mono" autoComplete="off" spellCheck={false} placeholder="0x…" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
          {toIsOwner ? (
            <div className="banner warn" role="alert" style={{ marginTop: 8 }}>
              That is this account: the one whose key a thief may hold. Withdraw to a fresh address.
            </div>
          ) : null}
          <div className="fields" style={{ marginTop: 10 }}>
            <label>
              Token
              <select className="input" value={sym} onChange={(e) => setSym(e.target.value as TokenSymbol)}>
                {SYMBOLS.map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </label>
            <label>
              Amount
              <input className="input mono" inputMode="decimal" placeholder="50" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </label>
          </div>
          <div className="actions">
            <button type="button" className="btn primary" disabled={busy || blockers.length > 0} onClick={() => void withdraw()}>
              {busy && st.s === "busy" ? st.step : "Sign and withdraw"}
            </button>
          </div>
          {blockers.length && !busy ? <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 8 }}>Needs: {blockers.join("; ")}.</div> : null}
        </div>
      </NeedKeys>
      {shownChecks ? (
        <div className="checks" style={{ marginTop: 14 }}>
          {shownChecks.map((c) => (
            <CheckRow key={c.id} status={c.status} title={c.title} detail={c.detail} />
          ))}
        </div>
      ) : null}
      {st.s === "failed" ? (
        <div className="err" style={{ marginTop: 10 }}>
          {st.message}
          {st.windowTx ? (
            <div style={{ fontSize: 12 }}>
              window tx <TxHash hash={st.windowTx} full />
            </div>
          ) : null}
          {st.hash ? (
            <div style={{ fontSize: 12 }}>
              withdraw tx (check its receipt before trying again) <TxHash hash={st.hash} full />
            </div>
          ) : null}
        </div>
      ) : null}
      {st.s === "done" ? (
        <div className={st.ok ? "ok-note" : "err"} style={{ marginTop: 12 }}>
          {st.ok ? `${fmtAmount(st.w.amount)} ${SYMBOLS.find((s) => DIANA_TOKENS[s].toLowerCase() === st.w.token.toLowerCase()) ?? shortAddr(st.w.token)} sent to ${shortAddr(st.w.to)}.` : "The withdraw reverted on chain."}
          <div style={{ fontSize: 12, marginTop: 4 }}>
            window <TxHash hash={st.windowTx} full />
          </div>
          <div style={{ fontSize: 12 }}>
            withdraw <TxHash hash={st.hash} full />
          </div>
        </div>
      ) : null}
    </section>
  );
}
