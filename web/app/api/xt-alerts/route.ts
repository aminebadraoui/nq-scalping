/* ------------------------------------------------------------------ *
 * /api/xt-alerts — CrossTrade pushed alerts (the HTTP Webhook
 * destination, Pro plan). Position opened/closed and protection
 * events arrive PUSHED — the book state no longer needs polling.
 *
 * POST body (vendor contract, alert-notifications docs):
 *   { type, title, message, account, details, timestamp }
 * Headers: X-XTrade-Type, X-XTrade-Timestamp, X-XTrade-Signature
 *   (HMAC-SHA256 of the RAW body, hex, "sha256=<digest>") when a
 *   shared secret is set on BOTH sides.
 *
 * This route: verifies the signature (401 otherwise), stores every
 * alert (idempotent), and for position-closed events closes the
 * matching open exec-ledger row WITHOUT a broker read (the push IS
 * the flat transition the exit poll used to discover by polling).
 * ------------------------------------------------------------------ */

import { dbEnabled, getDb } from "@/lib/gcdb";
import { parsePositionClosed, parsePositionOpened, verifyXtSignature, xtAlertKind } from "@/lib/xtAlerts";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const secret = process.env.X_XTRADE_SHARED_SECRET;
  if (!secret) {
    return Response.json({ ok: false, error: "receiver not configured — set X_XTRADE_SHARED_SECRET" }, { status: 503 });
  }
  const raw = await req.text();
  const sig = req.headers.get("x-xtrade-signature");
  if (!verifyXtSignature(raw, sig, secret)) {
    return Response.json({ ok: false, error: "bad signature" }, { status: 401 });
  }

  let alert: { type?: string; title?: string; message?: string; account?: string; details?: unknown; timestamp?: number };
  try {
    alert = JSON.parse(raw);
  } catch {
    return Response.json({ ok: false, error: "bad json" }, { status: 400 });
  }

  const kind = xtAlertKind(alert);
  const ts = Number(alert.timestamp ?? 0) > 0 ? Number(alert.timestamp) * 1000 : Date.now();
  const message = String(alert.message ?? "");
  const title = String(alert.title ?? "");
  const account = String(alert.account ?? "");
  const type = String(alert.type ?? "");

  if (!dbEnabled()) return Response.json({ ok: false, error: "no DATABASE_URL" }, { status: 500 });

  const sql = getDb();
  try {
    // self-healing DDL: the table is normally created by the nightly
    // ingest (db/schema.sql) — ensure it exists without waiting for it
    await sql.unsafe(
      `create table if not exists xt_alerts (
         id bigint generated always as identity primary key,
         ts bigint not null, type text not null default '', title text not null default '',
         message text not null default '', account text not null default '', details jsonb,
         created_at timestamptz not null default now(),
         unique (ts, type, title)
       ); create index if not exists xt_alerts_ts_idx on xt_alerts (ts desc);`,
    );
    await sql`
      insert into xt_alerts (ts, type, title, message, account, details)
      values (${ts}, ${type}, ${title}, ${message}, ${account}, ${JSON.stringify(alert.details ?? null)}::jsonb)
      on conflict (ts, type, title) do nothing
    `;

    // position closed: the push IS the flat transition — close the
    // matching open ledger row with the vendor's own exit + P&L.
    if (kind === "closed") {
      const c = parsePositionClosed(message);
      if (c) {
        const rows = await sql<Array<Record<string, unknown>>>`
          select id, key, side, contracts, sig_entry from exec_trades
           where status in ('placed','filled')
             and lower(side) = ${c.side}
             and contracts = ${c.qty}
             and day >= ${new Date(Date.now() - 2 * 24 * 3600_000).toISOString().slice(0, 10)}
           order by ts desc limit 5
        `;
        const match = rows.find((r) => {
          const e = Number(r.sig_entry);
          // the closed position's entry must be plausibly close to what
          // we placed (the alert carries the exit; our row has the signal)
          return Number.isFinite(e) && Math.abs(e - c.exitPrice) < 500;
        });
        if (match) {
          const entryPx = Number(match.sig_entry);
          const dir = c.side === "long" ? 1 : -1;
          const pts = (c.exitPrice - entryPx) * dir;
          const result = c.pnlUsd > 0 ? "win" : c.pnlUsd < 0 ? "loss" : "flat";
          const exitAction = c.side === "long" ? "Sell" : "Buy";
          await sql.unsafe(
            `update exec_trades set status = 'closed', exit_avg = ${c.exitPrice},
               pts = ${pts.toFixed(2)}, gross_usd = ${c.pnlUsd.toFixed(2)},
               net_usd = ${c.pnlUsd.toFixed(2)}, result = ${result},
               exit_fills = ${JSON.stringify([{ ts, action: exitAction, qty: c.qty, price: c.exitPrice }])}::jsonb,
               updated_at = now()
             where id = ${Number(match.id)}`,
          );
          console.log(`[xt-alerts] pushed close: ${match.key} → ${c.exitPrice} (${c.pnlUsd >= 0 ? "+" : "−"}$${Math.abs(c.pnlUsd).toFixed(2)})`);
        }
      }
    }
    if (kind === "opened") {
      const o = parsePositionOpened(message);
      if (o) console.log(`[xt-alerts] pushed open: ${o.side} ${o.qty} ${o.instrument} @ ${o.entryPrice} (${account})`);
    }
  } catch (e) {
    console.error("[xt-alerts] ingest failed:", (e as Error).message ?? e);
    return Response.json({ ok: false, error: "ingest failed" }, { status: 500 });
  }

  return Response.json({ ok: true, kind });
}
