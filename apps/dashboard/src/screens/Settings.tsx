import { useState } from "react";
import { formatUnits, type Hex } from "viem";
import { useKeys } from "../components/KeysProvider";
import { EditorMessages, TrustedEditor, usePolicyEditor } from "../components/TrustedEditor";
import { ExtLink } from "../components/ui";
import type { Policy } from "../lib/agent";
import { hosted } from "../lib/appWallet";
import { explorerAddress } from "../lib/chain";
import { errorText, fmtAmount } from "../lib/format";
import { big } from "../lib/incidents";
import { parseQorAmount } from "../lib/rules";
import { useApp } from "../state";

/** The protected owner's settings: what the Guardian trusts, the transfer limit, alerts and the wallet in this browser. */
export function Settings({ owner }: { owner: Hex }) {
  const { config } = useApp();
  const cfg = config.cfg;
  const keys = useKeys();
  // Every policy write carries the owner's post-quantum signature (the gateway refuses anything else): unlock first.
  const editor = usePolicyEditor(config.agentOnline, (p: Policy) => hosted.signed("policy", p), () => keys.requireKeys("pqc"));
  const { current, canEdit, save, fail } = editor;
  const [threshold, setThreshold] = useState<string | null>(null);

  async function saveThreshold() {
    if (!current || threshold === null) return;
    let maxOutbound: string;
    try {
      maxOutbound = parseQorAmount(threshold);
    } catch (e) {
      return fail(errorText(e));
    }
    if (await save({ ...current, maxOutbound }, `Largest trusted transfer set to ${fmtAmount(BigInt(maxOutbound), 6)} tokens.`)) setThreshold(null);
  }

  return (
    <>
      <h1>Settings</h1>
      <p className="lead">What your Guardian treats as normal. A transfer or approval to anything else, or above the limit, moves your tokens to your vault.</p>
      {!config.agentOnline ? (
        <div className="banner warn" role="status">
          <strong>Your Guardian is not answering: editing is off.</strong> These settings live with your Guardian. Try again in a minute.
        </div>
      ) : null}
      <div className="row">
        <div className="stack grow">
          {cfg ? <TrustedEditor cfg={cfg} editor={editor} /> : <section className="card"><p className="dash-hint">Reading your Guardian's settings…</p></section>}

          <section className="card">
            <h2>Largest trusted transfer</h2>
            <p className="dash-hint" style={{ margin: "6px 0 12px" }}>
              A transfer of more than this many tokens (fUSD, fETH or fBTC) moves your tokens to the vault even when it goes to a trusted wallet. 0
              means every transfer does.
              {current ? (
                <>
                  {" "}
                  Now: <strong>{fmtAmount(big(current.maxOutbound), 6)} per transfer</strong>.
                </>
              ) : null}
            </p>
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                void saveThreshold();
              }}
            >
              <label style={{ flex: "1 1 160px" }}>
                Tokens per transfer
                <input
                  className="input mono"
                  inputMode="decimal"
                  disabled={!canEdit}
                  value={threshold ?? (current ? formatUnits(big(current.maxOutbound), 18) : "")}
                  onChange={(e) => setThreshold(e.target.value)}
                />
              </label>
              <button type="submit" className="btn primary small" disabled={!canEdit || threshold === null}>
                Save
              </button>
            </form>
          </section>
          <EditorMessages editor={editor} />
        </div>

        <aside className="side">
          <section className="card">
            <div className="between">
              <h2>Alerts</h2>
              <span className="tag">Coming soon</span>
            </div>
            <p className="dash-hint" style={{ margin: "6px 0 0" }}>
              Telegram and email alerts are not available on the public instance yet. Every rescue shows on your <a href="#/dashboard">Dashboard</a>{" "}
              and in <a href="#/activity">Activity</a> with its signed report.
            </p>
          </section>
          <section className="card">
            <h2>Wallet</h2>
            <dl className="kv">
              <div>
                <dt>Account</dt>
                <dd className="mono wrap-any">
                  <ExtLink href={explorerAddress(owner)}>{owner}</ExtLink>
                </dd>
              </div>
              <div>
                <dt>In this browser</dt>
                <dd>{keys.unlocked ? "Unlocked" : "Locked"}</dd>
              </div>
            </dl>
            <p className="dash-hint" style={{ margin: "10px 0 12px" }}>
              Your wallet is stored encrypted in this browser. It unlocks with your password when you sign, and your recovery code is asked for only
              when a signature needs it. Neither is ever sent anywhere.
            </p>
            <button type="button" className="btn small" disabled={!keys.unlocked} onClick={keys.lock}>
              Lock now
            </button>
          </section>
        </aside>
      </div>
    </>
  );
}
