import { formatUnits, maxUint256, zeroAddress } from "viem";
import type { AgentConfig } from "./config";

export const shortAddr = (a: string | null | undefined) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : (a ?? ""));
export const shortHash = (h: string) => (h.length > 22 ? `${h.slice(0, 18)}…${h.slice(-4)}` : h);

/** 18-decimal amount, at most `digits` decimals, thousands separated. */
export function fmtAmount(wei: bigint, digits = 2): string {
  if (wei >= maxUint256 / 2n) return "unlimited";
  const [int, frac = ""] = formatUnits(wei, 18).split(".");
  const intPart = BigInt(int).toLocaleString("en-US");
  const f = frac.slice(0, digits).replace(/0+$/, "");
  if (!f && wei > 0n && BigInt(int) === 0n) return `<0.${"0".repeat(digits - 1)}1`;
  return f ? `${intPart}.${f}` : intPart;
}

export const fmtInt = (v: bigint | number | string) => {
  try {
    return BigInt(v).toLocaleString("en-US");
  } catch {
    return String(v);
  }
};

/** fUSD / fETH / fBTC from the config, QOR for the zero address, else a short address. */
export function tokenSymbol(cfg: AgentConfig | null, token: string): string {
  if (token.toLowerCase() === zeroAddress) return "QOR";
  if (cfg) for (const [sym, a] of Object.entries(cfg.tokens)) if (a.toLowerCase() === token.toLowerCase()) return sym;
  return shortAddr(token);
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

export function when(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));
