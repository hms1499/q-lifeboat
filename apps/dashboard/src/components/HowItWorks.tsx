import { useCallback, useState } from "react";

const KEY = "qlifeboat.howItWorks.dismissed";

const read = (): boolean => {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};

const write = (dismissed: boolean) => {
  try {
    if (dismissed) window.localStorage.setItem(KEY, "1");
    else window.localStorage.removeItem(KEY);
  } catch {
    // Storage blocked: the choice just lasts until reload.
  }
};

/** Whether the explainer is showing; dismissal persists in localStorage (best effort). */
export function useHowItWorks(): { shown: boolean; dismiss: () => void; reopen: () => void } {
  const [shown, setShown] = useState(() => !read());
  const dismiss = useCallback(() => {
    write(true);
    setShown(false);
  }, []);
  const reopen = useCallback(() => {
    write(false);
    setShown(true);
  }, []);
  return { shown, dismiss, reopen };
}

const STEPS = [
  { n: "1", label: "Watch", text: "The Guardian watches every transfer and approval from your account." },
  { n: "2", label: "Rescue", text: "If one goes somewhere you don't trust, it moves your tokens into your vault within a block or two." },
  { n: "3", label: "Recover", text: "Only your ML-DSA-87 (post-quantum) key can take them out, to a new safe address." },
];

export function HowItWorks({ onDismiss }: { onDismiss: () => void }) {
  return (
    <section className="card explainer" aria-label="How Q-Lifeboat works">
      <h2>Q-Lifeboat keeps your tokens safe if your wallet key leaks</h2>
      <p className="ex-lead">
        Quantum computers (or a plain leak) can expose the ECDSA key behind your EVM account. Q-Lifeboat watches it and moves your tokens somewhere only
        your post-quantum key can open.
      </p>
      <ol className="ex-steps">
        {STEPS.map((s) => (
          <li key={s.n}>
            <span className="ex-label">
              {s.n} {s.label}
            </span>
            <span className="ex-text">{s.text}</span>
          </li>
        ))}
      </ol>
      <div className="actions" style={{ marginTop: 14 }}>
        <a className="btn primary small" href="#/protect">
          Set up protection
        </a>
        <a className="btn small" href="#/drill">
          Watch a fire drill (~90 s)
        </a>
        <button type="button" className="btn small" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </section>
  );
}
