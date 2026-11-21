import type { OutboundTx, RescueRecord } from "@qday/core";
import { describe, expect, it, vi } from "vitest";
import { createNotifier, formatAlert, type AlertEvent } from "../src/notify";

const TOKEN = "0x00000000000000000000000000000000000000a1" as const;
const STRANGER = "0x9999999999999999999999999999999999999999" as const;
const GUARDIAN = "0x9858EfFD232B4033E47d90003D41EC34EcaEdA94" as const;
const BOT_TOKEN = "123456:SECRET-bot-token_xyz";
const trigger: OutboundTx = { kind: "transfer", hash: "0xfeed", block: 42n, token: TOKEN, to: STRANGER, amount: 5000n };
const rescues: RescueRecord[] = [
  { token: TOKEN, hash: "0xr1", amount: 95000n, expected: 95000n, success: true },
  { token: "0x00000000000000000000000000000000000000b2", hash: "0xr2", amount: 0n, expected: 7n, success: false, error: "reverted" },
];
const rescue: AlertEvent = { type: "rescue", trigger, reason: "recipient not trusted", rescues, detectedAt: "2026-11-21T10:00:00.000Z" };
const alert: AlertEvent = { type: "alert", trigger: { ...trigger, kind: "approval", amount: 0n }, reason: "vault allowance lowered to 0", detectedAt: "2026-11-21T10:00:00.000Z" };
const gasLow: AlertEvent = { type: "gas-low", guardian: GUARDIAN, balance: 4n * 10n ** 17n, threshold: 5n * 10n ** 17n };

type Call = { url: string; init: RequestInit };
function fakeFetch(answer: (url: string) => Response | Promise<Response> = () => new Response("{}", { status: 200 })) {
  const calls: Call[] = [];
  const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return answer(String(url));
  });
  return { f: f as unknown as typeof fetch, calls };
}

describe("formatAlert", () => {
  it("says what was rescued: trigger, token, amounts, rescue hashes and success, reason", () => {
    const t = formatAlert(rescue);
    for (const s of ["RESCUE", "0xfeed", TOKEN, STRANGER, "5000", "95000", "0xr1", "0xr2", "reverted", "recipient not trusted"]) expect(t).toContain(s);
    expect(t).toMatch(/0xr1.*OK/);
    expect(t).toMatch(/0xr2.*FAILED/);
  });

  it("formats an alert-only incident and a low gas balance", () => {
    expect(formatAlert(alert)).toMatch(/ALERT/);
    expect(formatAlert(alert)).toContain("vault allowance lowered to 0");
    const g = formatAlert(gasLow);
    expect(g).toContain(GUARDIAN);
    expect(g).toContain("0.4");
    expect(g).toContain("0.5");
  });
});

describe("createNotifier", () => {
  it("resolves at once with no channel configured, and reports the channels", async () => {
    const { f, calls } = fakeFetch();
    const n = createNotifier({ fetch: f, log: () => {} });
    expect(n.channels).toEqual({ telegram: false, webhook: false });
    await n.notify(rescue);
    expect(calls).toHaveLength(0);
  });

  it("posts a Telegram sendMessage with the formatted text", async () => {
    const { f, calls } = fakeFetch();
    const n = createNotifier({ telegram: { token: BOT_TOKEN, chatId: "-1001" }, fetch: f, log: () => {} });
    expect(n.channels).toEqual({ telegram: true, webhook: false });
    await n.notify(rescue);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ chat_id: "-1001", text: formatAlert(rescue), disable_web_page_preview: true });
  });

  it("posts the event as JSON to the webhook (bigints as strings)", async () => {
    const { f, calls } = fakeFetch();
    const n = createNotifier({ webhookUrl: "https://hooks.example/q", fetch: f, log: () => {} });
    await n.notify(gasLow);
    expect(calls[0].url).toBe("https://hooks.example/q");
    expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ type: "gas-low", guardian: GUARDIAN, balance: "400000000000000000", threshold: "500000000000000000" });
  });

  it("sends both channels in parallel", async () => {
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = vi.fn(async () => { started++; await gate; return new Response("{}"); }) as unknown as typeof fetch;
    const n = createNotifier({ telegram: { token: BOT_TOKEN, chatId: "1" }, webhookUrl: "https://hooks.example/q", fetch: f, log: () => {} });
    const p = n.notify(rescue);
    await Promise.resolve();
    expect(started).toBe(2);
    release();
    await p;
  });

  it("never rejects: a non-2xx or a throw is logged with the bot token redacted", async () => {
    const lines: string[] = [];
    const { f } = fakeFetch((url) => {
      if (url.includes("telegram")) throw new Error(`connect failed for ${url}`);
      return new Response("nope", { status: 502 });
    });
    const n = createNotifier({ telegram: { token: BOT_TOKEN, chatId: "1" }, webhookUrl: "https://hooks.example/q", fetch: f, log: (l) => void lines.push(l) });
    await expect(n.notify(rescue)).resolves.toBeUndefined();
    expect(lines.find((l) => l.startsWith("notify telegram failed:"))).toBeDefined();
    expect(lines.find((l) => l.startsWith("notify webhook failed:"))).toMatch(/502/);
    expect(lines.join("\n")).not.toContain(BOT_TOKEN);
    expect(lines.join("\n")).not.toContain("SECRET");
  });

  it("times out a hung channel and logs it", async () => {
    const lines: string[] = [];
    const f = vi.fn(
      (_u: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))),
    ) as unknown as typeof fetch;
    const n = createNotifier({ telegram: { token: BOT_TOKEN, chatId: "1" }, fetch: f, log: (l) => void lines.push(l), timeoutMs: 20 });
    await expect(n.notify(alert)).resolves.toBeUndefined();
    expect(lines.some((l) => l.startsWith("notify telegram failed:"))).toBe(true);
    expect(lines.join("\n")).not.toContain(BOT_TOKEN);
  });
});
