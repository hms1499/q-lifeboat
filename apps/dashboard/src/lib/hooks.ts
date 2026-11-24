import { useCallback, useEffect, useRef, useState } from "react";
import type { Incident } from "@qday/core";
import type { Hex } from "viem";
import { readTxSender } from "./chain";
import { errorText } from "./format";

export type Polled<T> = { data: T | undefined; error: string | null; loading: boolean; at: number | null; refresh: () => void; slow: boolean };

/** A first read with no data after this long is reported as "slow". */
export const SLOW_MS = 8_000;

/** Pure: true while there is still no data and the first attempt started more than SLOW_MS ago. */
export const isSlow = (startedAt: number | null, now: number, hasData: boolean) => !hasData && startedAt !== null && now - startedAt > SLOW_MS;

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
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    setData(undefined);
    setError(null);
    setAt(null);
    setStartedAt(key === null ? null : Date.now());
  }, [key]);

  // Tick only while waiting for the first value, so the slow flag flips without a re-render source of its own.
  const waiting = key !== null && data === undefined;
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [waiting, key]);

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

  return { data, error, loading, at, refresh, slow: isSlow(startedAt, now, data !== undefined) };
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

const SENDER_RETRY_MS = 15_000;
const SENDER_CONCURRENCY = 4;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
/** Module scope, so a tab switch does not read the same trigger txs again. */
const senderCache: Record<string, string> = {};

/**
 * The sender of each incident's trigger tx, keyed by lowercase trigger hash. A hash that is not an EVM tx (native
 * lane) or whose read failed stays missing ("checking"); failed reads are retried after 15 s. Never blocks rendering.
 */
export function useTriggerSenders(list: readonly Incident[]): Record<string, string | null> {
  const [found, setFound] = useState<Record<string, string>>(() => ({ ...senderCache }));
  const [retry, setRetry] = useState(0);
  const hashes = list.map((i) => String(i.trigger?.hash ?? "")).filter((h) => HASH_RE.test(h));
  const listKey = hashes.join(",");

  useEffect(() => {
    const todo = [...new Set(hashes.map((h) => h.toLowerCase()))].filter((h) => !senderCache[h]);
    if (!todo.length) return;
    let live = true;
    let failed = false;
    const queue = [...todo];
    const worker = async () => {
      for (let h = queue.shift(); h && live; h = queue.shift()) {
        try {
          const from = await readTxSender(h as Hex);
          if (from) {
            senderCache[h] = from;
            if (live) setFound((f) => ({ ...f, [h]: from }));
          } else failed = true;
        } catch {
          failed = true;
        }
      }
    };
    void Promise.all(Array.from({ length: Math.min(SENDER_CONCURRENCY, todo.length) }, worker)).then(() => {
      if (live && failed) timer = setTimeout(() => setRetry((n) => n + 1), SENDER_RETRY_MS);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listKey, retry]);

  const out: Record<string, string | null> = {};
  for (const h of hashes) out[h.toLowerCase()] = found[h.toLowerCase()] ?? senderCache[h.toLowerCase()] ?? null;
  return out;
}
