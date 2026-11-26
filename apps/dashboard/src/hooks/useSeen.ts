import { useEffect, useState } from "react";
import { loadSeenIncident, saveSeenIncident } from "../lib/seen";
import { browserStorage } from "../lib/storage";

const EVENT = "qlifeboat-seen-incident";

/** The owner's last seen incident id, shared by every component (marking one seen updates them all). */
export function useSeenIncident(owner: string | null): [string | null, (id: string) => void] {
  const read = () => (owner ? loadSeenIncident(browserStorage(), owner) : null);
  const [seen, setSeen] = useState<string | null>(read);
  useEffect(() => {
    setSeen(read());
    const on = () => setSeen(read());
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owner]);
  const mark = (id: string) => {
    if (!owner) return;
    saveSeenIncident(browserStorage(), owner, id);
    window.dispatchEvent(new Event(EVENT));
  };
  return [seen, mark];
}
