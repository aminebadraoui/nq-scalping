import { readFileSync } from "fs";
import path from "path";

/* ------------------------------------------------------------------ *
 * Telegram notifier.
 *
 * Configure TELEGRAM_BOT_TOKEN in gcdata/.env (or process env). The
 * CHAT ID is optional: for a personal bot the first time the owner
 * messages the bot (any text), `resolveChatId` discovers their private
 * chat via getUpdates and caches it, so no chat id has to be copied by
 * hand. Set TELEGRAM_CHAT_ID explicitly to pin the target (and it is
 * required in production — Coolify env — where gcdata/.env may not be
 * mounted).
 * ------------------------------------------------------------------ */

export type TelegramResult = { sent: boolean; reason: string; chatId?: string };

export function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const envPath = path.join(process.cwd(), "..", "gcdata", ".env");
  try {
    const raw = readFileSync(envPath, "utf8");
    for (const line of raw.split("\n")) {
      const s = line.trim();
      if (!s || s.startsWith("#") || !s.includes("=")) continue;
      const [k, ...rest] = s.split("=");
      out[k.trim()] = rest.join("=").trim();
    }
  } catch {
    /* no env file */
  }
  for (const k of ["TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) {
    if (process.env[k]) out[k] = process.env[k]!;
  }
  return out;
}

/** discovered chat id, cached in-process so getUpdates is only called once */
let cachedChatId: string | null = null;

/**
 * Resolve the target chat id: explicit env first, then auto-discover from the
 * most recent private chat that has messaged the bot. Returns null when neither
 * is available (the owner has not messaged the bot yet).
 */
export async function resolveChatId(): Promise<string | null> {
  const env = loadEnv();
  if (env.TELEGRAM_CHAT_ID) return env.TELEGRAM_CHAT_ID;
  if (cachedChatId) return cachedChatId;
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=100&timeout=0`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(10_000),
    });
    const j = (await res.json()) as { ok: boolean; result?: any[] };
    if (!j.ok || !Array.isArray(j.result)) return null;
    let chatId: string | null = null;
    for (const u of j.result) {
      // chat id may arrive via a plain message, an edited message, or a
      // membership event (the /start flow). Keep the LAST one seen.
      const chat = u?.message?.chat ?? u?.edited_message?.chat ?? u?.my_chat_member?.chat ?? u?.chat;
      if (chat && chat.type === "private" && typeof chat.id === "number") chatId = String(chat.id);
    }
    cachedChatId = chatId;
    return chatId;
  } catch {
    return null;
  }
}

/** Escape the characters that would break HTML parse mode. */
export function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function sendTelegram(
  text: string,
  opts: { parseMode?: "HTML" | "MarkdownV2" } = {},
): Promise<TelegramResult> {
  const env = loadEnv();
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    return { sent: false, reason: "Telegram not configured — set TELEGRAM_BOT_TOKEN in gcdata/.env" };
  }
  const chatId = env.TELEGRAM_CHAT_ID ?? (await resolveChatId());
  if (!chatId) {
    return {
      sent: false,
      reason: "Telegram chat not found — message the bot once (any text) so it knows where to send",
    };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
        ...(opts.parseMode ? { parse_mode: opts.parseMode } : {}),
      }),
    });
    const j = (await res.json()) as any;
    if (j.ok) return { sent: true, reason: "sent", chatId };
    return { sent: false, reason: `Telegram error: ${j.description ?? "unknown"}`, chatId };
  } catch (e) {
    return { sent: false, reason: `Telegram send failed: ${String(e)}`, chatId };
  }
}
