import { APPROVE_GAS, buildGuardianLinkMsgsFromProof, buildRegisterMsg, DEPLOY_GAS, MINT_AMOUNT, MINT_GAS, NETWORK, ruleIsExact, type TokenSymbol } from "@qday/core";
import { broadcastTx, uqorBalance } from "@qday/core/chain";
import { clearPqcStatusCache, normalizeRecoveryCode } from "@qorechain/sdk";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { bytesToHex, erc20Abi, maxUint256, parseAbi, type Hex } from "viem";
import { IDLE, RunView, track, type Run } from "../components/Run";
import { useKeys } from "../components/KeysProvider";
import { hostedAgentUrl, setAgentBase } from "../lib/agent";
import { appSession, DIANA_TOKENS, hosted, ownerTx, readVaultRoles } from "../lib/appWallet";
import { publicClient, qorAddress, readAuthenticators, readFees, readPqcStatus, readSpendingRules } from "../lib/chain";
import { errorText, fmtUqor, shortAddr } from "../lib/format";
import { usePoll } from "../lib/hooks";
import { HostedError } from "../lib/hosted";
import { loadSeed, type EncryptedSeed } from "../lib/keystore";
import { canStartOver, landingStart, loadCodeConfirmed, locateVault, nextOnboardStep, protectWindowPlan, runOnStepChange, saveCodeConfirmed, type JourneyStep } from "../lib/onboard";
import { hasLiveAuthenticator, loadProtectState, saveProtectState } from "../lib/protect";
import { checkConfirm, confirmPicks } from "../lib/session";
import { formatRecoveryCode, phaseOf, recoveryFile } from "../lib/setup";
import { browserStorage } from "../lib/storage";
import { getVaultArtifact } from "../lib/vaultArtifact";
import type { OwnerWallet } from "../lib/ownerTx";
import { runVaultStep } from "../lib/vaultStep";

const storage = browserStorage();
const mintAbi = parseAbi(["function mint(address to, uint256 amount)"]);
const SYMBOLS: TokenSymbol[] = ["fUSD", "fETH", "fBTC"];
const MIN_PASSWORD = 10;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const norm = (h: string) => h.replace(/^0x/i, "").toLowerCase();

type OnboardStep = Exclude<JourneyStep, "attack" | "withdraw" | "done">;
const ORDER: OnboardStep[] = ["account", "code", "starter", "register", "guardian", "vault", "protect"];

/** The recovery code just created: memory only, shown once, dropped as soon as it is confirmed. Never stored. */
let freshCode: string | null = null;

/** The owner's three token allowances to the vault. */
async function readAllowances(owner: Hex, vault: Hex): Promise<Record<TokenSymbol, bigint>> {
  const [fUSD, fETH, fBTC] = await Promise.all(
    SYMBOLS.map((s) => publicClient.readContract({ address: DIANA_TOKENS[s], abi: erc20Abi, functionName: "allowance", args: [owner, vault] })),
  );
  return { fUSD, fETH, fBTC };
}

/** fUSD, fETH and fBTC on the owner's account and in the vault. */
async function readBalances(owner: Hex, vault: Hex): Promise<{ owned: Record<TokenSymbol, bigint>; inVault: Record<TokenSymbol, bigint> }> {
  const read = (who: Hex) =>
    Promise.all(SYMBOLS.map((s) => publicClient.readContract({ address: DIANA_TOKENS[s], abi: erc20Abi, functionName: "balanceOf", args: [who] })));
  const [o, v] = await Promise.all([read(owner), read(vault)]);
  return { owned: { fUSD: o[0]!, fETH: o[1]!, fBTC: o[2]! }, inVault: { fUSD: v[0]!, fETH: v[1]!, fBTC: v[2]! } };
}


