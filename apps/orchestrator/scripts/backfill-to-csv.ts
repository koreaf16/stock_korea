import axios from "axios";
import * as cheerio from "cheerio";
import path from "node:path";
import { promises as fs } from "node:fs";

type ListedSymbol = {
  symbol: string;
  name: string;
  market: "KOSPI" | "KOSDAQ";
};

type MinuteRow = {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

const KIS_REST_URL = String(process.env.KIS_REST_URL ?? "").trim().replace(/\/+$/, "");
const KIS_APP_KEY = String(process.env.KIS_APP_KEY ?? "").trim();
const KIS_APP_SECRET = String(process.env.KIS_APP_SECRET ?? "").trim();
const MARKET_CODE = String(process.env.ZONE3_KIS_MARKET_CODE ?? "J").trim();

const RAW_MINUTE_DIR = path.resolve(process.cwd(), "data/zone3/raw/minutes");
const MAX_RETRY = Math.max(1, Number(process.env.ZONE3_BACKFILL_RETRY ?? 3));
const TPS = Math.max(1, Number(process.env.ZONE3_BACKFILL_TPS ?? 5)); // 5~10 권장
const CONCURRENCY = Math.max(1, Number(process.env.ZONE3_BACKFILL_CONCURRENCY ?? 4));
const BACKFILL_DAYS = Math.max(30, Number(process.env.ZONE3_BACKFILL_DAYS ?? 365));
const REQUEST_TIMEOUT_MS = Math.max(3_000, Number(process.env.ZONE3_BACKFILL_TIMEOUT_MS ?? 15_000));
const SKIP_IF_EXISTS = String(process.env.ZONE3_BACKFILL_SKIP_IF_EXISTS ?? "true").toLowerCase() !== "false";
const TOKEN_SKEW_MS = 60_000;
const TR_ID = "FHKST03010230"; // 주식일별분봉조회

let tokenCache: { accessToken: string; expireAt: number } | null = null;
let tokenInFlight: Promise<string> | null = null;

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pLimit(concurrency: number) {
  let activeCount = 0;
  const queue: Array<() => void> = [];

  const next = () => {
    activeCount -= 1;
    const run = queue.shift();
    if (run) run();
  };

  return async <T>(fn: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        activeCount += 1;
        void fn()
          .then(resolve, reject)
          .finally(next);
      };

      if (activeCount < concurrency) run();
      else queue.push(run);
    });
}

function createTpsScheduler(tps: number) {
  const intervalMs = Math.ceil(1000 / tps);
  let nextAvailableAt = 0;
  let chain = Promise.resolve();

  return async <T>(work: () => Promise<T>): Promise<T> => {
    let waitMs = 0;
    chain = chain.then(async () => {
      const now = Date.now();
      const scheduledAt = Math.max(now, nextAvailableAt);
      waitMs = Math.max(0, scheduledAt - now);
      nextAvailableAt = scheduledAt + intervalMs;
    });
    await chain;
    if (waitMs > 0) await sleep(waitMs);
    return work();
  };
}

