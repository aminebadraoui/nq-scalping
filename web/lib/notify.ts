import { promises as fs } from "fs";
import path from "path";

/* Telegram notifier. Configure TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in
   gcdata/.env (or process env) once you create the bot. */

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const envPath = path.join(process.cwd(), "..", "gcdata", ".env");
  try {
    const raw = require("fs").readFileSync(envPath, "utf8");
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

export async function sendTelegram(text: string): Promise<{ sent: boolean; reason: string }> {
  const env = loadEnv();
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    return { sent: false, reason: "Telegram not configured — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in gcdata/.env" };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    const j = (await res.json()) as any;
    if (j.ok) return { sent: true, reason: "sent" };
    return { sent: false, reason: `Telegram error: ${j.description ?? "unknown"}` };
  } catch (e) {
    return { sent: false, reason: `Telegram send failed: ${String(e)}` };
  }
}
