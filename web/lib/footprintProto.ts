/* ------------------------------------------------------------------ *
 * Minimal protobuf wire-format decoder for GoCharting's FOOTPRINT/V2
 * response (gcdata/footprint.proto, package fpgc).
 *
 * The live dashboard needs to bootstrap the *in-progress* Globex session
 * so a container restart does not blank the candles since the 18:00 ET
 * reopen. FOOTPRINT/V2 serves that history, but only as protobuf — and
 * the web bundle has no protobuf runtime. Rather than pull a dependency,
 * we decode only the handful of fields the bootstrap consumes and skip
 * the rest. Values are all positive int64s well under 2^53, so JS numbers
 * are exact here.
 * ------------------------------------------------------------------ */

export type BootCandle = {
  /** ISO feed timestamp, e.g. "2026-09-27T17:00:00-05:00" (US Central). */
  t: string;
  /** bar high, in cents (÷100 for points). */
  high: number;
  /** bar low, in cents. */
  low: number;
  /** aggressive-buy volume for the minute. */
  buy: number;
  /** aggressive-sell volume for the minute. */
  sell: number;
  /** per-price footprint rows (price × 100 → buy/sell volumes) — the same
   *  clusters the archive and the backtests use. Absent when the feed
   *  returns no per-level data. */
  levels?: { level: number; buy: number; sell: number }[];
};

export type FootprintResponse = {
  requestDate?: string;
  session?: string;
  symbol?: string;
  isComplete?: boolean;
  candles: BootCandle[];
};

class Reader {
  private buf: Uint8Array;
  private off = 0;

  constructor(buf: Uint8Array) {
    this.buf = buf;
  }

  eof(): boolean {
    return this.off >= this.buf.length;
  }

  readVarint(): number {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (this.off >= this.buf.length) return result;
      const b = this.buf[this.off++];
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return result;
      shift += 7;
      if (shift > 56) return result;
    }
  }

  /** returns [fieldNumber, wireType] */
  readTag(): [number, number] {
    const tag = this.readVarint();
    return [tag >>> 3, tag & 7];
  }

  readBytes(): Uint8Array {
    const len = this.readVarint();
    const start = this.off;
    this.off = Math.min(this.off + len, this.buf.length);
    return this.buf.subarray(start, this.off);
  }

  readString(): string {
    return new TextDecoder().decode(this.readBytes());
  }

  skip(wire: number): void {
    if (wire === 0) this.readVarint();
    else if (wire === 1) this.off += 8;
    else if (wire === 2) this.readBytes();
    else if (wire === 5) this.off += 4;
    // wire 3 (group) / 4 (end-group) do not appear in this proto
  }
}

function decodeRequest(r: Reader): { date?: string; session?: string; symbol?: string } {
  const out: { date?: string; session?: string; symbol?: string } = {};
  while (!r.eof()) {
    const [field, wire] = r.readTag();
    if (field === 3 && wire === 2) out.symbol = r.readString();
    else if (field === 5 && wire === 2) out.session = r.readString();
    else if (field === 6 && wire === 2) out.date = r.readString();
    else r.skip(wire);
  }
  return out;
}

function decodeEndingSummary(r: Reader): { high: number; low: number } {
  let high = 0;
  let low = 0;
  while (!r.eof()) {
    const [field, wire] = r.readTag();
    if (field === 7 && wire === 0) high = r.readVarint();
    else if (field === 8 && wire === 0) low = r.readVarint();
    else r.skip(wire);
  }
  return { high, low };
}

function decodeCluster(r: Reader): { trades: number; volume: number } {
  let trades = 0;
  let volume = 0;
  while (!r.eof()) {
    const [field, wire] = r.readTag();
    if (field === 1 && wire === 0) trades = r.readVarint();
    else if (field === 2 && wire === 0) volume = r.readVarint();
    else r.skip(wire);
  }
  return { trades, volume };
}

function decodeLevels(r: Reader): { buy: number; sell: number } {
  let buy = 0;
  let sell = 0;
  while (!r.eof()) {
    const [field, wire] = r.readTag();
    if (field === 2 && wire === 2) buy = decodeCluster(new Reader(r.readBytes())).volume;
    else if (field === 3 && wire === 2) sell = decodeCluster(new Reader(r.readBytes())).volume;
    else r.skip(wire);
  }
  return { buy, sell };
}

function decodeFootprint(r: Reader): { level: number; buy: number; sell: number } {
  let level = 0;
  let buy = 0;
  let sell = 0;
  while (!r.eof()) {
    const [field, wire] = r.readTag();
    if (field === 1 && wire === 0) level = r.readVarint();
    else if (field === 2 && wire === 2) buy = decodeCluster(new Reader(r.readBytes())).volume;
    else if (field === 3 && wire === 2) sell = decodeCluster(new Reader(r.readBytes())).volume;
    else r.skip(wire);
  }
  return { level, buy, sell };
}

function decodeCandle(r: Reader): BootCandle | null {
  let t = "";
  let high = 0;
  let low = 0;
  let buy = 0;
  let sell = 0;
  const levels: { level: number; buy: number; sell: number }[] = [];
  while (!r.eof()) {
    const [field, wire] = r.readTag();
    if (field === 1 && wire === 2) t = r.readString();
    else if (field === 2 && wire === 2) {
      const es = decodeEndingSummary(new Reader(r.readBytes()));
      high = es.high;
      low = es.low;
    } else if (field === 3 && wire === 2) {
      const lv = decodeLevels(new Reader(r.readBytes()));
      buy = lv.buy;
      sell = lv.sell;
    } else if (field === 6 && wire === 2) {
      levels.push(decodeFootprint(new Reader(r.readBytes())));
    } else {
      r.skip(wire);
    }
  }
  if (!t) return null;
  return levels.length ? { t, high, low, buy, sell, levels } : { t, high, low, buy, sell };
}

export function decodeFootprintForDateResponse(buf: Uint8Array): FootprintResponse {
  const r = new Reader(buf);
  const out: FootprintResponse = { candles: [] };
  while (!r.eof()) {
    const [field, wire] = r.readTag();
    if (field === 1 && wire === 2) {
      const req = decodeRequest(new Reader(r.readBytes()));
      if (req.date) out.requestDate = req.date;
      if (req.session) out.session = req.session;
      if (req.symbol) out.symbol = req.symbol;
    } else if (field === 2 && wire === 2) {
      const c = decodeCandle(new Reader(r.readBytes()));
      if (c) out.candles.push(c);
    } else if (field === 4 && wire === 0) {
      out.isComplete = r.readVarint() !== 0;
    } else {
      r.skip(wire);
    }
  }
  return out;
}

/** Split a binary frame the way client.py does: [4B][1B len][text][protobuf]. */
export function splitFrame(b: Uint8Array): { header: string; body: Uint8Array } | null {
  if (b.length < 6) return null;
  const textLen = b[4];
  if (b.length < 5 + textLen) return null;
  return {
    header: new TextDecoder().decode(b.subarray(5, 5 + textLen)),
    body: b.subarray(5 + textLen),
  };
}