async function retry<T>(label: string, work: () => Promise<T>, maxRetry: number): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxRetry; attempt += 1) {
    try {
      return await work();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxRetry) break;
      const waitMs = 1000 * Math.min(10, 2 ** (attempt - 1));
      log(`[WARN] [retry] ${label} attempt=${attempt}/${maxRetry} wait=${waitMs}ms`);
      await sleep(waitMs);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function fetchKrxSymbols(): Promise<ListedSymbol[]> {
  const markets: Array<{ key: string; market: "KOSPI" | "KOSDAQ" }> = [
    { key: "stockMkt", market: "KOSPI" },
    { key: "kosdaqMkt", market: "KOSDAQ" },
  ];

  const out: ListedSymbol[] = [];

  for (const m of markets) {
    const url = `https://kind.krx.co.kr/corpgeneral/corpList.do?method=download&marketType=${m.key}`;
    const { data } = await axios.get<string>(url, { timeout: REQUEST_TIMEOUT_MS });
    const $ = cheerio.load(data);
    $("table tr").each((_i, tr) => {
      const tds = $(tr).find("td");
      if (tds.length < 2) return;
      const name = $(tds[0]).text().trim();
      const codeRaw = $(tds[1]).text().trim();
      if (!name || !codeRaw) return;
      const symbol = codeRaw.padStart(6, "0").toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(symbol)) return;
      out.push({ symbol, name, market: m.market });
    });
  }

  const uniq = new Map<string, ListedSymbol>();
  for (const row of out) {
    if (!uniq.has(row.symbol)) uniq.set(row.symbol, row);
  }
  return Array.from(uniq.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
}

async function getAccessToken(): Promise<string> {
  const now = Date.now();
  if (tokenCache && now + TOKEN_SKEW_MS < tokenCache.expireAt) return tokenCache.accessToken;
  if (tokenInFlight) return tokenInFlight;

  tokenInFlight = (async () => {
    const url = `${KIS_REST_URL}/oauth2/tokenP`;
    const { data } = await axios.post(
      url,
      {
        grant_type: "client_credentials",
        appkey: KIS_APP_KEY,
        appsecret: KIS_APP_SECRET,
      },
      { timeout: REQUEST_TIMEOUT_MS },
    );

    const accessToken = String(data?.access_token ?? "").trim();
    const expiresInSec = Number(data?.expires_in ?? 3600);
    if (!accessToken) throw new Error("KIS token empty");

    tokenCache = {
      accessToken,
      expireAt: Date.now() + Math.max(60, expiresInSec) * 1000,
    };
    return accessToken;
  })().finally(() => {
    tokenInFlight = null;
  });

  return tokenInFlight;
}

function toNumber(v: unknown): number {
  const n = Number(String(v ?? "0").replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : 0;
}

function yyyyMMdd(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}${m}${day}`;
}

function enumerateWeekdays(from: Date, to: Date): Date[] {
  const out: Date[] = [];
  const cursor = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  while (cursor <= to) {
    const w = cursor.getDay();
    if (w !== 0 && w !== 6) out.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

async function fetchMinuteByDay(symbol: string, date: Date): Promise<MinuteRow[]> {
  const token = await getAccessToken();
  const params = {
    FID_ETC_CLS_CODE: "",
    FID_COND_MRKT_DIV_CODE: MARKET_CODE,
    FID_INPUT_ISCD: symbol,
    FID_INPUT_DATE_1: yyyyMMdd(date),
    FID_INPUT_HOUR_1: "153000",
    FID_PW_DATA_INCU_YN: "Y",
  };

  const { data } = await axios.get(`${KIS_REST_URL}/uapi/domestic-stock/v1/quotations/inquire-time-dailychartprice`, {
    timeout: REQUEST_TIMEOUT_MS,
    params,
    headers: {
      authorization: `Bearer ${token}`,
      appkey: KIS_APP_KEY,
      appsecret: KIS_APP_SECRET,
      tr_id: TR_ID,
      custtype: "P",
    },
  });

  const rows = Array.isArray(data?.output2) ? data.output2 : Array.isArray(data?.output) ? data.output : [];
  const out: MinuteRow[] = [];
  for (const r of rows) {
    const d = String(r?.stck_bsop_date ?? "").trim();
    const t = String(r?.stck_cntg_hour ?? "").trim().slice(0, 6);
    if (d.length !== 8 || t.length !== 6) continue;
    const timestamp = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`;
    out.push({
      timestamp,
      open: toNumber(r?.stck_oprc),
      high: toNumber(r?.stck_hgpr),
      low: toNumber(r?.stck_lwpr),
      close: toNumber(r?.stck_prpr),
      volume: toNumber(r?.cntg_vol),
    });
  }
  return out;
}

function toCsv(rows: MinuteRow[]): string {
  const lines = ["timestamp,open,high,low,close,volume"];
  for (const r of rows) {
    lines.push([r.timestamp, r.open, r.high, r.low, r.close, r.volume].join(","));
  }
  return `${lines.join("\n")}\n`;
}

async function collectSymbol(
  symbolInfo: ListedSymbol,
  schedule: <T>(work: () => Promise<T>) => Promise<T>,
  days: Date[],
): Promise<void> {
  const symbol = symbolInfo.symbol;
  const filePath = path.join(RAW_MINUTE_DIR, `${symbol}.csv`);

  if (SKIP_IF_EXISTS) {
    try {
      await fs.access(filePath);
      log(`[INFO] [checkpoint] ${symbol} already exists, skip`);
      return;
    } catch {
      // ignore
    }
  }

  const allRows: MinuteRow[] = [];
  for (const d of days) {
    const label = `kis:minute:${symbol}:${yyyyMMdd(d)}`;
    try {
      const dayRows = await retry(label, () => schedule(() => fetchMinuteByDay(symbol, d)), MAX_RETRY);
      if (dayRows.length > 0) allRows.push(...dayRows);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[WARN] [${symbol}] ${yyyyMMdd(d)} minute fetch failed: ${message}`);
    }
  }

  allRows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const dedup = new Map<string, MinuteRow>();
  for (const row of allRows) {
    if (!dedup.has(row.timestamp)) dedup.set(row.timestamp, row);
  }
  const merged = Array.from(dedup.values());

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, toCsv(merged), "utf8");
  log(`[INFO] [saved] ${symbol} ${symbolInfo.name} rows=${merged.length} path=${filePath}`);
}

async function main(): Promise<void> {
  if (!KIS_REST_URL || !KIS_APP_KEY || !KIS_APP_SECRET) {
    throw new Error("KIS_REST_URL/KIS_APP_KEY/KIS_APP_SECRET must be configured");
  }

  await fs.mkdir(RAW_MINUTE_DIR, { recursive: true });
  const allSymbols = await fetchKrxSymbols();
  const limit = Number(process.env.ZONE3_BACKFILL_SYMBOL_LIMIT ?? allSymbols.length);
  const symbols = allSymbols.slice(0, Math.max(1, limit));

  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - BACKFILL_DAYS);
  const days = enumerateWeekdays(start, end);

  log(`[INFO] symbols=${symbols.length} days=${days.length} tps=${TPS} concurrency=${CONCURRENCY}`);

  const schedule = createTpsScheduler(TPS);
  const limitRun = pLimit(CONCURRENCY);

  let done = 0;
  await Promise.all(
    symbols.map((s) =>
      limitRun(async () => {
        await collectSymbol(s, schedule, days);
        done += 1;
        log(`[INFO] progress ${done}/${symbols.length}`);
      }),
    ),
  );

  log("[INFO] backfill completed");
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  log(`[ERR] ${message}`);
  process.exitCode = 1;
});
