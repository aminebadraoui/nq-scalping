-- ---------------------------------------------------------------------------
-- NQ scalping historical store (Neon Postgres).
-- One database for everything the collector produces, raw AND derived, so a
-- future backtest engine never has to re-parse the feed:
--   · candles_1m      — the bar series (OHLCV + aggressor buy/sell)
--   · footprint_ticks — the per-tick bid x ask clusters (microstructure gold)
--   · profile_sheets  — the daily P0–P5 level sheets
--   · events          — every detected event (divergence, absorption, …)
--   · sessions        — what has been ingested, for integrity checks
-- `ts` is always the absolute UTC minute (parsed from the feed's ISO stamp),
-- so sessions that cross midnight (ETH 18:00 -> 17:00) sort correctly.
-- ---------------------------------------------------------------------------

create table if not exists meta (
  key   text primary key,
  value text not null
);
insert into meta (key, value) values ('schema_version', '1')
on conflict (key) do nothing;

-- ---------- 1-minute bars ------------------------------------------------
create table if not exists candles_1m (
  ts      timestamptz not null,           -- absolute UTC minute (canonical key)
  date    date        not null,           -- the session/dataset date (New York calendar of the session end)
  session text        not null check (session in ('RTH','ETH')),
  o       numeric(10,2),
  h       numeric(10,2) not null,
  l       numeric(10,2) not null,
  c       numeric(10,2),
  v       bigint      not null,           -- volume, contracts
  buy     bigint      not null,           -- volume traded at the ask
  sell    bigint      not null,           -- volume traded at the bid
  primary key (ts, session)
);
create index if not exists candles_date_session_idx on candles_1m (date, session, ts);
create index if not exists candles_ts_idx on candles_1m (ts);

-- ---------- per-tick footprint clusters -----------------------------------
create table if not exists footprint_ticks (
  ts          timestamptz not null,
  date        date        not null,
  session     text        not null,
  price_cents int         not null,       -- price x 100 (tick = 25 cents)
  buy         bigint      not null default 0,
  sell        bigint      not null default 0,
  buy_trades  bigint      not null default 0,
  sell_trades bigint      not null default 0,
  primary key (ts, session, price_cents)
);
create index if not exists footprint_ticks_ts_idx on footprint_ticks (ts);
create index if not exists footprint_ticks_date_idx on footprint_ticks (date, session);
create index if not exists footprint_price_idx on footprint_ticks (price_cents, ts);

-- ---------- daily profile level sheets (P0–P5) ------------------------------
create table if not exists profile_sheets (
  date        date   not null,
  profile     text   not null,            -- P0_developing_rth … P5_5day_composite
  payload     jsonb  not null,            -- full sheet entry: POC/VAH/VAL/LVNs/rows/total
  computed_at timestamptz not null default now(),
  primary key (date, profile)
);

-- ---------- detected events -------------------------------------------------
-- One row per event, exactly as the analysis pipeline emits it. Idempotent via
-- the unique index; payload carries the free-form message / side / deltaPct.
create table if not exists events (
  id      bigint generated always as identity primary key,
  ts      timestamptz not null,
  date    date        not null,
  session text        not null,
  kind    text        not null,           -- DIVERGENCE_D2 | ABSORPTION | RECLAIM | …
  price   numeric(10,2) not null default 0,
  bias    text,                           -- bull | bear | null
  payload jsonb       not null default '{}',
  unique (ts, session, kind, price)
);
create index if not exists events_kind_date_idx on events (kind, date);

-- ---------- ingestion log ----------------------------------------------------
create table if not exists sessions (
  date        date   not null,
  session     text   not null,
  candles     int    not null,
  ticks       int    not null,
  first_ts    timestamptz,
  last_ts     timestamptz,
  ingested_at timestamptz not null default now(),
  primary key (date, session)
);

-- ---------- signal push history (Telegram trade cards) ------------------------
-- One row per push emitted by the always-on signal feed (lib/signalFeed.ts),
-- so the dashboard has a durable history of every alert sent to Telegram.
-- Written at runtime (lib/signalHistory.ts, best-effort); mirrored here so a
-- fresh Neon project is complete after the standard ingest bootstrap.
create table if not exists signals (
  id       bigint generated always as identity primary key,
  key      text unique not null,
  ts       bigint not null,
  day      text not null,
  time_et  text not null default '',
  symbol   text not null,
  side     text not null,
  price    numeric(10,2) not null default 0,
  entry    text not null default '',
  stop     text not null default '',
  target   text not null default '',
  verdict  text not null default '',
  headline text not null default '',
  source   text not null default 'live',
  test     boolean not null default false,
  sent     boolean not null default false,
  reason   text not null default ''
);
create index if not exists signals_ts_idx on signals (ts desc);
