import { NETWORK, RESCUE_SELECTOR, vaultAbi } from "@qday/core";
import { useEffect, useState, type ReactNode } from "react";
import { erc20Abi, maxUint256, type Hex } from "viem";
import { GasTank } from "../components/GasTank";
import { EditorMessages, TrustedEditor, usePolicyEditor } from "../components/TrustedEditor";
import { CheckRow, Command as CommandBox, TxHash } from "../components/ui";
import { SwitchToDiana, useWalletConnect, WalletConnect } from "../components/WalletConnect";
import { withWindowHint } from "../lib/actions";
import { fetchHealth } from "../lib/agent";
import { publicClient, readAuthenticators, readFees, readPqcStatus, readSpendingRules, readWindow } from "../lib/chain";
import { errorText, fmtAmount, fmtUqor, shortAddr } from "../lib/format";
import { usePoll } from "../lib/hooks";
import {
  APPROVE_GAS,
  DEPLOY_GAS,
  deployOffer,
  hasLiveAuthenticator,
  loadProtectState,
  planApprove,
  planDeploy,
  protectCommands,
  protectSteps,
  ruleIsExact,
  saveProtectState,
  signWithdrawCommand,
  tokensToApprove,
  validateRecovery,
  vaultRoleProblems,
  type Command,
  type ProtectState,
  type ProtectStep,
  type StepId,
} from "../lib/protect";
import { browserStorage } from "../lib/storage";
import { getVaultArtifact } from "../lib/vaultArtifact";
import { ensureDiana, walletClientFor } from "../lib/wallet";
import { useApp } from "../state";

const storage = browserStorage();
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const EMPTY_LOCAL: ProtectState = { vault: null, recovery: null, trustedReviewed: false };

const TITLES: Record<StepId, string> = {
  connect: "Connect your wallet",
  vault: "Create your vault",
  approve: "Approve your tokens",
  guardian: "Turn on the Guardian",
  trusted: "Trusted wallets and apps",
  recovery: "Recovery address and alerts",
};
const ORDER: StepId[] = ["connect", "vault", "approve", "guardian", "trusted", "recovery"];

