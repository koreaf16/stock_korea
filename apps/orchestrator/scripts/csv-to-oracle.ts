import path from "node:path";
import { promises as fs } from "node:fs";
import oracledb from "oracledb";

type DailyRow = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type MinuteRow = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type EventType = "VOL_SPIKE" | "UP_BREAKOUT" | "DOWN_BREAKOUT";

type DailyEvent = {
  symbol: string;
  eventDate: string;
  eventType: EventType;
  score: number;
};

type PatternRow = {
  patternId: string;
  symbol: string;
  eventTs: string;
  eventDate: string;
  eventType: EventType;
  ohlvcJson: string;
  macroVector: string;
  microVector: string;
  futureRet1d: number | null;
};

const DAILY_DIR = path.resolve(process.cwd(), "data/zone3/raw/daily");
const MINUTE_DIR = path.resolve(process.cwd(), "data/zone3/raw/minutes");

const ORACLE_USER = String(process.env.ORACLE_USER ?? "").trim();
const ORACLE_PASSWORD = String(process.env.ORACLE_PASSWORD ?? "").trim();
const ORACLE_CONNECTION_STRING = String(process.env.ORACLE_CONNECTION_STRING ?? "").trim();

const MACRO_DIM = Math.max(64, Number(process.env.ZONE3_MACRO_DIM ?? 256));
const MICRO_DIM = Math.max(64, Number(process.env.ZONE3_MICRO_DIM ?? 256));
const BATCH_SIZE = Math.max(10, Number(process.env.ZONE3_CSV_LOAD_BATCH_SIZE ?? 100));
const SYMBOL_LIMIT = Math.max(1, Number(process.env.ZONE3_CSV_LOAD_SYMBOL_LIMIT ?? 999_999));

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;

function toNumber(v: string): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function parseCsvLines(raw: string): string[][] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => l.split(",").map((x) => x.trim()));
}

