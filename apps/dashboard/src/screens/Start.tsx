import { APPROVE_GAS, buildGuardianLinkMsgsFromProof, buildRegisterMsg, DEPLOY_GAS, MINT_AMOUNT, MINT_GAS, NETWORK, ruleIsExact, type TokenSymbol } from "@qday/core";
import { broadcastTx, uqorBalance } from "@qday/core/chain";
import { clearPqcStatusCache, normalizeRecoveryCode, type PqcStatus } from "@qorechain/sdk";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { bytesToHex, erc20Abi, maxUint256, parseAbi, type Hex } from "viem";
import { TxHash } from "../components/ui";
import { appSession, DIANA_TOKENS, hosted, ownerTx, readVaultRoles } from "../lib/appWallet";
import { publicClient, qorAddress, readAuthenticators, readFees, readPqcStatus, readSpendingRules } from "../lib/chain";
import { errorText, fmtUqor, shortAddr } from "../lib/format";
import { usePoll } from "../lib/hooks";
import { HostedError } from "../lib/hosted";
import { loadSeed, type EncryptedSeed } from "../lib/keystore";
import { canStartOver, landingStart, loadCodeConfirmed, locateVault, nextOnboardStep, protectWindowPlan, saveCodeConfirmed, type JourneyStep } from "../lib/onboard";
import { hasLiveAuthenticator, loadProtectState, saveProtectState } from "../lib/protect";
import { checkConfirm, confirmPicks } from "../lib/session";
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
const TITLES: Record<OnboardStep, string> = {
  account: "Create your wallet",
  code: "Save your recovery code",
  starter: "Get starter QOR",
  register: "Register your post-quantum key",
  guardian: "Get your Guardian",
  vault: "Create your vault",
  protect: "Turn on protection",
};

/** The recovery code just created: memory only, shown once, dropped as soon as it is confirmed. Never stored. */
let freshCode: string | null = null;

/** One action: idle, busy with its current step, or finished with the tx hashes it sent. */
type Run =
  | { state: "idle" }
  | { state: "busy"; step: string; hashes: string[] }
  | { state: "done"; message: string; hashes: string[] }
  | { state: "error"; message: string; hashes: string[] };
const IDLE: Run = { state: "idle" };

