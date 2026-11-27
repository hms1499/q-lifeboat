import type { ReactNode } from "react";
import { APP_NAME } from "../brand";
import { LifeboatMark } from "./ui";

/** Setup or restore in focus mode: no app navigation, only the way out (progress is kept). */
export function FocusShell({ children, note = "Setting up protection" }: { children: ReactNode; note?: string }) {
  return (
    <div className="focus-shell">
      <header className="focus-bar">
        <a href="#/home" className="brand">
          <LifeboatMark />
          <span>{APP_NAME}</span>
        </a>
        <span className="focus-note">{note}</span>
        <a className="focus-exit" href="#/home">
          Exit
        </a>
      </header>
      <main className="focus-main">{children}</main>
    </div>
  );
}
