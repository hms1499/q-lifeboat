import { useCallback, useEffect, useRef, useState } from "react";
import { errorText } from "./format";

export type Polled<T> = { data: T | undefined; error: string | null; loading: boolean; at: number | null; refresh: () => void };

/**
 * Run `load` now and every `ms` while mounted (and again when `key` changes). Keeps the last good value when a later
 * read fails, so a REST hiccup does not blank a card. `key === null` pauses it (nothing to read yet).
 */
export function usePoll<T>(load: () => Promise<T>, ms: number, key: string | null): Polled<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [at, setAt] = useState<number | null>(null);
  const loadRef = useRef(load);
  loadRef.current = load;
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    setData(undefined);
    setError(null);
    setAt(null);
  }, [key]);

  useEffect(() => {
    if (key === null) return;
    let live = true;
    let busy = false;
    const run = async () => {
      if (busy) return;
      busy = true;
      setLoading(true);
      try {
        const v = await loadRef.current();
        if (live) {
          setData(v);
          setError(null);
          setAt(Date.now());
        }
      } catch (e) {
        if (live) setError(errorText(e));
      } finally {
        busy = false;
        if (live) setLoading(false);
      }
    };
    void run();
    const t = setInterval(() => void run(), ms);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [key, ms, tick]);

  return { data, error, loading, at, refresh };
}

/** The current location hash route, e.g. "#/incidents/abc" → ["incidents", "abc"]. */
export function useHashRoute(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => setParts(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return parts;
}