function RunView({ run }: { run: Run }) {
  if (run.state === "idle") return null;
  return (
    <div style={{ marginTop: 10 }}>
      {run.state === "error" ? <div className="err">{run.message}</div> : null}
      {run.state === "done" ? <div className="ok-note">{run.message}</div> : null}
      {run.state === "busy" ? (
        <div style={{ fontSize: 13, color: "var(--muted)" }} role="status">
          {run.step}
        </div>
      ) : null}
      {run.hashes.map((h) => (
        <div key={h} style={{ fontSize: 12, color: "var(--harbour-2)", marginTop: 4 }}>
          tx <TxHash hash={h} full />
        </div>
      ))}
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p style={{ margin: "6px 0 12px", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>{children}</p>;
}

/** Run `f`, tracking progress in `set`; `f` reports steps and hashes through `busy`. */
async function track(set: (r: Run) => void, f: (busy: (step: string) => void, hashes: string[]) => Promise<string>) {
  const hashes: string[] = [];
  const busy = (step: string) => set({ state: "busy", step, hashes: [...hashes] });
  try {
    busy("Starting…");
    const message = await f(busy, hashes);
    set({ state: "done", message, hashes: [...hashes] });
  } catch (e) {
    set({ state: "error", message: errorText(e), hashes: [...hashes] });
  }
}

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

/** Password form: unlock the wallet stored in this browser. */
function UnlockForm({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState("");
  const [run, setRun] = useState<Run>(IDLE);
  async function submit(e: FormEvent) {
    e.preventDefault();
    await track(setRun, async (busy) => {
      busy("Unlocking…");
      await appSession.unlock(pw);
      setPw("");
      onDone();
      return "Unlocked.";
    });
  }
  return (
    <form className="form" onSubmit={(e) => void submit(e)} style={{ marginTop: 12 }}>
      <Hint>Your wallet is locked. Enter the password you chose when you created it.</Hint>
      <label>
        Password
        <input className="input" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
      </label>
      <div className="actions">
        <button type="submit" className="btn primary" disabled={!pw || run.state === "busy"}>
          Unlock
        </button>
      </div>
      <RunView run={run} />
    </form>
  );
}

/** Recovery code form: derive the post-quantum key for this session, checked against the key on chain. */
function CodeEntry({ pqc, onDone, why, extra }: { pqc: PqcStatus | undefined; onDone: () => void; why: string; extra?: ReactNode }) {
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (!pqc) return;
    try {
      // Refuses a mistyped code, or one whose key differs from the one registered on chain, before anything is signed.
      appSession.providePqc(code, pqc);
      setCode("");
      setErr(null);
      onDone();
    } catch (x) {
      setErr(errorText(x));
    }
  }
  return (
    <form className="form" onSubmit={submit} style={{ marginTop: 12 }}>
      <Hint>{why}</Hint>
      <label>
        Recovery code
        <input className="input mono" autoComplete="off" spellCheck={false} placeholder="QRC1-…" value={code} onChange={(e) => setCode(e.target.value)} />
      </label>
      <div className="actions">
        <button type="submit" className="btn primary" disabled={!code.trim() || !pqc}>
          {pqc ? "Use this code" : "Reading your key on chain…"}
        </button>
      </div>
      {err ? <div className="err">{err}</div> : null}
      {extra}
    </form>
  );
}

/** Signing steps need the unlocked wallet AND the post-quantum key from the recovery code. */
function NeedKeys({ pqc, onChange, children }: { pqc: PqcStatus | undefined; onChange: () => void; children: ReactNode }) {
  if (!appSession.classical()) return <UnlockForm onDone={onChange} />;
  if (!appSession.account()) {
    return <CodeEntry pqc={pqc} onDone={onChange} why="This step is signed with your post-quantum key. Type your recovery code: it stays in this tab's memory and is never stored." />;
  }
  return <>{children}</>;
}

function CodeGroups({ code }: { code: string }) {
  const groups = normalizeRecoveryCode(code).match(/.{1,4}/g) ?? [];
  return (
    <ol className="code-groups" aria-label="Recovery code groups">
      <li className="prefix">QRC1</li>
      {groups.map((g, i) => (
        <li key={i}>
          <span className="n">{i + 1}</span>
          <span className="mono">{g}</span>
        </li>
      ))}
    </ol>
  );
}

function Landing({ onStart }: { onStart: () => void }) {
  const status = usePoll(() => hosted.status(), 30_000, "hosted-status");
  const gate = landingStart(status.data, status.data ? null : status.error);
  return (
    <section className="card roomy hero">
      <span className="lbl">diana testnet</span>
      <h1>Keep your tokens when your wallet key leaks</h1>
      <p className="lead" style={{ margin: 0 }}>
        Create a wallet in this browser, get free testnet QOR, and a Guardian moves your tokens into a vault the moment someone else spends from your
        account. Only your post-quantum key can take them out again. No extension, no terminal.
      </p>
      <div className="actions">
        <button type="button" className="btn primary" disabled={!gate.enabled} onClick={onStart}>
          Get started
        </button>
      </div>
      {gate.reason ? (
        <p role="status" style={{ margin: "10px 0 0", fontSize: 14, color: gate.enabled ? "var(--muted)" : "var(--danger)" }}>
          {gate.reason}
        </p>
      ) : null}
    </section>
  );
}

const MARK: Record<string, string> = { done: "✓", blocked: "!" };

export function Start() {
  const [stored, setStored] = useState<EncryptedSeed | null | undefined>(undefined);
  const [started, setStarted] = useState(false);
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
  useEffect(() => setRun(IDLE), [view]);
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
      const { code } = await appSession.create(pw, { replace: restarting });
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
  const picks = useMemo(() => (code ? confirmPicks(code) : []), [code]);
  const [typed, setTyped] = useState<string[]>(["", "", ""]);
  const [wrote, setWrote] = useState(false);
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
    setTyped(["", "", ""]);
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

  // ---------- cards ----------
  const locked = !appSession.classical();
  const action = (label: string, f: () => Promise<void>, blockers: string[] = []) => (
    <>
      <div className="actions">
        <button type="button" className="btn primary" disabled={busy || blockers.length > 0} onClick={() => void f()}>
          {label}
        </button>
      </div>
      {blockers.length && !busy ? <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 8 }}>{blockers.join("; ")}</div> : null}
      <RunView run={run} />
    </>
  );
  const notYet = (id: OnboardStep) => ORDER.indexOf(id) > currentIdx;

  const cards: Record<OnboardStep, () => ReactNode> = {
    account: () =>
      stored && !restarting ? (
        <p className="ok-note">A wallet for {shortAddr(stored.evm)} is stored (encrypted) in this browser.</p>
      ) : (
        <form className="form" onSubmit={(e) => void createWallet(e)}>
          {restarting ? (
            <div className="banner warn" role="note" style={{ marginBottom: 12 }}>
              This replaces the wallet {stored ? shortAddr(stored.evm) : ""} in this browser. Nothing was sent to it, so nothing is lost.
            </div>
          ) : null}
          <Hint>
            A new key is made in this browser and stored encrypted under your password. Nobody else holds it, and there is no password reset: keep the
            password safe.
          </Hint>
          <label>
            Password ({MIN_PASSWORD}+ characters)
            <input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </label>
          <label style={{ marginTop: 10 }}>
            Password again
            <input className="input" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          </label>
          <div className="actions">
            <button type="submit" className="btn primary" disabled={busy || !!pwProblem}>
              Create wallet
            </button>
          </div>
          {pw && pwProblem ? <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 8 }}>Password: {pwProblem}</div> : null}
          <RunView run={run} />
        </form>
      ),
    code: () => {
      if (notYet("code")) return <p className="muted">Create your wallet first.</p>;
      if (current !== "code" && !freshCode) return <p className="ok-note">Recovery code confirmed.</p>;
      if (locked) return <UnlockForm onDone={bump} />;
      if (!freshCode) {
        return (
          <CodeEntry
            pqc={pqc.data}
            onDone={() => {
              if (owner) saveCodeConfirmed(storage, owner);
              bump();
            }}
            why="Your code was shown once, when the wallet was made. Type it here to confirm you have it: it stays in this tab's memory and is never stored."
            extra={
              canStartOver(state.data, pqc.data) ? (
                <div style={{ marginTop: 12, fontSize: 13, color: "var(--muted)" }}>
                  Lost the code before confirming it? Nothing was sent to this wallet yet, so you can{" "}
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => {
                      setRestarting(true);
                      setSelected("account");
                    }}
                  >
                    start over with a new wallet
                  </button>
                </div>
              ) : null
            }
          />
        );
      }
      return (
        <form className="form" onSubmit={confirmCode}>
          <div className="banner warn" role="note" style={{ marginBottom: 12 }}>
            <strong>Write this code on paper now.</strong> It is the only way to take your tokens out of the vault. It is shown once, never stored, and
            nobody can recover it for you.
          </div>
          <CodeGroups code={freshCode} />
          <label style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 14, color: "var(--harbour)" }}>
            <input type="checkbox" checked={wrote} onChange={(e) => setWrote(e.target.checked)} /> I wrote it down
          </label>
          {wrote ? (
            <>
              <Hint>Type these groups from your paper copy to confirm:</Hint>
              <div className="fields">
                {picks.map((p, i) => (
                  <label key={p}>
                    Group {p}
                    <input
                      className="input mono"
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={6}
                      value={typed[i] ?? ""}
                      onChange={(e) => setTyped(typed.map((t, j) => (j === i ? e.target.value : t)))}
                    />
                  </label>
                ))}
              </div>
              <div className="actions">
                <button type="submit" className="btn primary" disabled={typed.some((t) => !t.trim())}>
                  Confirm
                </button>
              </div>
            </>
          ) : null}
          <RunView run={run} />
        </form>
      );
    },
    starter: () => {
      const taken = !!state.data && state.data.stage !== "none";
      return (
        <>
          <Hint>The service sends this account 2.5 testnet QOR for its fees. One pack per account.</Hint>
          <dl className="kv" style={{ marginTop: 0 }}>
            <div>
              <dt>Your account</dt>
              <dd className="mono wrap-any">{owner ?? "—"}</dd>
            </div>
            <div>
              <dt>Balance</dt>
              <dd className="mono">{uqor.data === undefined ? "reading…" : `${fmtUqor(uqor.data)} QOR`}</dd>
            </div>
          </dl>
          {taken
            ? current === "starter"
              ? <p style={{ fontSize: 14 }}>{pos.detail}</p>
              : <p className="ok-note">Starter pack received.</p>
            : action("Get my starter pack", takeStarter, [...(notYet("starter") ? ["finish the steps above first"] : []), ...(gate.enabled ? [] : [gate.reason ?? "checking the service"])])}
          {taken ? <RunView run={run} /> : null}
        </>
      );
    },
    register: () => (
      <>
        <Hint>
          Your post-quantum key comes from your recovery code. Registering it on chain is what lets your vault release funds only to a signature made
          with it.
        </Hint>
        {pqc.data?.registered ? (
          <p className={pqc.data.possessionProven === true ? "ok-note" : "err"}>
            {pqc.data.possessionProven === true ? "ML-DSA-87 key registered, possession proven." : pos.detail}
          </p>
        ) : notYet("register") ? (
          <p className="muted">Finish the steps above first.</p>
        ) : (
          <NeedKeys pqc={pqc.data} onChange={bump}>
            {action("Register my key", register, pqc.data ? [] : ["reading your key on chain"])}
          </NeedKeys>
        )}
      </>
    ),
    guardian: () => (
      <>
        <Hint>The service creates a Guardian account for you: it watches your account and is the only other address that can move tokens into your vault.</Hint>
        {guardian ? (
          <dl className="kv" style={{ marginTop: 0 }}>
            <div>
              <dt>Your Guardian</dt>
              <dd className="mono wrap-any">{guardian}</dd>
            </div>
          </dl>
        ) : notYet("guardian") ? (
          <p className="muted">Finish the steps above first.</p>
        ) : (
          <NeedKeys pqc={pqc.data} onChange={bump}>
            {action("Get my Guardian", getGuardian)}
          </NeedKeys>
        )}
      </>
    ),
    vault: () => (
      <>
        <Hint>
          One window of 4 transactions: your vault (owner: you, guardian: your Guardian, fixed forever) and 100 each of the test tokens fUSD, fETH and
          fBTC.
        </Hint>
        {vault ? (
          <dl className="kv" style={{ marginTop: 0 }}>
            <div>
              <dt>Vault</dt>
              <dd className="mono wrap-any">{vault}</dd>
            </div>
          </dl>
        ) : notYet("vault") ? (
          <p className="muted">Finish the steps above first.</p>
        ) : (
          <NeedKeys pqc={pqc.data} onChange={bump}>
            {action("Create vault and mint tokens", createVault, found.data === undefined ? [found.error ? `could not look for an existing vault: ${found.error}` : "looking for an existing vault"] : [])}
          </NeedKeys>
        )}
      </>
    ),
    protect: () => (
      <>
        <Hint>
          One window for the approvals (the vault may pull fUSD, fETH and fBTC from you, only into itself) with your Guardian's link in the same
          transaction. Its key may call <span className="mono">vault.rescue</span> and nothing else. Then the service starts your Guardian.
        </Hint>
        {current === "finished" ? (
          <p className="ok-note">Approvals, link and Guardian confirmed.</p>
        ) : notYet("protect") ? (
          <p className="muted">Finish the steps above first.</p>
        ) : (
          <NeedKeys pqc={pqc.data} onChange={bump}>
            <p style={{ fontSize: 14 }}>{pos.detail}</p>
            {action("Turn on protection", turnOn, pos.detail.startsWith("reading") ? [pos.detail] : [])}
          </NeedKeys>
        )}
      </>
    ),
  };

  if (stored === undefined) return <p className="muted">Checking this browser for a wallet…</p>;
  if (!stored && !started) return <Landing onStart={() => setStarted(true)} />;

  return (
    <>
      <div className="page-head">
        <h1>Get protected</h1>
        {stored && !locked ? (
          <button
            type="button"
            className="btn small"
            onClick={() => {
              appSession.lock();
              bump();
            }}
          >
            Lock wallet
          </button>
        ) : null}
      </div>
      <p className="lead">Seven steps, one click each. Each turns done only when the chain or the service confirms it, so you can close the tab and come back.</p>
      <div className="protect">
        <nav className="steps" aria-label="Onboarding steps">
          {ORDER.map((id, i) => {
            const st = i < currentIdx ? "done" : i === currentIdx ? "current" : "todo";
            return (
              <button key={id} type="button" className={`step-item ${st}`} aria-current={view === id ? "step" : undefined} onClick={() => setSelected(id)}>
                <span className={`stepnum ${st === "done" ? "done" : st === "current" ? "on" : ""}`}>{MARK[st] ?? i + 1}</span>
                <span style={{ minWidth: 0 }}>
                  <span className="t">{TITLES[id]}</span>
                  <span className="s">{st === "current" ? pos.detail : st === "done" ? "done" : "to do"}</span>
                </span>
              </button>
            );
          })}
          <button type="button" className={`step-item final${current === "finished" ? " done" : ""}`} aria-current={view === "finished" ? "step" : undefined} onClick={() => setSelected("finished")}>
            <span className={`stepnum ${current === "finished" ? "done" : ""}`}>{current === "finished" ? "✓" : "★"}</span>
            <span style={{ minWidth: 0 }}>
              <span className="t">{current === "finished" ? "You're protected" : "Protected"}</span>
              <span className="s">{current === "finished" ? pos.detail : "after every step is confirmed"}</span>
            </span>
          </button>
        </nav>
        <section className="card roomy" aria-live="polite">
          {view !== "finished" ? (
            <>
              <div className="between" style={{ marginBottom: 6 }}>
                <span className="lbl">
                  Step {ORDER.indexOf(view) + 1} of {ORDER.length}
                </span>
                <span className={`tag ${ORDER.indexOf(view) < currentIdx ? "safe" : ""}`}>
                  {ORDER.indexOf(view) < currentIdx ? "Done" : view === current ? "Next" : "To do"}
                </span>
              </div>
              <h2>{TITLES[view]}</h2>
              {cards[view]()}
            </>
          ) : (
            <div className="done-box">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12l5 5 9-10" />
              </svg>
              <div>
                <div style={{ fontSize: 17, fontWeight: 600 }}>{current === "finished" ? "You're protected" : "Not protected yet"}</div>
                <div style={{ fontSize: 14, color: "var(--harbour-2)", marginTop: 4, lineHeight: 1.5 }}>
                  {current === "finished"
                    ? `Vault ${vault ?? ""} holds what your Guardian ${guardian ?? ""} rescues. Your account's EVM window stays closed until the app opens a short one for you.`
                    : "Every step turns ✓ only when the chain or the service confirms it. Finish the open steps."}
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
