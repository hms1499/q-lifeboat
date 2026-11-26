import type { ReactNode } from "react";
import { APP_NAME } from "../brand";
import { LifeboatMark } from "./ui";

/** Setup in focus mode: no app navigation, only the way out (progress is kept). */
export function FocusShell({ children }: { children: ReactNode }) {
  return (
    <div className="focus-shell">
      <header className="focus-bar">
        <a href="#/home" className="brand">
          <LifeboatMark />
          <span>{APP_NAME}</span>
        </a>
        <span className="focus-note">Setting up protection</span>
        <a className="focus-exit" href="#/home">
          Exit
        </a>
      </header>
      <main className="focus-main">{children}</main>
    </div>
  );
}
