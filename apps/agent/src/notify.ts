import { formatEther, type Hex } from "viem";
import type { OutboundTx, RescueRecord } from "@qday/core";
import { bigintReplacer } from "@qday/core/chain";

/** What the owner is told about. Carries no keys or secrets. */
export type AlertEvent =
  /** `error`: rescue() itself failed (e.g. the guardian window could not be opened), so `rescues` may be empty. */
  | { type: "rescue"; trigger: OutboundTx; reason: string; rescues: RescueRecord[]; detectedAt: string; error?: string }
  | { type: "alert"; trigger: OutboundTx; reason: string; detectedAt: string }
  | { type: "gas-low"; guardian: Hex; balance: bigint; threshold: bigint }
  /** A plain notice (e.g. the guardian window opened because the owner's did). */
  | { type: "info"; message: string };

const TELEGRAM_MAX = 4000; // sendMessage takes at most 4096 characters

const describeTrigger = (t: OutboundTx) =>
  `Trigger: ${t.kind} of ${t.amount} (base units) on token ${t.token} to ${t.to}, tx ${t.hash}, block ${t.block}`;

/** Plain-text message for an event: what happened, token, amounts, rescue tx hashes and success, reason. */
export function formatAlert(e: AlertEvent): string {
  if (e.type === "info") return `Q-Lifeboat: ${e.message}`;
  if (e.type === "gas-low") {
    return [
      "Q-Lifeboat: guardian gas LOW",
      `Guardian ${e.guardian} holds ${formatEther(e.balance)} QOR, below the ${formatEther(e.threshold)} QOR threshold.`,
      "Top it up: rescue txs are paid from this account.",
    ].join("\n");
  }
  if (e.type === "alert") {
    return ["Q-Lifeboat: ALERT (no rescue attempted)", describeTrigger(e.trigger), `Reason: ${e.reason}`, `Detected: ${e.detectedAt}`].join("\n");
  }
  const ok = e.rescues.filter((r) => r.success).length;
  const lines = e.rescues.map(
    (r) =>
      `- token ${r.token}: moved ${r.amount} (expected ${r.expected}), tx ${r.hash} ${r.success ? "OK" : `FAILED${r.error ? ` (${r.error})` : ""}`}`,
  );
  const headline = e.error
    ? `Q-Lifeboat: RESCUE FAILED: ${e.error}`
    : `Q-Lifeboat: RESCUE, ${ok}/${e.rescues.length} rescue tx(s) succeeded`;
  const none = e.error ? "Rescues: none sent" : "Rescues: none (nothing to move)";
  return [
    headline,
    describeTrigger(e.trigger),
    `Reason: ${e.reason}`,
    ...(lines.length ? ["Rescues:", ...lines] : [none]),
    `Detected: ${e.detectedAt}`,
  ].join("\n");
}

export type NotifierOptions = {
  telegram?: { token: string; chatId: string };
  webhookUrl?: string;
  fetch?: typeof globalThis.fetch;
  log: (line: string) => void;
  timeoutMs?: number;
};

export type Notifier = {
  /** Sends on every configured channel in parallel. Never rejects; failures are logged. */
  notify(e: AlertEvent): Promise<void>;
  channels: { telegram: boolean; webhook: boolean };
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Telegram bot + JSON webhook. Each channel has its own timeout; one failing never affects the other. */
export function createNotifier(opts: NotifierOptions): Notifier {
  const { telegram, webhookUrl, log, timeoutMs = 5_000 } = opts;
  const doFetch = opts.fetch ?? globalThis.fetch;
  // The bot token sits in the Telegram URL, and a webhook URL often carries a secret: keep both out of the logs.
  const secrets = [telegram?.token, webhookUrl].filter((s): s is string => !!s);
  const redact = (s: string) => secrets.reduce((out, secret) => out.split(secret).join("<redacted>"), s);

  async function post(channel: "telegram" | "webhook", url: string, body: string): Promise<void> {
    try {
      const r = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      log(redact(`notify ${channel} failed: ${errorText(e)}`));
    }
  }

  return {
    channels: { telegram: !!telegram, webhook: !!webhookUrl },
    async notify(e) {
      const sends: Promise<void>[] = [];
      try {
        if (telegram) {
          const text = formatAlert(e).slice(0, TELEGRAM_MAX);
          const body = JSON.stringify({ chat_id: telegram.chatId, text, disable_web_page_preview: true });
          sends.push(post("telegram", `https://api.telegram.org/bot${telegram.token}/sendMessage`, body));
        }
        if (webhookUrl) sends.push(post("webhook", webhookUrl, JSON.stringify(e, bigintReplacer)));
      } catch (err) {
        log(redact(`notify failed: ${errorText(err)}`));
      }
      await Promise.all(sends);
    },
  };
}
