/* ------------------------------------------------------------------ *
 * xtAlerts — the CrossTrade pushed-alert receiver's pure logic.
 *
 * CrossTrade's HTTP Webhook alert destination POSTs its in-app alerts
 * (position opened/closed, protection events, auto-flatten…) to a URL
 * we control (docs: crosstrade.io/docs/getting-started/user-account/
 * alert-notifications). Position events arrive PUSHED — the book state
 * no longer needs polling, which ends the demo login's rate-limit war.
 *
 * Pure + unit-tested: message parsing + the HMAC signature check.
 * The route (app/api/xt-alerts) stores alerts and closes matching
 * exec-ledger rows without a single broker read.
 * ------------------------------------------------------------------ */

import { createHmac } from "node:crypto";

export type XtPositionClosed = {
  side: "long" | "short";
  qty: number;
  instrument: string;
  exitPrice: number;
  pnlUsd: number;
};

export type XtPositionOpened = {
  side: "long" | "short";
  qty: number;
  instrument: string;
  entryPrice: number;
};

/** "Closed Short -8 MNQZ6 @ 30107.75. P&L: +$92.00." → structured */
export function parsePositionClosed(message: string): XtPositionClosed | null {
  const m = /^Closed\s+(Long|Short)\s+([+-]?\d+)\s+(\S+)\s+@\s+([\d.]+)\.\s*P&L:\s+([+-])\$?([\d,]+(?:\.\d+)?)/.exec(message.trim());
  if (!m) return null;
  return {
    side: m[1].toLowerCase() as "long" | "short",
    qty: Math.abs(Number(m[2])),
    instrument: m[3],
    exitPrice: Number(m[4]),
    pnlUsd: (m[5] === "-" ? -1 : 1) * Number(m[6].replace(/,/g, "")),
  };
}

/** "Opened Short +8 MNQZ6 @ 30113.5." → structured */
export function parsePositionOpened(message: string): XtPositionOpened | null {
  const m = /^Opened\s+(Long|Short)\s+([+-]?\d+)\s+(\S+)\s+@\s+([\d.]+)\./.exec(message.trim());
  if (!m) return null;
  return {
    side: m[1].toLowerCase() as "long" | "short",
    qty: Math.abs(Number(m[2])),
    instrument: m[3],
    entryPrice: Number(m[4]),
  };
}

/** verify the CrossTrade signature over the RAW body (docs: HMAC-SHA256,
 *  hex digest, `sha256=<digest>` header). Missing secret → false. */
export function verifyXtSignature(rawBody: string, signatureHeader: string | null, secret: string | null | undefined): boolean {
  if (!secret || !signatureHeader) return false;
  const expected = "sha256=" + hmacSha256Hex(rawBody, secret);
  const a = expected.toLowerCase();
  const b = signatureHeader.trim().toLowerCase();
  if (a.length !== b.length) return false;
  // constant-time compare
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function hmacSha256Hex(data: string, secret: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("hex");
}

/** is this alert a position event we care about? (type/title tolerant —
 *  the vendor's exact type strings are not documented; the messages are) */
export function xtAlertKind(alert: { type?: string; title?: string; message?: string }): "opened" | "closed" | "protection" | "other" {
  const s = `${alert.type ?? ""} ${alert.title ?? ""} ${alert.message ?? ""}`.toLowerCase();
  if (s.includes("position closed")) return "closed";
  if (s.includes("position opened")) return "opened";
  if (s.includes("protection") || s.includes("auto-flatten") || s.includes("auto_flatten")) return "protection";
  return "other";
}
