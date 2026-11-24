import { Component, useId, useState, type ErrorInfo, type ReactNode } from "react";
import { explorerTxUrl } from "../lib/chain";
import { shortHash } from "../lib/format";
import type { CheckStatus } from "../lib/verify";

/**
 * The brand mark, "Harbor shield" (direction C of the Q-Lifeboat logo canvas): a shield (the vault) with a lifebuoy, a boat
 * and a wave cut out of it. The shield takes `currentColor`; the cut-outs are real holes (a mask), so they show whatever
 * is behind the mark.
 */
export function LifeboatMark({ size = 32 }: { size?: number }) {
  const id = `lb-cut-${useId().replace(/:/g, "")}`;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64">
        <rect width="64" height="64" fill="#fff" />
        <circle cx="32" cy="22" r="4.5" fill="none" stroke="#000" strokeWidth="3" />
        <path d="M18 31 H46 L42 40 Q41 42 39 42 H25 Q23 42 22 40 Z" fill="#000" />
        <path d="M21 48 q2.75 -2.5 5.5 0 t5.5 0 t5.5 0 t5.5 0" fill="none" stroke="#000" strokeWidth="2.6" strokeLinecap="round" />
      </mask>
      <path d="M32 5 L54 13 V30 C54 44 44 54 32 59 C20 54 10 44 10 30 V13 Z" fill="currentColor" mask={`url(#${id})`} />
    </svg>
  );
}

const NAV_PATHS: Record<string, ReactNode> = {
  overview: (
    <>
      <path d="M3 12h4l3-7 4 14 3-7h4" />
    </>
  ),
  incidents: (
    <>
      <path d="M5 21V4h11l-2 4 2 4H5" />
    </>
  ),
  recover: (
    <>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M12 15V3M8 7l4-4 4 4" />
    </>
  ),
  protect: (
    <>
      <path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z" />
    </>
  ),
  rules: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01" />
    </>
  ),
  drill: (
    <>
      <circle cx="12" cy="13" r="8" />
      <path d="M12 9v4l2.5 2.5M9 2h6" />
    </>
  ),
};

/** 20px line icons for the main nav. */
export function NavIcon({ name }: { name: string }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {NAV_PATHS[name]}
    </svg>
  );
}

/** Copy `text` to the clipboard; `copied` reads true for 1.5 s after a success. */
function useCopy(text: string): { copied: boolean; copy: () => Promise<void> } {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return { copied, copy };
}

/** A shell command the owner runs in the repo root, with a copy button. */
export function Command({ cmd, children }: { cmd: string; children?: ReactNode }) {
  const { copied, copy } = useCopy(cmd);
  return (
    <div className="cmd">
      {children}
      <div className="line">
        <code>{cmd}</code>
        <button type="button" className="btn small" onClick={copy} aria-label={`Copy ${cmd}`}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </div>
  );
}

/** Selectable text with a Copy button (run ids, EVM tx hashes: never an explorer link). */
export function CopyText({ text, label }: { text: string; label?: string }) {
  const { copied, copy } = useCopy(text);
  return (
    <span>
      <span className="mono wrap-any">{text}</span>
      <button type="button" className="copy-mini" onClick={() => void copy()} aria-label={`Copy ${label ?? text}`}>
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

const MARK: Record<CheckStatus | "pending", string> = { pass: "✓", fail: "✗", "n/a": "–", pending: "…" };

export function CheckRow({ status, title, detail }: { status: CheckStatus | "pending"; title: string; detail?: string }) {
  return (
    <div className="check">
      <span className={`mark ${status === "pass" ? "pass" : status === "fail" ? "fail" : ""}`} aria-label={status}>
        {MARK[status]}
      </span>
      <div>
        <div className="ct">{title}</div>
        {detail ? <div className="cd">{detail}</div> : null}
      </div>
    </div>
  );
}

const EVM_TX_NOTE = "diana's explorer indexes native-lane txs only; this EVM tx was checked by its receipt from the EVM RPC";

/**
 * A tx hash: a native-lane (Cosmos) hash links to the explorer; a 0x EVM hash has no explorer page on diana, so it is
 * shown with a Copy button instead.
 */
export function TxHash({ hash, full = false }: { hash: string; full?: boolean }) {
  const { copied, copy } = useCopy(hash);
  const url = explorerTxUrl(hash);
  const text = full ? hash : shortHash(hash);
  if (url) {
    return (
      <ExtLink href={url}>
        <span className="mono">{text}</span>
      </ExtLink>
    );
  }
  return (
    <span title={EVM_TX_NOTE}>
      <span className="mono">{text}</span>
      <button type="button" className="copy-mini" onClick={() => void copy()} aria-label={`Copy tx hash ${hash}`}>
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

export function ExtLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

/**
 * `pnpm cli window open|close --expect <owner>`: the CLI signs for OWNER_MNEMONIC and refuses before signing when that
 * is not the watched owner (a demo.sh run's fresh owner is not the root .env owner).
 */
export function WindowCommand({ action, owner, children }: { action: "open" | "close"; owner: string; children?: ReactNode }) {
  return (
    <Command cmd={`pnpm cli window ${action} --expect ${owner}`}>
      {children}
      <div style={{ fontSize: 13, lineHeight: "19px", color: "var(--muted)", marginTop: 8 }}>
        It refuses to sign unless the CLI's owner is {owner}. For a demo.sh owner, run it with that run's env:{" "}
        <span className="mono wrap-any">
          (set -a &amp;&amp; . ~/.config/qday/runs/&lt;run id&gt;/run.env &amp;&amp; set +a &amp;&amp; pnpm cli window {action} --expect {owner})
        </span>
      </div>
    </Command>
  );
}

/** A screen that throws shows this instead of blanking the whole app (the top bar and banners stay up). */
export class ScreenBoundary extends Component<{ children: ReactNode; resetKey: string }, { error: string | null; key: string }> {
  state = { error: null as string | null, key: this.props.resetKey };

  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  static getDerivedStateFromProps(props: { resetKey: string }, state: { error: string | null; key: string }) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(e: unknown, info: ErrorInfo) {
    console.error("screen error", e, info.componentStack);
  }

  render() {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="banner bad" role="alert">
        <strong>This screen hit an error and stopped.</strong> {this.state.error}. Other screens still work; reload to try again.
      </div>
    );
  }
}