export function Setup() {
  const [stored, setStored] = useState<EncryptedSeed | null | undefined>(undefined);
  const [, setVer] = useState(0);
  const bump = () => setVer((v) => v + 1);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    loadSeed()
      .then((s) => live && setStored(s))
      .catch(() => live && setStored(null));
    return () => {
      live = false;
    };
  }, [tick]);

  const owner = (stored?.evm ?? null) as Hex | null;
  const status = usePoll(() => hosted.status(), 30_000, owner ? "hosted-status" : null);
  const state = usePoll(() => hosted.owner(owner!), 6_000, owner);
  const uqor = usePoll(() => uqorBalance(qorAddress(owner!)), 6_000, owner);
  const pqc = usePoll(() => {
    clearPqcStatusCache(); // a cached "not registered" would hide the registration we just sent
    return readPqcStatus(owner!);
  }, 6_000, owner);
  const guardian = state.data?.guardian ?? null;
  const local = owner ? loadProtectState(storage, owner) : null;
  const vaultKey = owner && guardian ? `${owner}/${guardian}/${local?.vault ?? ""}/${state.data?.vault ?? ""}` : null;
  const found = usePoll(
    () =>
      locateVault(
        { owner: owner!, guardian: guardian!, stored: local?.vault ?? null, hosted: state.data?.vault },
        { txCount: (a) => publicClient.getTransactionCount({ address: a }), roles: readVaultRoles },
      ),
    10_000,
    vaultKey,
  );
  const vault = found.data?.address ?? null;
  // Remember a vault found on chain, so the next visit reads it first.
  useEffect(() => {
    if (owner && vault && !same(loadProtectState(storage, owner).vault ?? "", vault)) saveProtectState(storage, owner, { ...loadProtectState(storage, owner), vault });
  }, [owner, vault]);
  const chainKey = owner && vault ? `${owner}/${vault}` : null;
  const allowances = usePoll(() => readAllowances(owner!, vault!), 6_000, chainKey);
  const auths = usePoll(() => readAuthenticators(owner!), 8_000, chainKey);
  const rules = usePoll(() => readSpendingRules(owner!), 8_000, chainKey);
  const balances = usePoll(() => readBalances(owner!, vault!), 8_000, chainKey);
  const nowUnix = Math.floor(Date.now() / 1000);

  const pos = nextOnboardStep({
    hasSeed: !!stored,
    codeConfirmed: !!owner && loadCodeConfirmed(storage, owner),
    uqor: uqor.data,
    pqc: pqc.data,
    state: state.data,
    // Not looked for until a guardian is known; undefined while looking (never "no vault": that would offer a deploy).
    vault: !guardian ? null : found.data === undefined ? undefined : (found.data?.roles ?? null),
    allowances: allowances.data,
    linked: auths.data ? hasLiveAuthenticator(auths.data, nowUnix) : undefined,
    ruleExact: rules.data && vault ? ruleIsExact(rules.data, vault) : undefined,
    holdings: balances.data ? { fUSD: balances.data.owned.fUSD + balances.data.inVault.fUSD, fETH: balances.data.owned.fETH + balances.data.inVault.fETH, fBTC: balances.data.owned.fBTC + balances.data.inVault.fBTC } : undefined,
  });
  const current: OnboardStep | "finished" = (ORDER as string[]).includes(pos.step) ? (pos.step as OnboardStep) : "finished";
  const currentIdx = current === "finished" ? ORDER.length : ORDER.indexOf(current);
  const [selected, setSelected] = useState<OnboardStep | "finished" | null>(null);
  const view = selected ?? current;

  const refreshAll = () => {
    state.refresh();
    uqor.refresh();
    pqc.refresh();
    found.refresh();
    allowances.refresh();
    auths.refresh();
    rules.refresh();
    balances.refresh();
  };

  // ---------- actions ----------
  const [run, setRun] = useState<Run>(IDLE);
  useEffect(() => setRun((r) => runOnStepChange(r, IDLE)), [view]);
  const busy = run.state === "busy";

  // step 1 (again, when a wallet's unconfirmed code was lost and nothing was handed to it yet)
  const [restarting, setRestarting] = useState(false);
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const pwProblem = pw.length < MIN_PASSWORD ? `at least ${MIN_PASSWORD} characters` : pw !== pw2 ? "the two passwords differ" : null;
  async function createWallet(e: FormEvent) {
    e.preventDefault();
    if (pwProblem) return;
    await track(setRun, async (step) => {
      step("Creating your wallet (this takes a few seconds)…");
      // Replace only on an explicit start-over, re-checked against fresh reads (nothing funded, no key registered).
      if (restarting) {
        if (!owner) throw new Error("no wallet to replace");
        clearPqcStatusCache();
        const [st, key] = await Promise.all([hosted.owner(owner), readPqcStatus(owner)]);
        if (!canStartOver(st, key)) throw new Error("this wallet already received a starter pack or registered a key: it can't be replaced");
      }
      const { evm, code } = await appSession.create(pw, { replace: restarting });
      // Overview, Incidents and Recover now read this owner's hosted Guardian.
      setAgentBase(hostedAgentUrl(evm), evm);
      setRestarting(false);
      freshCode = code;
      setPw("");
      setPw2("");
      setSelected(null);
      setTick((t) => t + 1);
      return "Wallet created.";
    });
  }

  // step 2
  // `freshCode` lives outside React: it is read at render, and the picks are drawn again only when it changes.
  const code = freshCode;
  const picks = useMemo(() => (code ? confirmPicks(code, 2) : []), [code]);
  const [typed, setTyped] = useState<string[]>(["", ""]);
  function confirmCode(e: FormEvent) {
    e.preventDefault();
    if (!freshCode || !owner) return;
    if (!checkConfirm(freshCode, picks, typed)) {
      setRun({ state: "error", message: "Those groups do not match your code. Look at what you wrote down and try again.", hashes: [] });
      return;
    }
    try {
      appSession.providePqc(freshCode, { registered: false });
    } catch (x) {
      setRun({ state: "error", message: errorText(x), hashes: [] });
      return;
    }
    saveCodeConfirmed(storage, owner);
    freshCode = null;
    setTyped(["", ""]);
    setRun(IDLE);
    setSelected(null);
    bump();
  }

  // step 3
  const gate = landingStart(status.data, status.data ? null : status.error);
  async function takeStarter() {
    if (!owner) return;
    await track(setRun, async (step, hashes) => {
      step("Asking the service for your starter pack…");
      try {
        const r = await hosted.starter(owner);
        hashes.push(r.tx);
        return "Starter pack sent. Your balance updates in a few seconds.";
      } catch (e) {
        if (e instanceof HostedError && e.code === "owner-used") return "This account already has its starter pack.";
        throw e;
      } finally {
        state.refresh();
        uqor.refresh();
      }
    });
  }

  // step 4
  async function register() {
    const acc = appSession.account();
    if (!acc || !owner || !same(acc.evm, owner) || pqc.data?.registered !== false) return;
    await track(setRun, async (step, hashes) => {
      step("Checking your key on chain…");
      clearPqcStatusCache();
      // Fresh, not the polled value: a register that timed out may have landed already.
      if ((await readPqcStatus(owner)).registered) {
        pqc.refresh();
        return "Your key is already registered.";
      }
      step("Registering your ML-DSA-87 key (signed classically: the account has no post-quantum key yet)…");
      const r = await broadcastTx(acc, [buildRegisterMsg(acc, NETWORK.chainId)], "qlifeboat: register ML-DSA-87 key", { signMode: "classical" });
      hashes.push(r.transactionHash);
      pqc.refresh();
      return "Key registered. Checking it on chain…";
    });
  }

  // step 5
  async function getGuardian() {
    if (!appSession.account()) return;
    await track(setRun, async (step) => {
      step("The service is creating and funding your Guardian (up to a minute)…");
      const r = await hosted.onboard(hosted.signed("onboard", {}));
      state.refresh();
      return `Your Guardian is ${r.guardian}.`;
    });
  }

  // step 6
  async function createVault() {
    const acc = appSession.account();
    const g = guardian;
    // Only when the poll says there is no vault for this owner and guardian; runVaultStep reads the chain again first.
    if (!acc || !owner || !g || !same(acc.evm, owner) || found.data !== null) return;
    await track(setRun, async (step, hashes) => {
      step("Checking the chain for an existing vault…");
      const fees = await readFees();
      // The window's wallet, handed over when the window is live.
      let w: OwnerWallet | null = null;
      const wallet = () => {
        if (!w) throw new Error("no owner window is open");
        return w;
      };
      try {
        const out = await runVaultStep({
          locate: async () =>
            (
              await locateVault(
                { owner, guardian: g, stored: loadProtectState(storage, owner).vault ?? null, hosted: state.data?.vault },
                { txCount: (a) => publicClient.getTransactionCount({ address: a }), roles: readVaultRoles },
              )
            )?.address ?? null,
          withWindow: (txs, run) => {
            step(`Opening a ${txs}-tx window for the deploy and the mints…`);
            return ownerTx.withOwnerWindow(acc, { txs, scope: "unscoped" }, (wl) => {
              w = wl;
              return run();
            });
          },
          deploy: () => {
            const art = getVaultArtifact();
            return wallet().deployContract({ abi: art.abi, bytecode: art.bytecode, args: [owner, g], gas: DEPLOY_GAS, ...fees });
          },
          deployed: async (tx) => {
            const rc = await publicClient.waitForTransactionReceipt({ hash: tx });
            if (rc.status !== "success" || !rc.contractAddress) throw new Error(`the vault deploy ${tx} reverted on chain`);
            return rc.contractAddress;
          },
          save: (v) => saveProtectState(storage, owner, { ...loadProtectState(storage, owner), vault: v }),
          checkRoles: async (v) => {
            const roles = await readVaultRoles(v);
            if (!roles || !same(roles.owner, owner) || !same(roles.guardian, g)) throw new Error(`the contract at ${v} does not name this owner and Guardian`);
          },
          mint: async (sym) => {
            const h = await wallet().writeContract({ address: DIANA_TOKENS[sym], abi: mintAbi, functionName: "mint", args: [owner, MINT_AMOUNT], gas: MINT_GAS, ...fees });
            hashes.push(h);
            const r = await publicClient.waitForTransactionReceipt({ hash: h });
            if (r.status !== "success") throw new Error(`the ${sym} mint ${h} reverted on chain`);
            return h;
          },
          progress: (m, tx) => {
            if (tx && !hashes.includes(tx)) hashes.push(tx);
            step(m);
          },
        });
        hashes.unshift(out.windowTx);
        return "Vault created and 100 fUSD, fETH and fBTC minted.";
      } finally {
        found.refresh();
        balances.refresh();
      }
    });
  }

  // step 7
  async function turnOn() {
    const acc = appSession.account();
    const v = vault;
    if (!acc || !owner || !v || !same(acc.evm, owner)) return;
    await track(setRun, async (step, hashes) => {
      step("Getting your Guardian's link proof…");
      const { guardian: g, linkProof } = await hosted.onboard(hosted.signed("onboard", {}));
      const roles = await readVaultRoles(v);
      if (!roles || !same(roles.guardian, g)) throw new Error(`the vault's guardian is not your Guardian ${g}`);
      const [list, rs, allow, bal] = await Promise.all([readAuthenticators(owner), readSpendingRules(owner), readAllowances(owner, v), readBalances(owner, v)]);
      const want = norm(bytesToHex(linkProof.pubkey));
      const keyLive = list.some((a) => !a.revoked && norm(a.pubkeyHex) === want && a.expiryUnix > BigInt(Math.floor(Date.now() / 1000) + 60));
      const linkMsgs = keyLive && ruleIsExact(rs, v) ? [] : buildGuardianLinkMsgsFromProof(acc, v, linkProof, list);
      // Mints a cut-short vault step missed, then the open approvals: one window of exactly those txs, scoped to them.
      const plan = protectWindowPlan(allow, bal.owned, DIANA_TOKENS, bal.inVault);
      if (plan.txs) {
        step(`Opening a ${plan.txs}-tx window${linkMsgs.length ? " and linking your Guardian in the same tx" : ""}…`);
        const fees = await readFees();
        const out = await ownerTx.withOwnerWindow(acc, { txs: plan.txs, scope: plan.scope, extraMsgs: linkMsgs }, async (w) => {
          const sent: Hex[] = [];
          const send = async (label: string, h: Hex) => {
            sent.push(h);
            hashes.push(h);
            const r = await publicClient.waitForTransactionReceipt({ hash: h });
            if (r.status !== "success") throw new Error(`${label} ${h} reverted on chain`);
          };
          for (const sym of plan.mint) {
            step(`Minting ${sym}…`);
            await send(`mint ${sym}`, await w.writeContract({ address: DIANA_TOKENS[sym], abi: mintAbi, functionName: "mint", args: [owner, MINT_AMOUNT], gas: MINT_GAS, ...fees }));
          }
          for (const sym of plan.approve) {
            step(`Approving ${sym} for the vault…`);
            await send(`approve ${sym}`, await w.writeContract({ address: DIANA_TOKENS[sym], abi: erc20Abi, functionName: "approve", args: [v, maxUint256], gas: APPROVE_GAS, ...fees }));
          }
          return sent;
        });
        hashes.unshift(out.windowTx);
      } else if (linkMsgs.length) {
        step("Linking your Guardian…");
        hashes.push(await ownerTx.sendHybrid(acc, linkMsgs, "qlifeboat: link guardian"));
      }
      step("Activating your Guardian…");
      await hosted.activate(hosted.signed("activate", { vault: v }));
      refreshAll();
      return "Protection is on: your Guardian is watching this account.";
    });
  }

  // ---------- setup in three phases ----------
  const keys = useKeys();
  const phase = current === "finished" ? "done" : phaseOf(current);
  const [auto, setAuto] = useState(false);
  const lastAuto = useRef<OnboardStep | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const flash = (t: string) => {
    setToast(t);
    setTimeout(() => setToast(null), 2000);
  };

  // Phase 3 runs register → Guardian → vault → protect on its own, one step at a time, each only once its inputs are read.
  const stepReady =
    current === "register" ? pqc.data?.registered === false : current === "guardian" ? true : current === "vault" ? found.data === null : current === "protect" ? !!vault && !pos.detail.startsWith("reading") : false;
  useEffect(() => {
    if (!auto || busy || run.state === "error" || !stepReady) return;
    if (!appSession.account()) {
      setAuto(false);
      return;
    }
    if (lastAuto.current === current) return;
    lastAuto.current = current as OnboardStep;
    const f = current === "register" ? register : current === "guardian" ? getGuardian : current === "vault" ? createVault : turnOn;
    void f();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, busy, run.state, current, stepReady]);
  useEffect(() => {
    if (run.state === "error") setAuto(false);
  }, [run.state]);

  async function turnOnAll() {
    if (!(await keys.requireKeys("pqc"))) return;
    lastAuto.current = null;
    setRun(IDLE);
    setAuto(true);
  }

  async function confirmSavedLater() {
    // After a reload the code is gone from memory: typing it once proves it was saved, and unlocks the signing key.
    if (!owner || !(await keys.requireKeys("pqc"))) return;
    saveCodeConfirmed(storage, owner);
    bump();
  }

  function copyCode() {
    if (!freshCode) return;
    void navigator.clipboard?.writeText(formatRecoveryCode(freshCode)).then(
      () => flash("Recovery code copied"),
      () => flash("Copy was blocked: download the file instead"),
    );
  }

  function downloadCode() {
    if (!freshCode || !owner) return;
    const url = URL.createObjectURL(new Blob([recoveryFile(freshCode, owner)], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "q-lifeboat-recovery-code.txt";
    a.click();
    URL.revokeObjectURL(url);
    flash("Downloaded q-lifeboat-recovery-code.txt");
  }

  if (stored === undefined) return <p className="muted">Checking this browser for a wallet…</p>;

  const PHASES = ["Wallet & recovery code", "Starter QOR", "Turn on protection"];
  const phaseNum = phase === "done" ? 4 : phase;
  const bar = (
    <ol className="setup-phases" aria-label="Setup progress">
      {PHASES.map((p, i) => (
        <li key={p} className={i + 1 < phaseNum ? "done" : i + 1 === phaseNum ? "on" : ""} aria-current={i + 1 === phaseNum ? "step" : undefined}>
          <i />
          <span>
            {i + 1 < phaseNum ? "✓ " : ""}
            {p}
          </span>
        </li>
      ))}
    </ol>
  );
  const startOver =
    stored && !restarting && phase !== 3 && phase !== "done" && canStartOver(state.data, pqc.data) ? (
      <button type="button" className="linklike setup-startover" onClick={() => setRestarting(true)}>
        Start over with a new wallet
      </button>
    ) : null;

  let card: JSX.Element;
  if (!stored || restarting) {
    card = (
      <section className="card setup-card">
        <h2>Create your wallet</h2>
        {restarting ? (
          <div className="banner warn" role="note">
            This replaces the wallet {stored ? shortAddr(stored.evm) : ""} in this browser. Nothing was sent to it, so nothing is lost.
          </div>
        ) : null}
        <p className="setup-hint">A new key is made in this browser and stored encrypted under your password. There is no password reset, so use a password manager.</p>
        <form className="setup-form" onSubmit={(e) => void createWallet(e)}>
          <label className="setup-field">
            Password ({MIN_PASSWORD}+ characters)
            <input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </label>
          <label className="setup-field">
            Password again
            <input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          </label>
          {pw && pwProblem ? <p className="setup-hint">Password: {pwProblem}</p> : null}
          <div className="actions">
            <button type="submit" className="btn primary" disabled={busy || !!pwProblem}>
              Create wallet
            </button>
            {restarting ? (
              <button type="button" className="btn" onClick={() => setRestarting(false)}>
                Keep my wallet
              </button>
            ) : null}
          </div>
          <RunView run={run} />
        </form>
      </section>
    );
  } else if (current === "code") {
    card = freshCode ? (
      <section className="card setup-card">
        <h2>Save your recovery code</h2>
        <p className="setup-hint">
          This code is the only way to take tokens out of your vault. Save it somewhere only you can reach: a password manager, a file, or paper. Nobody
          can recover it for you.
        </p>
        <ol className="code-grid" aria-label="Recovery code, 14 groups">
          {(normalizeRecoveryCode(freshCode).match(/.{1,4}/g) ?? []).map((g, i) => (
            <li key={i}>
              <small>{i + 1}</small>
              <span className="mono">{g}</span>
            </li>
          ))}
        </ol>
        <div className="actions">
          <button type="button" className="btn" onClick={copyCode}>
            Copy code
          </button>
          <button type="button" className="btn" onClick={downloadCode}>
            Download .txt
          </button>
        </div>
        <form className="setup-confirm" onSubmit={confirmCode}>
          <b>Check you saved it</b>
          <p className="setup-hint">Type group {picks[0]} and group {picks[1]} from your saved copy (pasting works).</p>
          <div className="setup-groups">
            {picks.map((p, i) => (
              <label key={p} className="setup-field">
                Group {p}
                <input
                  className="input mono"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={4}
                  value={typed[i] ?? ""}
                  onChange={(e) => setTyped(typed.map((t, j) => (j === i ? e.target.value : t)))}
                />
              </label>
            ))}
          </div>
          <div className="actions">
            <button type="submit" className="btn primary" disabled={typed.some((t) => !t.trim())}>
              Continue
            </button>
          </div>
          <RunView run={run} />
        </form>
      </section>
    ) : (
      <section className="card setup-card">
        <h2>Confirm your recovery code</h2>
        <p className="setup-hint">This tab was closed before you confirmed your recovery code. Enter it once from your saved copy to continue.</p>
        <div className="actions">
          <button type="button" className="btn primary" onClick={() => void confirmSavedLater()}>
            Enter my recovery code
          </button>
        </div>
      </section>
    );
  } else if (phase === 2) {
    card = (
      <section className="card setup-card">
        <h2>Get starter QOR</h2>
        <p className="setup-hint">QOR pays the network fees for setting up your Guardian and vault. The service sends 2.5 test QOR, once per account.</p>
        <dl className="kv">
          <div>
            <dt>Your account</dt>
            <dd className="mono wrap-any">{owner}</dd>
          </div>
          <div>
            <dt>Balance</dt>
            <dd className="mono">{uqor.data === undefined ? "…" : fmtUqor(uqor.data)} QOR</dd>
          </div>
        </dl>
        {gate.reason ? <p className="err" role="status">{gate.reason}</p> : null}
        <div className="actions">
          <button type="button" className="btn primary" disabled={busy || !gate.enabled} onClick={() => void takeStarter()}>
            Get my 2.5 QOR
          </button>
        </div>
        <RunView run={run} />
      </section>
    );
  } else if (phase === 3) {
    const SUB: [OnboardStep, string][] = [
      ["register", "Register your post-quantum key"],
      ["guardian", "Create your Guardian"],
      ["vault", "Create your vault and mint 100 test fUSD, fETH and fBTC"],
      ["protect", "Approve the vault and link your Guardian"],
    ];
    card = (
      <section className="card setup-card">
        <h2>Turn on protection</h2>
        <p className="setup-hint">One click runs the four setup steps. Each turns ✓ only when the chain confirms it, so you can close the tab and come back.</p>
        <ol className="setup-checklist">
          {SUB.map(([id, label]) => {
            const idx = ORDER.indexOf(id);
            const st = idx < currentIdx ? "ok" : id === current && busy ? "run" : id === current && run.state === "error" ? "bad" : "";
            return (
              <li key={id} className={st}>
                <span className="ic" aria-hidden="true">
                  {st === "ok" ? "✓" : st === "bad" ? "!" : ""}
                </span>
                <div>
                  <span>{label}</span>
                  {id === current && run.state !== "idle" ? <RunView run={run} /> : null}
                </div>
              </li>
            );
          })}
        </ol>
        <div className="actions">
          {run.state === "error" ? (
            <button type="button" className="btn primary" onClick={() => void turnOnAll()}>
              Retry
            </button>
          ) : (
            <button type="button" className="btn primary" disabled={auto || busy} onClick={() => void turnOnAll()}>
              {auto || busy ? "Working…" : "Turn on protection"}
            </button>
          )}
        </div>
      </section>
    );
  } else {
    card = (
      <section className="card setup-card setup-done">
        <h2>You're protected</h2>
        <p className="setup-hint">Your Guardian is watching {owner ? shortAddr(owner) : "your account"}. Next, test it: attack yourself from your dashboard.</p>
        <div className="actions">
          <a className="btn primary" href="#/dashboard">
            Open my dashboard
          </a>
        </div>
      </section>
    );
  }

  return (
    <>
      {bar}
      {card}
      {startOver}
      {toast ? (
        <div className="setup-toast" role="status">
          {toast}
        </div>
      ) : null}
    </>
  );
}