/** One MetaMask action: idle, busy with its current step, or finished with the tx hashes it sent. */
type Run =
  | { state: "idle" }
  | { state: "busy"; step: string; hashes: Hex[] }
  | { state: "done"; message: string; hashes: Hex[] }
  | { state: "error"; message: string; hashes: Hex[] };
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
        <div key={h} style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 4 }}>
          tx <TxHash hash={h} full />
        </div>
      ))}
    </div>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p style={{ margin: "6px 0 12px", fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>{children}</p>;
}

/** A CLI command with the environment note it needs. */
function Cmd({ c, children }: { c: Command | { command: string; note: string }; children?: ReactNode }) {
  return (
    <CommandBox cmd={c.command}>
      {children}
      <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>{c.note}</div>
    </CommandBox>
  );
}

const MARK: Record<ProtectStep["state"], string> = { done: "✓", current: "", todo: "", blocked: "!" };

export function Protect() {
  const { config } = useApp();
  const wc = useWalletConnect();
  const wallet = wc.wallet;
  const account = wallet?.account ?? null;
  const cfg = config.cfg;
  const online = config.agentOnline;

  const [tick, setTick] = useState(0);
  const local = account ? loadProtectState(storage, account) : EMPTY_LOCAL;
  void tick;
  /** Merge a change into the saved choices of `owner` (re-read first: a deploy outlives the render that started it). */
  function patchLocal(owner: string, patch: Partial<ProtectState>) {
    saveProtectState(storage, owner, { ...loadProtectState(storage, owner), ...patch });
    setTick((t) => t + 1);
  }

  const served = !!cfg && !!account && same(cfg.owner, account);
  const vault = local.vault ?? (served ? cfg.vault : null);
  const guardian = cfg?.guardian ?? null;

  // Chain reads of the connected wallet; every key changes with the wallet and the vault.
  const pqc = usePoll(() => readPqcStatus(account!), 15_000, account);
  const qor = usePoll(() => publicClient.getBalance({ address: account! }), 15_000, account);
  const win = usePoll(() => readWindow(account!), 10_000, account);
  const fees = usePoll(readFees, 15_000, account ? "fees" : null);
  const authenticators = usePoll(() => readAuthenticators(account!), 15_000, account);
  const rules = usePoll(() => readSpendingRules(account!), 15_000, account);
  const roles = usePoll(
    () => readRoles(vault as Hex),
    15_000,
    vault ? `${vault}` : null,
  );
  const tokenKey = cfg && account && vault ? `${account}/${vault}/${Object.values(cfg.tokens).join()}` : null;
  const tokens = usePoll(
    async () => {
      const syms = ["fUSD", "fETH", "fBTC"] as const;
      return Promise.all(
        syms.map(async (sym) => {
          const token = cfg!.tokens[sym];
          const [balance, allowance] = await Promise.all([
            publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account!] }),
            publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [account!, vault as Hex] }),
          ]);
          return { sym, token, balance, allowance };
        }),
      );
    },
    10_000,
    tokenKey,
  );
  // Agent reads: only meaningful (and only used) when the agent is up.
  const health = usePoll(fetchHealth, 15_000, "health");
  const editor = usePolicyEditor(online && served);

  const allowances = tokens.data && { fUSD: tokens.data[0].allowance, fETH: tokens.data[1].allowance, fBTC: tokens.data[2].allowance };
  const steps = protectSteps({
    wallet: account,
    chainId: wc.chainId,
    pqc: account ? pqc.data : undefined,
    vault,
    vaultRoles: vault ? roles.data : undefined,
    allowances,
    authenticators: account ? authenticators.data : undefined,
    rules: account ? rules.data : undefined,
    config: cfg,
    configCheck: config.check ?? undefined,
    online,
    health: online ? health.data : undefined,
    policy: online && served ? editor.current : undefined,
    local,
    nowUnix: Math.floor(Date.now() / 1000),
  });
  const stateOf = (id: StepId) => steps.find((s) => s.id === id)!;
  const allDone = steps.every((s) => s.state === "done");
  const currentId = steps.find((s) => s.state === "current" || s.state === "blocked")?.id ?? null;
  const [selected, setSelected] = useState<StepId | "done" | null>(null);
  const view: StepId | "done" = selected ?? currentId ?? "done";

  // ---------- actions ----------
  const [deployRun, setDeployRun] = useState<Run>(IDLE);
  const [existingRun, setExistingRun] = useState<Run>(IDLE);
  const [approveRun, setApproveRun] = useState<Run>(IDLE);
  const [existing, setExisting] = useState("");
  // A result belongs to the wallet that sent it: a different account starts clean.
  useEffect(() => {
    setDeployRun(IDLE);
    setApproveRun(IDLE);
    setExistingRun(IDLE);
  }, [account]);
  const [recoveryText, setRecoveryText] = useState("");
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  const sender = { wallet: account, chainId: wc.chainId, window: win.data, maxFeePerGas: fees.data?.maxFeePerGas };
  const deployPlan = planDeploy(sender);
  const deployBlockers = [...(!cfg ? ["start the agent: its /config names the guardian"] : []), ...deployPlan.blockers];
  const toApprove = cfg && allowances ? tokensToApprove(allowances, cfg.tokens) : [];
  const approvePlan = planApprove({ ...sender, tokens: toApprove });

  async function deploy() {
    const f = fees.data;
    if (!wallet || !f || !cfg || deployBlockers.length) return;
    const owner = wallet.account;
    const guard = cfg.guardian; // shown above the button; the roles read back are held against exactly these
    let hash: Hex | undefined;
    let deployed: Hex | undefined;
    try {
      setDeployRun({ state: "busy", step: "Switching the wallet to diana…", hashes: [] });
      await ensureDiana(wallet.provider);
      const art = getVaultArtifact();
      setDeployRun({ state: "busy", step: `Confirm the deploy in ${wallet.name}…`, hashes: [] });
      hash = await walletClientFor(wallet.provider, owner).deployContract({
        abi: art.abi,
        bytecode: art.bytecode,
        args: [owner, guard],
        gas: DEPLOY_GAS,
        maxFeePerGas: f.maxFeePerGas,
        maxPriorityFeePerGas: f.maxPriorityFeePerGas,
      });
      setDeployRun({ state: "busy", step: "Sent, waiting for the block…", hashes: [hash] });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success" || !receipt.contractAddress) throw new Error("the deploy reverted on chain; nothing was saved");
      const address = receipt.contractAddress;
      deployed = address;
      const read = await readRoles(address);
      const bad = vaultRoleProblems(read, { owner, guardian: guard });
      if (bad.length) {
        setDeployRun({ state: "error", message: `The deployed contract ${address} is not usable, nothing was saved: ${bad.join("; ")}.`, hashes: [hash] });
        return;
      }
      patchLocal(owner, { vault: address });
      setDeployRun({ state: "done", message: `Vault created at ${address}: owner and guardian read back from the chain match.`, hashes: [hash] });
    } catch (e) {
      const message = deployed
        ? `The vault was deployed at ${deployed}, but its roles could not be read: ${errorText(e)}. Nothing was saved: paste ${deployed} into "I already have a vault" to retry.`
        : withWindowHint(errorText(e));
      setDeployRun({ state: "error", message, hashes: hash ? [hash] : [] });
    } finally {
      win.refresh();
      qor.refresh();
    }
  }

  async function useExisting() {
    if (!account || !cfg) return;
    const owner = account;
    const guard = cfg.guardian;
    const address = existing.trim();
    if (!ADDRESS_RE.test(address)) return setExistingRun({ state: "error", message: "enter a 0x address (0x + 40 hex characters)", hashes: [] });
    setExistingRun({ state: "busy", step: "Reading owner() and guardian()…", hashes: [] });
    try {
      const read = await readRoles(address as Hex);
      const bad = vaultRoleProblems(read, { owner, guardian: guard });
      if (bad.length) return setExistingRun({ state: "error", message: `Not saved: ${bad.join("; ")}. Owner and guardian are immutable.`, hashes: [] });
      patchLocal(owner, { vault: address });
      setExisting("");
      setExistingRun({ state: "done", message: `Vault ${address} saved: owner and guardian match.`, hashes: [] });
    } catch (e) {
      setExistingRun({ state: "error", message: `Could not read a GuardianVault at that address: ${errorText(e)}`, hashes: [] });
    }
  }

  async function approveAll() {
    const f = fees.data;
    if (!wallet || !f || !vault || !toApprove.length || approvePlan.blockers.length) return;
    const hashes: Hex[] = [];
    try {
      setApproveRun({ state: "busy", step: "Switching the wallet to diana…", hashes });
      await ensureDiana(wallet.provider);
      const client = walletClientFor(wallet.provider, wallet.account);
      for (const [i, t] of toApprove.entries()) {
        setApproveRun({ state: "busy", step: `Confirm approve ${t.sym} (${i + 1} of ${toApprove.length}) in ${wallet.name}…`, hashes: [...hashes] });
        const hash = await client.writeContract({
          address: t.token as Hex,
          abi: erc20Abi,
          functionName: "approve",
          args: [vault as Hex, maxUint256],
          gas: APPROVE_GAS,
          maxFeePerGas: f.maxFeePerGas,
          maxPriorityFeePerGas: f.maxPriorityFeePerGas,
        });
        hashes.push(hash);
        setApproveRun({ state: "busy", step: `Approve ${t.sym} sent, waiting for the block…`, hashes: [...hashes] });
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== "success") throw new Error(`approve ${t.sym} reverted on chain; the rest were not sent`);
      }
      setApproveRun({ state: "done", message: `Approved ${toApprove.map((t) => t.sym).join(", ")}.`, hashes });
    } catch (e) {
      setApproveRun({ state: "error", message: withWindowHint(errorText(e)), hashes });
    } finally {
      tokens.refresh();
      win.refresh();
    }
  }

  function saveRecovery() {
    if (!account || !vault || !guardian) return;
    const v = validateRecovery(recoveryText, { owner: account, vault, guardian });
    if (!v.ok) return setRecoveryError(v.error);
    setRecoveryError(null);
    patchLocal(account, { recovery: v.address });
    setRecoveryText("");
  }

  // ---------- step cards ----------
  const cmds = account ? protectCommands(account, vault ?? "<vault address>") : null;
  const windowCommand = deployPlan.command && cmds ? { command: deployPlan.command, note: cmds.window.note } : null;

  function connectCard() {
    return (
      <>
        <h2>Connect your wallet</h2>
        <Hint>The wallet you connect becomes the vault's owner. MetaMask signs the deploy and the approvals; the rest runs through the CLI.</Hint>
        {!wallet ? (
          <div className="actions" style={{ marginTop: 0 }}>
            <WalletConnect w={wc} />
          </div>
        ) : (
          <dl className="kv" style={{ marginTop: 0 }}>
            <div>
              <dt>Wallet</dt>
              <dd className="mono wrap-any">{wallet.account}</dd>
            </div>
            <div>
              <dt>Network</dt>
              <dd style={wc.chainId === NETWORK.evmChainId ? undefined : { color: "var(--orange)" }}>
                {wc.chainId === NETWORK.evmChainId ? `diana · ${NETWORK.evmChainId}` : `chain ${wc.chainId ?? "?"}`} <SwitchToDiana w={wc} />
              </dd>
            </div>
            <div>
              <dt>Post-quantum key</dt>
              <dd>
                {!pqc.data
                  ? pqc.error
                    ? `could not read: ${pqc.error}`
                    : "reading…"
                  : !pqc.data.registered
                    ? "not registered"
                    : pqc.data.possessionProven === true
                      ? "ML-DSA-87 registered, possession proven"
                      : "registered, no proof of possession"}
              </dd>
            </div>
            <div>
              <dt>QOR balance</dt>
              <dd className="mono">{qor.data === undefined ? (qor.error ? "could not read" : "…") : `${fmtAmount(qor.data, 4)} QOR`}</dd>
            </div>
          </dl>
        )}
        {wc.error ? <div className="err">{wc.error}</div> : null}
        {wallet && pqc.data && !pqc.data.registered ? (
          <CommandBox cmd="pnpm cli fresh-owner --no-vault">
            <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>
              A brand-new account needs an ML-DSA-87 key before the vault can lock funds. This creates a demo owner with one and no vault yet; import its
              mnemonic into MetaMask.
            </div>
          </CommandBox>
        ) : null}
      </>
    );
  }

  const cachedConfig = !!cfg && (!online || config.source !== "agent");
  const roleOffer = deployOffer({
    vault,
    vaultState: stateOf("vault").state,
    rolesLoaded: !!roles.data,
    rolesError: !!roles.error,
  });

  function vaultCard() {
    const st = stateOf("vault");
    return (
      <>
        <h2>Create your vault</h2>
        <Hint>
          The vault holds what the Guardian rescues. Its owner (you) and guardian (the agent's account) are fixed at deploy and can never change. Only
          your ML-DSA-87 signature can release funds from it.
        </Hint>
        <dl className="kv" style={{ marginTop: 0 }}>
          <div>
            <dt>Owner</dt>
            <dd className="mono wrap-any">{account ?? "connect your wallet"}</dd>
          </div>
          <div>
            <dt>Guardian</dt>
            <dd className="mono wrap-any">
              {guardian ?? "unknown"}
              <small>
                {cachedConfig ? "from the agent's last served config (agent offline); check it is the agent you run" : "from the agent's /config; check it is the agent you run"}
              </small>
            </dd>
          </div>
          {vault ? (
            <div>
              <dt>Vault</dt>
              <dd className="mono wrap-any">{vault}</dd>
            </div>
          ) : null}
        </dl>
        {st.state === "done" ? (
          <div className="ok-note">The vault is on chain with your wallet as owner and the agent's guardian.</div>
        ) : (
          <>
            {st.state === "blocked" || !cfg ? (
              <div className="banner warn" style={{ marginTop: 14 }}>
                {st.detail}
              </div>
            ) : null}
            <div className="actions" style={{ marginTop: 16 }}>
              {roleOffer === "checking" && deployRun.state !== "busy" ? (
                <span style={{ fontSize: 14, color: "var(--muted)" }} role="status">
                  checking vault {vault} …
                </span>
              ) : (
                <button type="button" className="btn primary" disabled={deployBlockers.length > 0 || deployRun.state === "busy"} onClick={() => void deploy()}>
                  {deployRun.state === "busy" ? deployRun.step : wallet ? `Deploy vault with ${wallet.name}` : "Deploy vault"}
                </button>
              )}
              {local.vault ? (
                <button type="button" className="btn small" disabled={deployRun.state === "busy"} onClick={() => account && patchLocal(account, { vault: null })}>
                  Forget the saved vault
                </button>
              ) : null}
            </div>
            {roleOffer === "offer" && deployBlockers.length && deployRun.state !== "busy" ? (
              <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 8 }}>To deploy: {deployBlockers.join("; ")}.</div>
            ) : null}
            {roleOffer === "offer" && windowCommand && deployRun.state !== "busy" ? (
              <Cmd c={windowCommand}>
                <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>
                  A deploy is a contract creation, which a window scoped to named addresses refuses, so this opens an unscoped one (replacing the current
                  one) with a small budget of fees only, a few blocks and a few txs. While it is open a leaked ECDSA key could use it: close it afterwards
                  with <span className="mono">pnpm cli window close --expect {account}</span>.
                </div>
              </Cmd>
            ) : null}
            <RunView run={deployRun} />
            <form
              className="form"
              style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--line-soft)" }}
              onSubmit={(e) => {
                e.preventDefault();
                void useExisting();
              }}
            >
              <label style={{ flex: "1 1 280px" }}>
                I already have a vault
                <input
                  className="input mono"
                  value={existing}
                  placeholder="0x… vault address"
                  spellCheck={false}
                  disabled={!account || !cfg}
                  onChange={(e) => setExisting(e.target.value)}
                />
              </label>
              <button type="submit" className="btn small" disabled={!account || !cfg || existingRun.state === "busy" || !existing.trim()}>
                Check and use
              </button>
            </form>
            <RunView run={existingRun} />
          </>
        )}
      </>
    );
  }

  function approveCard() {
    const st = stateOf("approve");
    return (
      <>
        <h2>Approve your tokens</h2>
        <Hint>
          One <span className="mono">approve(vault, max)</span> per token lets the vault pull that token out of your account when a rescue runs. The
          approval only works for the vault, and the vault only moves tokens to itself.
        </Hint>
        {tokens.data ? (
          <table>
            <thead>
              <tr>
                <th>Token</th>
                <th className="num">Your balance</th>
                <th className="num">Allowance to the vault</th>
              </tr>
            </thead>
            <tbody>
              {tokens.data.map((t) => (
                <tr key={t.sym}>
                  <td style={{ fontWeight: 600 }}>{t.sym}</td>
                  <td className="num mono">{fmtAmount(t.balance)}</td>
                  <td className="num mono">{t.allowance === maxUint256 ? "unlimited" : fmtAmount(t.allowance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">{st.state === "todo" || !vault ? st.detail : tokens.error ? `Could not read: ${tokens.error}` : "Reading balances and allowances…"}</div>
        )}
        {st.detail && st.state !== "done" ? <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 8 }}>{st.detail}.</div> : null}
        {stateOf("vault").state === "done" ? (
          <>
            <div className="actions" style={{ marginTop: 16 }}>
              <button type="button" className="btn primary" disabled={approvePlan.blockers.length > 0 || approveRun.state === "busy"} onClick={() => void approveAll()}>
                {approveRun.state === "busy" ? "Working…" : toApprove.length ? `Approve ${toApprove.length} token${toApprove.length === 1 ? "" : "s"}` : "Approved"}
              </button>
            </div>
            {approvePlan.blockers.length && approveRun.state !== "busy" && toApprove.length ? (
              <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 8 }}>To approve: {approvePlan.blockers.join("; ")}.</div>
            ) : null}
            {approvePlan.command && approveRun.state !== "busy" && cmds ? (
              <Cmd c={{ command: approvePlan.command, note: cmds.window.note }}>
                <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>
                  Each approval is a window tx (about {fmtUqor(approvePlan.cost)} QOR of budget in all). This opens one that fits.
                </div>
              </Cmd>
            ) : null}
            <RunView run={approveRun} />
          </>
        ) : null}
      </>
    );
  }

  function guardianCard() {
    const st = stateOf("guardian");
    const now = Math.floor(Date.now() / 1000);
    const part = (status: "pass" | "fail" | "pending", title: string, detail?: string) => <CheckRow key={title} status={status} title={title} detail={detail} />;
    const linked = authenticators.data ? hasLiveAuthenticator(authenticators.data, now) : undefined;
    const ruleOk = rules.data && vault ? ruleIsExact(rules.data, vault) : undefined;
    const matches = !!cfg && !!vault && !!account && same(cfg.vault, vault) && same(cfg.owner, account);
    const gasKnown = online && health.data;
    const gasTankShown = served && !!cfg && !!vault && same(cfg.vault, vault) && config.check?.ok === true;
    return (
      <>
        <h2>Turn on the Guardian</h2>
        <Hint>
          The agent watches your account and rescues into the vault when it sees a transfer or approval you did not plan. It signs with its own key, which
          your account allows to do exactly one thing.
        </Hint>
        <div className="lbl">The rule it gets (read only)</div>
        <dl className="kv" style={{ marginTop: 8 }}>
          <div>
            <dt>allowedEvmCalls</dt>
            <dd className="mono wrap-any">[{vault ?? "<vault>"}/rescue ({RESCUE_SELECTOR})]</dd>
          </div>
          <div>
            <dt>allowedDenoms</dt>
            <dd className="mono">[uqor]</dd>
          </div>
          <div>
            <dt>Tokens</dt>
            <dd>none: the agent can't move tokens directly</dd>
          </div>
        </dl>
        {cmds ? (
          <>
            <Cmd c={cmds.link}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>1. Link the agent key to your account</div>
            </Cmd>
            <Cmd c={cmds.agent}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>2. Start the agent</div>
            </Cmd>
          </>
        ) : null}
        <div className="lbl" style={{ marginTop: 18 }}>
          Status, read live
        </div>
        <div className="checks" style={{ marginTop: 8 }}>
          {part(linked === undefined ? "pending" : linked ? "pass" : "fail", "Agent key linked to your account", linked === false ? "none linked, revoked or about to expire" : undefined)}
          {part(ruleOk === undefined ? "pending" : ruleOk ? "pass" : "fail", "Rule is vault.rescue with uqor only", ruleOk === false ? "the first enabled rule differs" : undefined)}
          {part(!online ? "fail" : "pass", "Agent running", !online ? "start it with the command above" : undefined)}
          {part(!online ? "pending" : matches && config.check?.ok ? "pass" : "fail", "Agent serves this owner and vault", cfg && !matches ? `it serves owner ${shortAddr(cfg.owner)}, vault ${shortAddr(cfg.vault)}` : config.check && !config.check.ok ? config.check.detail : undefined)}
          {part(!gasKnown ? "pending" : health.data!.gas.low ? "fail" : "pass", "Gas tank above its alert level", health.data?.gas.low ? "top it up below" : undefined)}
        </div>
        {st.state !== "done" ? <div style={{ fontSize: 13, color: "var(--muted)", marginTop: 10 }}>{st.detail}.</div> : null}
        <div style={{ marginTop: 18 }}>
          {gasTankShown ? (
            <GasTank cfg={cfg!} health={online ? health.data : undefined} win={win} />
          ) : (
            <div className="banner warn">
              <strong>Gas tank unavailable.</strong> It needs the agent to serve this owner and vault with a matching on-chain config: run the commands above, then
              come back.
            </div>
          )}
        </div>
      </>
    );
  }

  function trustedCard() {
    const ready = !!account && !!vault && !!cfg && served && online && same(cfg.vault, vault);
    return (
      <>
        <Hint>
          The agent treats transfers and approvals to these as normal. Anything else triggers a rescue. You can change this later in Rules.
        </Hint>
        {ready ? (
          <>
            <TrustedEditor cfg={{ owner: account, vault: vault as Hex, guardian: cfg.guardian }} editor={editor} />
            <EditorMessages editor={editor} />
          </>
        ) : (
          <div className="banner warn">
            The trusted list lives in the agent. It is available once the agent runs for this owner and vault ({!online ? "it is offline" : !served ? "it serves another owner" : "no vault yet"}).
          </div>
        )}
        <div className="actions">
          <button
            type="button"
            className="btn primary small"
            onClick={() => {
              if (account) patchLocal(account, { trustedReviewed: true });
              setSelected(null);
            }}
            disabled={!account}
          >
            {editor.current?.trusted.length ? "Looks good, continue" : "Continue without"}
          </button>
          {local.trustedReviewed ? <span className="tag blue">reviewed</span> : null}
        </div>
      </>
    );
  }

  function recoveryCard() {
    const recovery = local.recovery;
    return (
      <>
        <h2>Recovery address and alerts</h2>
        <Hint>
          Where you will send funds from the vault. It is saved in this browser only and is never sent anywhere. Pick an address you control that a leaked
          key can't reach.
        </Hint>
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            saveRecovery();
          }}
        >
          <label style={{ flex: "1 1 300px" }}>
            Recovery address
            <input
              className="input mono"
              value={recoveryText}
              placeholder={recovery ?? "0x…"}
              spellCheck={false}
              disabled={!account || !vault || !guardian}
              onChange={(e) => setRecoveryText(e.target.value)}
            />
          </label>
          <button type="submit" className="btn primary small" disabled={!account || !vault || !guardian || !recoveryText.trim()}>
            Save
          </button>
        </form>
        {recoveryError ? <div className="err">{recoveryError}</div> : null}
        {recovery ? (
          <>
            <div className="ok-note">
              Saved: <span className="mono wrap-any">{recovery}</span>
            </div>
            <CommandBox cmd={signWithdrawCommand(recovery, "fUSD", "1")}>
              <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>
                When you need the funds, sign a withdrawal to that address on your own machine (here 1 fUSD; use fETH, fBTC, QOR or a token address). Then load
                the file in Recover.
              </div>
            </CommandBox>
          </>
        ) : null}
        <div className="lbl" style={{ marginTop: 18 }}>
          Alert channels (read only)
        </div>
        <dl className="kv" style={{ marginTop: 8 }}>
          <div>
            <dt>Telegram</dt>
            <dd>{!online || !health.data ? "—" : health.data.alerts.telegram ? "on" : "off"}</dd>
          </div>
          <div>
            <dt>Webhook</dt>
            <dd>{!online || !health.data ? "—" : health.data.alerts.webhook ? "on" : "off"}</dd>
          </div>
        </dl>
        <Hint>
          They are set in the agent's <span className="mono">.env</span> (<span className="mono">TELEGRAM_BOT_TOKEN</span>,{" "}
          <span className="mono">TELEGRAM_CHAT_ID</span>, the webhook URL) because they hold secrets.
        </Hint>
      </>
    );
  }

  function doneCard() {
    return (
      <>
        <div className="done-box">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#1E4FD8" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M5 12l5 5 9-10" />
          </svg>
          <div>
            <div style={{ fontSize: 17, fontWeight: 600 }}>{allDone ? "You're protected" : "Not protected yet"}</div>
            <div style={{ fontSize: 14, color: "var(--ink-2)", marginTop: 4, lineHeight: 1.5 }}>
              {allDone
                ? "Your vault, approvals and Guardian are all confirmed on chain, and the agent is running."
                : "Every step above turns ✓ only when the chain or the agent confirms it. Finish the open steps."}
            </div>
          </div>
        </div>
        <div className="actions">
          <a className="btn primary" href="#/">
            Go to Overview
          </a>
          <a className="btn" href="#/recover">
            Recover
          </a>
        </div>
      </>
    );
  }

  const cards: Record<StepId | "done", () => ReactNode> = {
    connect: connectCard,
    vault: vaultCard,
    approve: approveCard,
    guardian: guardianCard,
    trusted: trustedCard,
    recovery: recoveryCard,
    done: doneCard,
  };

  return (
    <>
      <h1>Protect your account</h1>
      <p className="lead">
        Six steps from a plain account to a vault, an agent and a recovery plan. Each step turns done only when diana or the agent confirms it. Click any
        step to look at it.
      </p>
      <div className="protect">
        <nav className="steps" aria-label="Protect steps">
          {ORDER.map((id, i) => {
            const st = stateOf(id);
            return (
              <button
                key={id}
                type="button"
                className="step-item"
                aria-current={view === id ? "step" : undefined}
                onClick={() => setSelected(id)}
              >
                <span className={`stepnum ${st.state === "done" ? "done" : st.state === "current" ? "on" : st.state === "blocked" ? "blocked" : ""}`}>
                  {st.state === "done" || st.state === "blocked" ? MARK[st.state] : i + 1}
                </span>
                <span style={{ minWidth: 0 }}>
                  <span className="t">{TITLES[id]}</span>
                  <span className="s">{st.detail}</span>
                </span>
              </button>
            );
          })}
          <button type="button" className="step-item" aria-current={view === "done" ? "step" : undefined} onClick={() => setSelected("done")}>
            <span className={`stepnum ${allDone ? "done" : ""}`}>{allDone ? "✓" : "★"}</span>
            <span style={{ minWidth: 0 }}>
              <span className="t">{allDone ? "You're protected" : "Done"}</span>
              <span className="s">{allDone ? "all six steps confirmed" : "after every step is confirmed"}</span>
            </span>
          </button>
        </nav>
        <section className="card" style={{ padding: 24 }} aria-live="polite">
          {view !== "done" ? (
            <div className="between" style={{ marginBottom: 6 }}>
              <span className="lbl">
                Step {ORDER.indexOf(view) + 1} of 6
              </span>
              <span className={`tag ${stateOf(view).state === "done" ? "blue" : stateOf(view).state === "blocked" ? "orange" : ""}`}>
                {stateOf(view).state === "done" ? "done" : stateOf(view).state === "blocked" ? "blocked" : stateOf(view).state === "current" ? "next" : "to do"}
              </span>
            </div>
          ) : null}
          {cards[view]()}
        </section>
      </div>
    </>
  );
}

/** owner() and guardian() of a vault, read from the chain. */
async function readRoles(vault: Hex): Promise<{ owner: Hex; guardian: Hex }> {
  const [owner, guardian] = await Promise.all([
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "owner" }),
    publicClient.readContract({ address: vault, abi: vaultAbi, functionName: "guardian" }),
  ]);
  return { owner, guardian };
}
