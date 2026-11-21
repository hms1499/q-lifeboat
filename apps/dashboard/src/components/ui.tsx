import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import type { CheckStatus } from "../lib/verify";

export function ShieldIcon({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#1E4FD8" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

/** A shell command the owner runs in the repo root, with a copy button. */
export function Command({ cmd, children }: { cmd: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
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
      <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>
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