async function readDailyCsv(symbol: string): Promise<DailyRow[]> {
  const p = path.join(DAILY_DIR, `${symbol}.csv`);
  const raw = await fs.readFile(p, "utf8");
  const rows = parseCsvLines(raw);
  const header = rows.shift();
  if (!header) return [];
  const iDate = header.indexOf("Date");
  const iOpen = header.indexOf("Open");
  const iHigh = header.indexOf("High");
  const iLow = header.indexOf("Low");
  const iClose = header.indexOf("Close");
  const iVol = header.indexOf("Volume");
  if ([iDate, iOpen, iHigh, iLow, iClose, iVol].some((idx) => idx < 0)) return [];

  return rows
    .map((r) => ({
      date: r[iDate],
      open: toNumber(r[iOpen]),
      high: toNumber(r[iHigh]),
      low: toNumber(r[iLow]),
      close: toNumber(r[iClose]),
      volume: toNumber(r[iVol]),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function readMinuteCsv(symbol: string): Promise<MinuteRow[]> {
  const p = path.join(MINUTE_DIR, `${symbol}.csv`);
  const raw = await fs.readFile(p, "utf8");
  const rows = parseCsvLines(raw);
  const header = rows.shift();
  if (!header) return [];
  const iTs = header.indexOf("timestamp");
  const iOpen = header.indexOf("open");
  const iHigh = header.indexOf("high");
  const iLow = header.indexOf("low");
  const iClose = header.indexOf("close");
  const iVol = header.indexOf("volume");
  if ([iTs, iOpen, iHigh, iLow, iClose, iVol].some((idx) => idx < 0)) return [];

  return rows
    .map((r) => ({
      timestamp: r[iTs],
      open: toNumber(r[iOpen]),
      high: toNumber(r[iHigh]),
      low: toNumber(r[iLow]),
      close: toNumber(r[iClose]),
      volume: toNumber(r[iVol]),
    }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function extractDailyEvents(symbol: string, daily: DailyRow[]): DailyEvent[] {
  const out: DailyEvent[] = [];
  for (let i = 20; i < daily.length; i += 1) {
    const prev = daily[i - 1];
    const cur = daily[i];
    if (!prev || prev.close <= 0) continue;

    const vol20 = avg(daily.slice(i - 20, i).map((d) => d.volume));
    const volSpike = vol20 > 0 ? cur.volume / vol20 : 0;
    const upPct = ((cur.high - prev.close) / prev.close) * 100;
    const downPct = ((cur.low - prev.close) / prev.close) * 100;
    const priceMove = Math.max(Math.abs(upPct), Math.abs(downPct));

    if (volSpike >= 5) {
      out.push({ symbol, eventDate: cur.date, eventType: "VOL_SPIKE", score: volSpike });
    }
    if (upPct >= 15) {
      out.push({ symbol, eventDate: cur.date, eventType: "UP_BREAKOUT", score: upPct });
    }
    if (downPct <= -15) {
      out.push({ symbol, eventDate: cur.date, eventType: "DOWN_BREAKOUT", score: Math.abs(downPct) });
    } else if (priceMove >= 15 && upPct < 15) {
      out.push({ symbol, eventDate: cur.date, eventType: "DOWN_BREAKOUT", score: priceMove });
    }
  }

  const uniq = new Map<string, DailyEvent>();
  for (const e of out) {
    const key = `${e.symbol}_${e.eventDate}_${e.eventType}`;
    if (!uniq.has(key) || (uniq.get(key)?.score ?? 0) < e.score) {
      uniq.set(key, e);
    }
  }
  return Array.from(uniq.values()).sort((a, b) => a.eventDate.localeCompare(b.eventDate));
}

function normalize(arr: number[]): number[] {
  if (arr.length === 0) return [];
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  if (Math.abs(max - min) < 1e-9) return arr.map(() => 0);
  return arr.map((v) => (v - min) / (max - min));
}

function resample(arr: number[], dim: number): number[] {
  if (arr.length === 0) return new Array(dim).fill(0);
  if (arr.length === dim) return arr;
  const out = new Array<number>(dim).fill(0);
  const denom = Math.max(1, dim - 1);
  for (let i = 0; i < dim; i += 1) {
    const pos = (i / denom) * (arr.length - 1);
    const left = Math.floor(pos);
    const right = Math.min(arr.length - 1, left + 1);
    const t = pos - left;
    out[i] = arr[left] * (1 - t) + arr[right] * t;
  }
  return out;
}

function toVectorString(vec: number[]): string {
  return `[${vec.map((v) => Number(v.toFixed(8))).join(",")}]`;
}

function buildMacroVector(daily: DailyRow[], eventIdx: number): string {
  const start = Math.max(1, eventIdx - 60);
  const base = daily.slice(start, eventIdx + 1);
  const rets: number[] = [];
  const vols: number[] = [];
  for (let i = 1; i < base.length; i += 1) {
    const prev = base[i - 1];
    const cur = base[i];
    const ret = prev.close > 0 ? (cur.close - prev.close) / prev.close : 0;
    rets.push(ret);
    vols.push(cur.volume);
  }
  const feature = [...normalize(rets), ...normalize(vols)];
  return toVectorString(resample(feature, MACRO_DIM));
}

function buildMicroWindow(minute: MinuteRow[], eventDate: string, eventType: EventType): MinuteRow[] {
  const dayRows = minute.filter((r) => r.timestamp.slice(0, 10) === eventDate);
  if (dayRows.length === 0) return [];
  let idx = 0;
  if (eventType === "UP_BREAKOUT") {
    idx = dayRows.reduce((best, cur, i, arr) => (cur.high > arr[best].high ? i : best), 0);
  } else if (eventType === "DOWN_BREAKOUT") {
    idx = dayRows.reduce((best, cur, i, arr) => (cur.low < arr[best].low ? i : best), 0);
  } else {
    idx = dayRows.reduce((best, cur, i, arr) => (cur.volume > arr[best].volume ? i : best), 0);
  }
  const from = Math.max(0, idx - 30);
  const to = Math.min(dayRows.length, idx + 31);
  return dayRows.slice(from, to);
}

function buildMicroVector(window: MinuteRow[]): string {
  if (window.length === 0) return toVectorString(new Array(MICRO_DIM).fill(0));
  const close = normalize(window.map((r) => r.close));
  const high = normalize(window.map((r) => r.high));
  const low = normalize(window.map((r) => r.low));
  const volume = normalize(window.map((r) => r.volume));
  const feature = [...close, ...high, ...low, ...volume];
  return toVectorString(resample(feature, MICRO_DIM));
}

function calcFutureRet1d(daily: DailyRow[], eventDate: string): number | null {
  const idx = daily.findIndex((d) => d.date === eventDate);
  if (idx < 0 || idx + 1 >= daily.length) return null;
  const cur = daily[idx];
  const next = daily[idx + 1];
  if (cur.close <= 0) return null;
  return ((next.close - cur.close) / cur.close) * 100;
}

function asEventTs(eventDate: string, window: MinuteRow[]): string {
  if (window.length === 0) return `${eventDate}T15:30:00`;
  const mid = window[Math.floor(window.length / 2)]?.timestamp ?? `${eventDate}T15:30:00`;
  return mid.length === 19 ? mid : `${eventDate}T15:30:00`;
}

async function listSymbols(): Promise<string[]> {
  const entries = await fs.readdir(MINUTE_DIR, { withFileTypes: true });
  const symbols = entries
    .filter((e) => e.isFile() && e.name.endsWith(".csv"))
    .map((e) => e.name.replace(/\.csv$/i, "").toUpperCase())
    .filter((s) => /^[A-Z0-9]{6}$/.test(s));
  return symbols.sort().slice(0, SYMBOL_LIMIT);
}

function toPatternRows(symbol: string, daily: DailyRow[], minute: MinuteRow[]): PatternRow[] {
  const events = extractDailyEvents(symbol, daily);
  const out: PatternRow[] = [];
  let seq = 0;
  for (const e of events) {
    const eventIdx = daily.findIndex((d) => d.date === e.eventDate);
    if (eventIdx < 1) continue;
    const microWindow = buildMicroWindow(minute, e.eventDate, e.eventType);
    if (microWindow.length < 10) continue;

    seq += 1;
    const patternId = `${symbol}_${e.eventDate.replaceAll("-", "")}_${e.eventType}_${String(seq).padStart(3, "0")}`;
    out.push({
      patternId,
      symbol,
      eventTs: asEventTs(e.eventDate, microWindow),
      eventDate: e.eventDate,
      eventType: e.eventType,
      ohlvcJson: JSON.stringify(microWindow),
      macroVector: buildMacroVector(daily, eventIdx),
      microVector: buildMicroVector(microWindow),
      futureRet1d: calcFutureRet1d(daily, e.eventDate),
    });
  }
  return out;
}

async function upsertBatch(conn: oracledb.Connection, batch: PatternRow[]): Promise<number> {
  if (batch.length === 0) return 0;
  const sql = `
    merge into TB_ZONE3_PATTERN_LIBRARY tgt
    using (
      select
        :pattern_id as pattern_id,
        :symbol as symbol,
        to_timestamp(:event_ts, 'YYYY-MM-DD"T"HH24:MI:SS') as event_ts,
        to_date(:event_date, 'YYYY-MM-DD') as event_date,
        :event_type as event_type,
        :ohlvc_json as ohlvc_json,
        to_vector(:macro_vector) as macro_vector,
        to_vector(:micro_vector) as micro_vector,
        :future_ret_1d as future_ret_1d
      from dual
    ) src
    on (tgt.pattern_id = src.pattern_id)
    when matched then update set
      tgt.symbol = src.symbol,
      tgt.event_ts = src.event_ts,
      tgt.event_date = src.event_date,
      tgt.event_type = src.event_type,
      tgt.ohlvc_json = src.ohlvc_json,
      tgt.macro_vector = src.macro_vector,
      tgt.micro_vector = src.micro_vector,
      tgt.future_ret_1d = src.future_ret_1d,
      tgt.updated_at = systimestamp
    when not matched then insert (
      pattern_id, symbol, event_ts, event_date, event_type, ohlvc_json,
      macro_vector, micro_vector, future_ret_1d, created_at, updated_at
    ) values (
      src.pattern_id, src.symbol, src.event_ts, src.event_date, src.event_type, src.ohlvc_json,
      src.macro_vector, src.micro_vector, src.future_ret_1d, systimestamp, systimestamp
    )
  `;

  const binds = batch.map((r) => ({
    pattern_id: r.patternId,
    symbol: r.symbol,
    event_ts: r.eventTs,
    event_date: r.eventDate,
    event_type: r.eventType,
    ohlvc_json: r.ohlvcJson,
    macro_vector: r.macroVector,
    micro_vector: r.microVector,
    future_ret_1d: r.futureRet1d,
  }));

  await conn.executeMany(sql, binds, { autoCommit: false, batchErrors: true });
  await conn.commit();
  return batch.length;
}

async function main(): Promise<void> {
  if (!ORACLE_USER || !ORACLE_PASSWORD || !ORACLE_CONNECTION_STRING) {
    throw new Error("ORACLE_USER / ORACLE_PASSWORD / ORACLE_CONNECTION_STRING are required");
  }

  const symbols = await listSymbols();
  console.log(`[INFO] load symbols=${symbols.length}`);

  const conn = await oracledb.getConnection({
    user: ORACLE_USER,
    password: ORACLE_PASSWORD,
    connectString: ORACLE_CONNECTION_STRING,
  });

  let totalGenerated = 0;
  let totalLoaded = 0;
  let batch: PatternRow[] = [];

  try {
    for (const symbol of symbols) {
      try {
        const [daily, minute] = await Promise.all([readDailyCsv(symbol), readMinuteCsv(symbol)]);
        if (daily.length < 30 || minute.length < 60) continue;
        const rows = toPatternRows(symbol, daily, minute);
        totalGenerated += rows.length;
        batch.push(...rows);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[WARN] symbol=${symbol} parse/load failed: ${message}`);
      }

      if (batch.length >= BATCH_SIZE) {
        totalLoaded += await upsertBatch(conn, batch);
        console.log(`[INFO] upsert batch=${batch.length} totalLoaded=${totalLoaded}`);
        batch = [];
      }
    }

    if (batch.length > 0) {
      totalLoaded += await upsertBatch(conn, batch);
      console.log(`[INFO] upsert batch=${batch.length} totalLoaded=${totalLoaded}`);
      batch = [];
    }
  } finally {
    await conn.close();
  }

  console.log(`[INFO] done generated=${totalGenerated} loaded=${totalLoaded}`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[ERR] ${message}`);
  process.exitCode = 1;
});
