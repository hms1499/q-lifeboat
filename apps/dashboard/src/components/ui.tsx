import { useState, type ReactNode } from "react";
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
