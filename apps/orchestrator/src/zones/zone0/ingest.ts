import { EventEmitter } from "node:events";

import type { GlobalMacroContext, Zone0Tick } from "@stock/contracts";
import axios from "axios";
import { load as loadHtml } from "cheerio";

import { clamp, nowIso, shortId } from "../../utils.js";
import { DartDisclosureClient, type DartImpactDisclosure } from "./dart-disclosure-client.js";
import { runWithRetry } from "./http-retry.js";
import { KisWebSocketClient, type KisOrderBook } from "./kis-websocket.js";
import { MacroContextClient } from "./macro-context-client.js";
import { MarketFlowClient } from "./market-flow-client.js";
import { NaverNewsClient } from "./naver-news-client.js";

const DEFAULT_SYMBOL = sanitizeSymbol(process.env.ZONE0_TARGET_SYMBOL ?? "005930");
const MAX_BUFFER_SIZE = Math.max(100, Number(process.env.ZONE0_BUFFER_SIZE ?? 600));
const MAX_FRAME_QUEUE_SIZE = Math.max(10, Number(process.env.ZONE0_FRAME_QUEUE_SIZE ?? 3_000));
const EXTERNAL_POLL_MS = clamp(Number(process.env.ZONE0_EXTERNAL_POLL_MS ?? 60_000), 60_000, 300_000);
const DEFAULT_BOARD_POLL_MS = 20_000;
const MIN_BOARD_POLL_MS = 10_000;
const MAX_BOARD_POLL_MS = 60_000;
const MARKET_FLOW_POLL_MS = clamp(Number(process.env.ZONE0_MARKET_FLOW_POLL_MS ?? 60_000), 30_000, 300_000);
const MACRO_POLL_MS = clamp(Number(process.env.ZONE0_MACRO_POLL_MS ?? 1_800_000), 300_000, 3_600_000);
const SYMBOL_POOL_REFRESH_MS = clamp(Number(process.env.ZONE0_SYMBOL_POOL_REFRESH_MS ?? 60_000), 30_000, 300_000);
const SYMBOL_POOL_SIZE = clamp(Number(process.env.ZONE0_SYMBOL_POOL_SIZE ?? 12), 5, 20);
const SEEN_KEY_LIMIT = Math.max(1_000, Number(process.env.ZONE0_SEEN_KEY_LIMIT ?? 20_000));
const NAVER_REQUEST_TIMEOUT_MS = Math.max(2_000, Number(process.env.ZONE0_NAVER_TIMEOUT_MS ?? 8_000));
const KIS_HOTLIST_TIMEOUT_MS = Math.max(2_000, Number(process.env.ZONE0_KIS_HOTLIST_TIMEOUT_MS ?? 10_000));
const SYMBOL_DISCOVERY_ENABLED = parseBool(process.env.ZONE0_SYMBOL_DISCOVERY_ENABLED, true);
const KIS_REST_URL = String(process.env.KIS_REST_URL ?? "").trim();
const KIS_APP_KEY = String(process.env.KIS_APP_KEY ?? "").trim();
const KIS_APP_SECRET = String(process.env.KIS_APP_SECRET ?? "").trim();
const KIS_TOKEN_PATH = "/oauth2/tokenP";
const KIS_HOTLIST_PATH = String(process.env.ZONE0_KIS_HOTLIST_PATH ?? "/uapi/domestic-stock/v1/quotations/volume-rank").trim();
const KIS_HOTLIST_TR_ID = String(process.env.ZONE0_KIS_HOTLIST_TR_ID ?? "FHPST01710000").trim();
const KIS_HOTLIST_MARKET_DIV = String(process.env.ZONE0_KIS_HOTLIST_MARKET_DIV ?? "J").trim();
const KIS_HOTLIST_SCREEN_DIV = String(process.env.ZONE0_KIS_HOTLIST_SCREEN_DIV ?? "20171").trim();
const KIS_HOTLIST_INPUT_ISCD = String(process.env.ZONE0_KIS_HOTLIST_INPUT_ISCD ?? "0000").trim();
const KIS_HOTLIST_DIV_CLS_CODE = String(process.env.ZONE0_KIS_HOTLIST_DIV_CLS_CODE ?? "0").trim();
const KIS_HOTLIST_BLNG_CLS_CODE = String(process.env.ZONE0_KIS_HOTLIST_BLNG_CLS_CODE ?? "0").trim();
const KIS_HOTLIST_TRGT_CLS_CODE = String(process.env.ZONE0_KIS_HOTLIST_TRGT_CLS_CODE ?? "111111111").trim();
const KIS_HOTLIST_TRGT_EXLS_CLS_CODE = String(process.env.ZONE0_KIS_HOTLIST_TRGT_EXLS_CLS_CODE ?? "0000000000").trim();
const KIS_HOTLIST_INPUT_PRICE_1 = String(process.env.ZONE0_KIS_HOTLIST_INPUT_PRICE_1 ?? "").trim();
const KIS_HOTLIST_INPUT_PRICE_2 = String(process.env.ZONE0_KIS_HOTLIST_INPUT_PRICE_2 ?? "").trim();
const KIS_HOTLIST_VOL_CNT = String(process.env.ZONE0_KIS_HOTLIST_VOL_CNT ?? "").trim();
const KIS_HOTLIST_INPUT_DATE_1 = String(process.env.ZONE0_KIS_HOTLIST_INPUT_DATE_1 ?? "").trim();
const KIS_TOKEN_SKEW_MS = 60_000;

const HOT_SYMBOL_FIELD_KEYS = [
  "mksc_shrn_iscd",
  "stck_shrn_iscd",
  "isu_cd",
  "ISU_CD",
  "pdno",
  "item_code",
  "symbol",
  "code",
  "stck_cd",
  "종목코드"
];

interface KisAccessTokenResponse {
  access_token?: string;
  expires_in?: number | string;
}

interface NaverOpenTalkChannelInfoResponse {
  result?: unknown;
}

interface NaverOpenTalkRecentMessagesResponse {
  result?: unknown;
}

interface NaverOpenTalkMessage {
  content: string;
  nickname: string;
  createTimeRaw: string;
  timestamp: string;
}

const NAVER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Referer: "https://finance.naver.com/"
};
const NAVER_MOBILE_HEADERS = {
  ...NAVER_HEADERS,
  Referer: "https://m.stock.naver.com/"
};
const NAVER_OPENTALK_BASE_URL = "https://m.stock.naver.com/front-api/opentalk";
const BOARD_TITLE_MAX_LENGTH = 88;

const POSITIVE_HINTS = ["상승", "강세", "매수", "급등", "호재", "돌파", "수주", "확대", "회복", "신고가"];
const NEGATIVE_HINTS = ["하락", "약세", "매도", "급락", "악재", "경고", "축소", "우려", "불안", "루머"];
const TELEGRAM_TEXT_KEYS = ["message", "text", "content", "caption", "body", "raw_text", "rawText"];
const TELEGRAM_SYMBOL_KEYS = ["symbol", "ticker", "code", "stockCode", "stock_code", "itemCode", "item_code"];
const TELEGRAM_PRIORITY_KEYS = ["priority", "level", "importance", "urgency"];
const TELEGRAM_SENTIMENT_KEYS = ["sentimentHint", "sentiment", "score", "sentiment_score"];
const TELEGRAM_TIMESTAMP_KEYS = ["timestamp", "ts", "createdAt", "created_at", "date", "eventTime", "event_time"];

export type Zone0Source =
  | "KIS_H0STCNT0"
  | "KIS_H0STASP0"
  | "NAVER_NEWS"
  | "NAVER_BOARD"
  | "DART_DISCLOSURE"
  | "MARKET_FUNDAMENTAL"
  | "GLOBAL_MACRO"
  | "TELEGRAM";
export type Zone0TelegramPriority = "LOW" | "MEDIUM" | "HIGH";

export interface Zone0OrderBookLevel {
  price: number;
  qty: number;
}

export interface Zone0OrderBook {
  symbol: string;
  asks: Zone0OrderBookLevel[];
  bids: Zone0OrderBookLevel[];
  totalAskDepth: number;
  totalBidDepth: number;
  source: "KIS_H0STASP0";
  timestamp: string;
}

export interface Zone0NewsItem {
  id: string;
  symbol: string;
  headline: string;
  body: string;
  newsUrl?: string;
  keywordHint?: string;
  sourceClass?: "ECONOMIC_PRESS" | "DISCLOSURE" | "RUMOR";
  sentimentHint: number;
  source: "NAVER_NEWS";
  timestamp: string;
}

export interface Zone0BoardPost {
  id: string;
  symbol: string;
  title: string;
  content: string;
  sentimentHint: number;
  source: "NAVER_BOARD";
  timestamp: string;
}

export interface Zone0DartDisclosure {
  id: string;
  symbol: string;
  corpCode: string;
  corpName: string;
  reportName: string;
  receiptNo: string;
  receiptDate: string;
  link: string;
  impactKeywords: string[];
  impactScore: number;
  sentimentHint: number;
  source: "DART_DISCLOSURE";
  timestamp: string;
}

export interface Zone0Fundamental {
  symbol: string;
  foreignNetBuyQty: number;
  institutionalNetBuyQty: number;
  shortBalanceQty: number;
  source: "KOSCOM" | "KRX";
  timestamp: string;
}

export interface Zone0TelegramMessage {
  id: string;
  symbol: string;
  message: string;
  sentimentHint: number;
  priority: Zone0TelegramPriority;
  source: "TELEGRAM";
  timestamp: string;
}

export interface Zone0TelegramWebhookPayload {
  symbol?: unknown;
  message?: unknown;
  text?: unknown;
  priority?: unknown;
  sentimentHint?: unknown;
  [key: string]: unknown;
}

export interface Zone0SentimentPulse {
  score: number;
  velocity: number;
  signalCount: number;
}

export interface Zone0Frame {
  tick: Zone0Tick;
  orderBook: Zone0OrderBook;
  newsItems: Zone0NewsItem[];
  boardPosts: Zone0BoardPost[];
  dartDisclosures: Zone0DartDisclosure[];
  fundamentalData: Zone0Fundamental[];
  globalContext: GlobalMacroContext | null;
  telegramMessages: Zone0TelegramMessage[];
  sentimentPulse: Zone0SentimentPulse;
  receivedAt: string;
}

export interface Zone0BufferSnapshot {
  ticks: Zone0Tick[];
  orderBooks: Zone0OrderBook[];
  newsItems: Zone0NewsItem[];
  boardPosts: Zone0BoardPost[];
  dartDisclosures: Zone0DartDisclosure[];
  fundamentalData: Zone0Fundamental[];
  globalContexts: GlobalMacroContext[];
  telegramMessages: Zone0TelegramMessage[];
  lastFrameAt: string | null;
}

export interface Zone0RealtimeStatus {
  kisConnected: boolean;
  primarySymbol: string;
  watchSymbols: string[];
}

export interface Zone0IngestConfig {
  keywords: string[];
  boardPollMs: number;
}

export interface Zone0Gateway {
  emitter: EventEmitter;
  start: (params?: { targetSymbol?: string }) => Promise<void>;
  stop: () => Promise<void>;
  setTargetSymbol: (symbol: string) => Promise<void>;
  consumeFrame: () => Zone0Frame | null;
  hasPendingFrame: () => boolean;
  ingestTelegramWebhook: (payload: Zone0TelegramWebhookPayload) => Zone0TelegramMessage | null;
  getConfig: () => Zone0IngestConfig;
  updateConfig: (newKeywords: string[], newBoardPollMs: number) => Zone0IngestConfig;
  getBufferSnapshot: () => Zone0BufferSnapshot;
  getRealtimeStatus: () => Zone0RealtimeStatus;
}

interface PendingBucket {
  newsItems: Zone0NewsItem[];
  boardPosts: Zone0BoardPost[];
  dartDisclosures: Zone0DartDisclosure[];
  fundamentalData: Zone0Fundamental[];
  globalContexts: GlobalMacroContext[];
  telegramMessages: Zone0TelegramMessage[];
}

export function createZone0Gateway(): Zone0Gateway {
  const emitter = new EventEmitter();
  const ticks: Zone0Tick[] = [];
  const orderBooks: Zone0OrderBook[] = [];
  const newsItems: Zone0NewsItem[] = [];
  const boardPosts: Zone0BoardPost[] = [];
  const dartDisclosures: Zone0DartDisclosure[] = [];
  const fundamentalData: Zone0Fundamental[] = [];
  const globalContexts: GlobalMacroContext[] = [];
  const telegramMessages: Zone0TelegramMessage[] = [];
  const frameQueue: Zone0Frame[] = [];

  const latestTickBySymbol = new Map<string, Zone0Tick>();
  const latestOrderBookBySymbol = new Map<string, Zone0OrderBook>();
  const pendingBySymbol = new Map<string, PendingBucket>();

  const boardSeen = new Set<string>();
  const boardSeenQueue: string[] = [];

  let manualTargetSymbol = sanitizeSymbol(DEFAULT_SYMBOL);
  let manualPinEnabled = false;
  let currentSymbol = manualTargetSymbol;
  let watchSymbols: string[] = [manualTargetSymbol];
  let discoveredSymbols: string[] = [];
  let roundRobinCursor = 0;
  let started = false;
  let lastFrameAt: string | null = null;
  let wsClient: KisWebSocketClient | null = null;
  let symbolPoolTimer: NodeJS.Timeout | null = null;
  let externalTimer: NodeJS.Timeout | null = null;
  let boardTimer: NodeJS.Timeout | null = null;
  let marketFlowTimer: NodeJS.Timeout | null = null;
  let macroTimer: NodeJS.Timeout | null = null;
  let pollingSymbolPool = false;
  let pollingNews = false;
  let pollingDart = false;
  let pollingBoard = false;
  let pollingMarketFlow = false;
  let pollingMacro = false;
  let dynamicNewsKeywords = normalizeKeywordArray(parseCsv(process.env.ZONE0_NEWS_KEYWORDS ?? ""));
  let dynamicBoardPollMs = clamp(
    Number(process.env.ZONE0_BOARD_POLL_MS ?? DEFAULT_BOARD_POLL_MS),
    MIN_BOARD_POLL_MS,
    MAX_BOARD_POLL_MS
  );
  let warnedSymbolPoolDisabled = false;
  let warnedNaverDisabled = false;
  let warnedDartDisabled = false;
  let warnedMarketFlowDisabled = false;
  let warnedMacroDisabled = false;
  let kisRealtimeConnected = false;
  let kisAccessToken: string | null = null;
  let kisAccessTokenExpireAt = 0;
  const naverNewsClient = new NaverNewsClient({
    timeoutMs: NAVER_REQUEST_TIMEOUT_MS
  });
  const dartDisclosureClient = new DartDisclosureClient({
    timeoutMs: NAVER_REQUEST_TIMEOUT_MS
  });
  const marketFlowClient = new MarketFlowClient({
    timeoutMs: NAVER_REQUEST_TIMEOUT_MS
  });
  const macroContextClient = new MacroContextClient({
    timeoutMs: NAVER_REQUEST_TIMEOUT_MS
  });

  function getPendingBucket(symbol: string): PendingBucket {
    const key = sanitizeSymbol(symbol);
    const bucket = pendingBySymbol.get(key);
    if (bucket) {
      return bucket;
    }

    const created: PendingBucket = {
      newsItems: [],
      boardPosts: [],
      dartDisclosures: [],
      fundamentalData: [],
      globalContexts: [],
      telegramMessages: []
    };
    pendingBySymbol.set(key, created);
    return created;
  }

  function getWatchSymbolsSnapshot(): string[] {
    if (watchSymbols.length > 0) {
      return [...watchSymbols];
    }
    return [manualTargetSymbol];
  }

  function pickRoundRobinSymbol(): string {
    const pool = getWatchSymbolsSnapshot();
    if (pool.length === 0) {
      return manualTargetSymbol;
    }

    const index = roundRobinCursor % pool.length;
    roundRobinCursor = (roundRobinCursor + 1) % Math.max(1, pool.length);
    return pool[index] ?? manualTargetSymbol;
  }

  function buildMergedWatchSymbols(nextDiscovered: string[]): string[] {
    const merged: string[] = [];
    const seen = new Set<string>();
    const candidates = manualPinEnabled ? [manualTargetSymbol, ...nextDiscovered] : nextDiscovered;

    for (const candidate of candidates) {
      const symbol = sanitizeSymbol(candidate);
      if (!symbol || seen.has(symbol)) {
        continue;
      }

      seen.add(symbol);
      merged.push(symbol);
      if (merged.length >= SYMBOL_POOL_SIZE) {
        break;
      }
    }

    if (merged.length === 0) {
      merged.push(DEFAULT_SYMBOL);
    }

    return merged;
  }

  async function applyWatchSymbols(nextSymbols: string[], reason: string): Promise<void> {
    const normalized = normalizeSymbolList(nextSymbols);
    const previous = watchSymbols;
    if (sameStringArray(previous, normalized)) {
      return;
    }

    const removed = previous.filter((symbol) => !normalized.includes(symbol));
    watchSymbols = normalized;
    currentSymbol = watchSymbols[0] ?? manualTargetSymbol;
    roundRobinCursor = 0;

    for (const symbol of removed) {
      pendingBySymbol.delete(symbol);
      latestTickBySymbol.delete(symbol);
      latestOrderBookBySymbol.delete(symbol);
    }

    if (wsClient) {
      await wsClient.updateSymbols(watchSymbols);
    }

    console.info(
      `[zone0][symbol-pool] updated (${reason}) size=${watchSymbols.length} symbols=${watchSymbols.join(",")}`
    );
  }

  function isSymbolDiscoveryReady(): boolean {
    return Boolean(
      SYMBOL_DISCOVERY_ENABLED &&
        KIS_REST_URL &&
        KIS_APP_KEY &&
        KIS_APP_SECRET &&
        KIS_HOTLIST_PATH &&
        KIS_HOTLIST_TR_ID
    );
  }

  async function fetchKisAccessToken(): Promise<string> {
    const now = Date.now();
    if (kisAccessToken && now + KIS_TOKEN_SKEW_MS < kisAccessTokenExpireAt) {
      return kisAccessToken;
    }

    const tokenUrl = buildHttpUrl(KIS_REST_URL, KIS_TOKEN_PATH);
    const response = await runWithRetry(
      () =>
        axios.post<KisAccessTokenResponse>(
          tokenUrl,
          {
            grant_type: "client_credentials",
            appkey: KIS_APP_KEY,
            appsecret: KIS_APP_SECRET
          },
          {
            headers: {
              "Content-Type": "application/json; charset=utf-8"
            },
            timeout: KIS_HOTLIST_TIMEOUT_MS
          }
        ),
      {
        context: "zone0:kis-token"
      }
    );

    const token = String(response.data.access_token ?? "").trim();
    if (!token) {
      throw new Error("KIS access_token 발급 실패");
    }

    const expiresInSec = Number(response.data.expires_in ?? 0);
    const ttlMs = Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec * 1_000 : 3_600_000;
    kisAccessToken = token;
    kisAccessTokenExpireAt = now + ttlMs;
    return token;
  }

  async function fetchHotSymbolsFromKis(): Promise<string[]> {
    const token = await fetchKisAccessToken();
    const url = buildHttpUrl(KIS_REST_URL, KIS_HOTLIST_PATH);
    const payload = await runWithRetry(
      async () => {
        const response = await axios.get<unknown>(url, {
          timeout: KIS_HOTLIST_TIMEOUT_MS,
          headers: {
            authorization: `Bearer ${token}`,
            appkey: KIS_APP_KEY,
            appsecret: KIS_APP_SECRET,
            tr_id: KIS_HOTLIST_TR_ID,
            custtype: "P"
          },
          params: {
            FID_COND_MRKT_DIV_CODE: KIS_HOTLIST_MARKET_DIV,
            FID_COND_SCR_DIV_CODE: KIS_HOTLIST_SCREEN_DIV,
            FID_INPUT_ISCD: KIS_HOTLIST_INPUT_ISCD,
            FID_DIV_CLS_CODE: KIS_HOTLIST_DIV_CLS_CODE,
            FID_BLNG_CLS_CODE: KIS_HOTLIST_BLNG_CLS_CODE,
            FID_TRGT_CLS_CODE: KIS_HOTLIST_TRGT_CLS_CODE,
            FID_TRGT_EXLS_CLS_CODE: KIS_HOTLIST_TRGT_EXLS_CLS_CODE,
            FID_INPUT_PRICE_1: KIS_HOTLIST_INPUT_PRICE_1,
            FID_INPUT_PRICE_2: KIS_HOTLIST_INPUT_PRICE_2,
            FID_VOL_CNT: KIS_HOTLIST_VOL_CNT,
            FID_INPUT_DATE_1: KIS_HOTLIST_INPUT_DATE_1
          }
        });

        // 토큰 만료/인증오류가 의심되면 다음 호출에서 토큰 재발급하도록 캐시를 폐기한다.
        if (response.data && typeof response.data === "object") {
          const body = response.data as Record<string, unknown>;
          const rtCd = String(body.rt_cd ?? "").trim();
          if (rtCd && rtCd !== "0") {
            const msgCd = String(body.msg_cd ?? "").trim();
            const message = String(body.msg1 ?? body.msg ?? "KIS hotlist failed").trim();
            if (msgCd === "EGW00123" || msgCd === "EGW00121" || message.includes("token")) {
              kisAccessToken = null;
              kisAccessTokenExpireAt = 0;
            }
          }
        }

        return response.data;
      },
      {
        context: "zone0:kis-hot-symbols"
      }
    );

    return extractSymbolsFromHotListPayload(payload, SYMBOL_POOL_SIZE);
  }

  async function refreshSymbolPool(reason: string): Promise<void> {
    if (pollingSymbolPool) {
      return;
    }

    if (!isSymbolDiscoveryReady()) {
      if (!warnedSymbolPoolDisabled) {
        warnedSymbolPoolDisabled = true;
        console.warn(
          "[zone0][symbol-pool] KIS 심볼 탐색 비활성화 (ZONE0_SYMBOL_DISCOVERY_ENABLED/KIS_REST_URL/KIS_APP_KEY/KIS_APP_SECRET 확인)"
        );
      }
      await applyWatchSymbols([manualTargetSymbol], "fallback");
      return;
    }

    pollingSymbolPool = true;
    try {
      const symbols = await fetchHotSymbolsFromKis();
      if (symbols.length === 0) {
        return;
      }

      discoveredSymbols = symbols;
      const merged = buildMergedWatchSymbols(discoveredSymbols);
      await applyWatchSymbols(merged, reason);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[zone0][symbol-pool] refresh failed: ${message}`);
    } finally {
      pollingSymbolPool = false;
    }
  }

  function buildZone0OrderBook(raw: KisOrderBook): Zone0OrderBook {
    return {
      symbol: sanitizeSymbol(raw.symbol || currentSymbol),
      asks: raw.asks.map((level) => ({
        price: Math.max(0, Math.floor(level.price)),
        qty: Math.max(0, Math.floor(level.qty))
      })),
      bids: raw.bids.map((level) => ({
        price: Math.max(0, Math.floor(level.price)),
        qty: Math.max(0, Math.floor(level.qty))
      })),
      totalAskDepth: Math.max(0, Math.floor(raw.totalAskDepth)),
      totalBidDepth: Math.max(0, Math.floor(raw.totalBidDepth)),
      source: "KIS_H0STASP0",
      timestamp: raw.receivedAt || nowIso()
    };
  }

  function buildEmptyOrderBook(symbol: string, timestamp: string): Zone0OrderBook {
    return {
      symbol: sanitizeSymbol(symbol),
      asks: [],
      bids: [],
      totalAskDepth: 0,
      totalBidDepth: 0,
      source: "KIS_H0STASP0",
      timestamp
    };
  }

  function enqueueFrame(tick: Zone0Tick, orderBook: Zone0OrderBook): void {
    const symbol = sanitizeSymbol(tick.symbol);
    const bucket = getPendingBucket(symbol);
    const frameNews = bucket.newsItems.splice(0, bucket.newsItems.length);
    const frameBoard = bucket.boardPosts.splice(0, bucket.boardPosts.length);
    const frameDart = bucket.dartDisclosures.splice(0, bucket.dartDisclosures.length);
    const frameFundamental = bucket.fundamentalData.splice(0, bucket.fundamentalData.length);
    const frameGlobalContext = bucket.globalContexts.splice(0, bucket.globalContexts.length).at(-1) ?? null;
    const frameTelegram = bucket.telegramMessages.splice(0, bucket.telegramMessages.length);
    const sentimentPulse = makeSentimentPulse(frameNews, frameBoard, frameDart, frameTelegram);
    const receivedAt = nowIso();

    const frame: Zone0Frame = {
      tick,
      orderBook,
      newsItems: frameNews,
      boardPosts: frameBoard,
      dartDisclosures: frameDart,
      fundamentalData: frameFundamental,
      globalContext: frameGlobalContext,
      telegramMessages: frameTelegram,
      sentimentPulse,
      receivedAt
    };

    pushBuffered(frameQueue, frame, MAX_FRAME_QUEUE_SIZE);
    lastFrameAt = receivedAt;

    emitter.emit("zone1:tick", {
      tick: frame.tick,
      orderBook: frame.orderBook,
      emittedAt: receivedAt
    });

    emitter.emit("zone4:context", {
      symbol,
      sentimentPulse,
      newsItems: frameNews,
      boardPosts: frameBoard,
      dartDisclosures: frameDart,
      fundamentalData: frameFundamental,
      globalContext: frameGlobalContext,
      telegramMessages: frameTelegram,
      emittedAt: receivedAt
    });

    emitter.emit("zone0:raw", frame);
  }

  function flushPendingContextFrame(symbol: string): void {
    const key = sanitizeSymbol(symbol);
    const bucket = getPendingBucket(key);
    const hasPending =
      bucket.newsItems.length > 0 ||
      bucket.boardPosts.length > 0 ||
      bucket.dartDisclosures.length > 0 ||
      bucket.fundamentalData.length > 0 ||
      bucket.globalContexts.length > 0 ||
      bucket.telegramMessages.length > 0;

    if (!hasPending) {
      return;
    }

    const tick = latestTickBySymbol.get(key);
    if (!tick) {
      return;
    }

    const orderBook = latestOrderBookBySymbol.get(key) ?? buildEmptyOrderBook(key, nowIso());
    enqueueFrame(tick, orderBook);
  }

  function onKisOrderBook(rawBook: KisOrderBook): void {
    const orderBook = buildZone0OrderBook(rawBook);
    latestOrderBookBySymbol.set(orderBook.symbol, orderBook);
    pushBuffered(orderBooks, orderBook, MAX_BUFFER_SIZE);
  }

  function onKisTick(rawTick: {
    symbol: string;
    price: number;
    volume: number;
    volumePower?: number;
    receivedAt: string;
  }): void {
    const symbol = sanitizeSymbol(rawTick.symbol || currentSymbol);
    const timestamp = rawTick.receivedAt || nowIso();
    const latestBook = latestOrderBookBySymbol.get(symbol);

    const tick: Zone0Tick = {
      symbol,
      price: Math.max(1, Math.floor(rawTick.price)),
      volume: Math.max(0, Math.floor(rawTick.volume)),
      volumePower: Number.isFinite(rawTick.volumePower) ? Number(rawTick.volumePower) : undefined,
      bidDepth: latestBook?.totalBidDepth ?? 0,
      askDepth: latestBook?.totalAskDepth ?? 0,
      timestamp
    };

    latestTickBySymbol.set(symbol, tick);
    pushBuffered(ticks, tick, MAX_BUFFER_SIZE);

    const frameOrderBook = latestBook ?? buildEmptyOrderBook(symbol, timestamp);
    enqueueFrame(tick, frameOrderBook);
  }

  async function pollNaverNews(symbol: string): Promise<void> {
    if (pollingNews) {
      return;
    }
    if (!naverNewsClient.isEnabled) {
      return;
    }
    pollingNews = true;

    try {
      const keywords = resolveNaverNewsKeywords(symbol, dynamicNewsKeywords);
      const articles = await naverNewsClient.fetchLatestByKeywords(keywords);
      if (articles.length === 0) {
        return;
      }

      const discovered: Zone0NewsItem[] = articles.map((article) => {
        const headline = article.title;
        const description = article.description;
        const body = description ? `${description} (${article.link})` : article.link;
        const sentimentSource = `${headline} ${description}`.trim();

        return {
          id: shortId("NEWS"),
          symbol,
          headline,
          body,
          newsUrl: article.link || article.originallink,
          keywordHint: article.keyword,
          sourceClass: "ECONOMIC_PRESS",
          sentimentHint: estimateSentimentHint(sentimentSource),
          source: "NAVER_NEWS",
          timestamp: article.publishedAt || nowIso()
        };
      });

      const bucket = getPendingBucket(symbol);
      for (const item of discovered) {
        pushBuffered(newsItems, item, MAX_BUFFER_SIZE);
        bucket.newsItems.push(item);
      }
      flushPendingContextFrame(symbol);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[zone0][news] polling failed: ${message}`);
    } finally {
      pollingNews = false;
    }
  }

  function getConfig(): Zone0IngestConfig {
    return {
      keywords: [...dynamicNewsKeywords],
      boardPollMs: dynamicBoardPollMs
    };
  }

  function restartBoardTimer(): void {
    if (boardTimer) {
      clearInterval(boardTimer);
      boardTimer = null;
    }
    if (!started) {
      return;
    }

    boardTimer = setInterval(() => {
      void pollNaverBoard(pickRoundRobinSymbol());
    }, dynamicBoardPollMs);
  }

  function updateConfig(newKeywords: string[], newBoardPollMs: number): Zone0IngestConfig {
    const parsedPollMs = Number(newBoardPollMs);
    if (!Number.isFinite(parsedPollMs) || parsedPollMs <= 0) {
      throw new Error("boardPollMs must be a positive number.");
    }

    dynamicNewsKeywords = normalizeKeywordArray(newKeywords);
    dynamicBoardPollMs = clamp(Math.floor(parsedPollMs), MIN_BOARD_POLL_MS, MAX_BOARD_POLL_MS);
    restartBoardTimer();

    const snapshot = getConfig();
    console.info(
      `[zone0][config] updated keywords=${snapshot.keywords.join(",")} boardPollMs=${snapshot.boardPollMs}`
    );
    return snapshot;
  }

  async function pollDartDisclosures(symbol: string): Promise<void> {
    if (pollingDart) {
      return;
    }
    if (!dartDisclosureClient.isEnabled) {
      return;
    }
    pollingDart = true;

    try {
      const disclosures = await dartDisclosureClient.fetchRecentImpactDisclosures(1);
      if (disclosures.length === 0) {
        return;
      }

      const discovered: Zone0DartDisclosure[] = disclosures.map((item) => ({
        id: shortId("DART"),
        symbol,
        corpCode: item.corpCode,
        corpName: item.corpName,
        reportName: item.reportName,
        receiptNo: item.receiptNo,
        receiptDate: item.receiptDate,
        link: item.link,
        impactKeywords: item.impactKeywords,
        impactScore: item.impactScore,
        sentimentHint: estimateDisclosureSentiment(item),
        source: "DART_DISCLOSURE",
        timestamp: nowIso()
      }));

      const bucket = getPendingBucket(symbol);
      for (const disclosure of discovered) {
        pushBuffered(dartDisclosures, disclosure, MAX_BUFFER_SIZE);
        bucket.dartDisclosures.push(disclosure);
      }
      flushPendingContextFrame(symbol);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[zone0][dart] polling failed: ${message}`);
    } finally {
      pollingDart = false;
    }
  }

  async function pollExternalFeeds(symbol: string): Promise<void> {
    const tasks: Array<Promise<void>> = [pollNaverNews(symbol), pollDartDisclosures(symbol)];
    await Promise.all(tasks);
  }

  async function pollMarketFlow(symbol: string): Promise<void> {
    if (pollingMarketFlow) {
      return;
    }
    if (!marketFlowClient.isEnabled) {
      return;
    }
    pollingMarketFlow = true;

    try {
      const snapshot = await marketFlowClient.fetchSymbol(symbol);
      if (!snapshot) {
        return;
      }

      const item: Zone0Fundamental = {
        symbol,
        foreignNetBuyQty: snapshot.foreignNetBuyQty,
        institutionalNetBuyQty: snapshot.institutionalNetBuyQty,
        shortBalanceQty: snapshot.shortBalanceQty,
        source: snapshot.source,
        timestamp: snapshot.fetchedAt || nowIso()
      };

      pushBuffered(fundamentalData, item, MAX_BUFFER_SIZE);
      const bucket = getPendingBucket(symbol);
      bucket.fundamentalData.push(item);
      flushPendingContextFrame(symbol);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[zone0][market-flow] polling failed: ${message}`);
    } finally {
      pollingMarketFlow = false;
    }
  }

  async function pollMacroContext(symbol: string): Promise<void> {
    if (pollingMacro) {
      return;
    }
    if (!macroContextClient.isEnabled) {
      return;
    }
    pollingMacro = true;

    try {
      const macro = await macroContextClient.fetchLatest();
      if (!macro) {
        return;
      }

      pushBuffered(globalContexts, macro, MAX_BUFFER_SIZE);
      const bucket = getPendingBucket(symbol);
      bucket.globalContexts.push(macro);
      flushPendingContextFrame(symbol);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[zone0][macro] polling failed: ${message}`);
    } finally {
      pollingMacro = false;
    }
  }

  async function pollNaverBoardFromJsonApi(symbol: string): Promise<Zone0BoardPost[]> {
    const channelInfoUrl = `${NAVER_OPENTALK_BASE_URL}/channelInfo?code=${encodeURIComponent(symbol)}`;
    const channelInfoResponse = await runWithRetry(
      () =>
        axios.get<NaverOpenTalkChannelInfoResponse>(channelInfoUrl, {
          headers: NAVER_MOBILE_HEADERS,
          timeout: NAVER_REQUEST_TIMEOUT_MS
        }),
      {
        context: `naver-board-opentalk:channel:${symbol}`
      }
    );

    const channelResult = asRecord(channelInfoResponse.data?.result);
    const channelId = String(channelResult?.channelId ?? "").trim();

    let messages = normalizeOpenTalkMessages(channelResult?.filteredRecentMessages);
    if (messages.length === 0) {
      messages = normalizeOpenTalkMessages(channelResult?.recentMessages);
    }

    if (messages.length === 0 && channelId) {
      const recentMessagesUrl = `${NAVER_OPENTALK_BASE_URL}/recentMessages?channelId=${encodeURIComponent(channelId)}`;
      const recentMessagesResponse = await runWithRetry(
        () =>
          axios.get<NaverOpenTalkRecentMessagesResponse>(recentMessagesUrl, {
            headers: NAVER_MOBILE_HEADERS,
            timeout: NAVER_REQUEST_TIMEOUT_MS
          }),
        {
          context: `naver-board-opentalk:recent:${symbol}`
        }
      );
      messages = normalizeOpenTalkMessages(recentMessagesResponse.data?.result);
    }

    const discovered: Zone0BoardPost[] = [];
    for (const message of messages) {
      const dedupeKey = `${symbol}|${message.createTimeRaw}|${message.nickname}|${message.content}`;
      if (seenBefore(boardSeen, boardSeenQueue, dedupeKey, SEEN_KEY_LIMIT)) {
        continue;
      }

      const content = message.nickname ? `[${message.nickname}] ${message.content}` : message.content;
      discovered.push({
        id: shortId("BOARD"),
        symbol,
        title: toBoardTitle(message.content),
        content,
        sentimentHint: estimateSentimentHint(content),
        source: "NAVER_BOARD",
        timestamp: message.timestamp
      });
    }

    return discovered;
  }

  async function pollNaverBoardFromHtml(symbol: string): Promise<Zone0BoardPost[]> {
    const url = `https://finance.naver.com/item/board.naver?code=${encodeURIComponent(symbol)}&page=1`;
    const response = await runWithRetry(
      () =>
        axios.get<string>(url, {
          headers: NAVER_HEADERS,
          responseType: "text",
          timeout: NAVER_REQUEST_TIMEOUT_MS
        }),
      {
        context: `naver-board-html:${symbol}`
      }
    );

    const $ = loadHtml(response.data);
    const rows = $("table.type2 tr").toArray();
    const discovered: Zone0BoardPost[] = [];

    for (const row of rows) {
      const anchor = $(row).find("td.title a").first();
      if (anchor.length === 0) {
        continue;
      }

      const title = normalizeWhitespace(anchor.text());
      if (!title) {
        continue;
      }

      const dateText = normalizeWhitespace($(row).find("td span.tah").first().text());
      const dedupeKey = `${symbol}|${title}|${dateText}`;
      if (seenBefore(boardSeen, boardSeenQueue, dedupeKey, SEEN_KEY_LIMIT)) {
        continue;
      }

      discovered.push({
        id: shortId("BOARD"),
        symbol,
        title: toBoardTitle(title),
        content: title,
        sentimentHint: estimateSentimentHint(title),
        source: "NAVER_BOARD",
        timestamp: nowIso()
      });
    }

    return discovered;
  }

  async function pollNaverBoard(symbol: string): Promise<void> {
    if (pollingBoard) {
      return;
    }
    pollingBoard = true;

    try {
      let discovered: Zone0BoardPost[] = [];

      try {
        discovered = await pollNaverBoardFromJsonApi(symbol);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[zone0][board] JSON API polling failed, fallback to HTML: ${message}`);
      }

      if (discovered.length === 0) {
        discovered = await pollNaverBoardFromHtml(symbol);
      }

      if (discovered.length === 0) {
        return;
      }

      const bucket = getPendingBucket(symbol);
      for (const post of discovered) {
        pushBuffered(boardPosts, post, MAX_BUFFER_SIZE);
        bucket.boardPosts.push(post);
      }
      flushPendingContextFrame(symbol);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[zone0][board] polling failed: ${message}`);
    } finally {
      pollingBoard = false;
    }
  }

  async function start(params?: { targetSymbol?: string }): Promise<void> {
    const explicitTarget = toExplicitSymbol(params?.targetSymbol);
    if (explicitTarget) {
      manualTargetSymbol = explicitTarget;
      manualPinEnabled = true;
      currentSymbol = manualTargetSymbol;
      watchSymbols = normalizeSymbolList([manualTargetSymbol]);
    }

    if (started) {
      await setTargetSymbol(manualTargetSymbol);
      return;
    }

    started = true;

    if (!naverNewsClient.isEnabled && !warnedNaverDisabled) {
      warnedNaverDisabled = true;
      console.warn("[zone0][news] NAVER 뉴스 수집 경로(OPEN API/크롤링)가 비활성화되어 뉴스 수집이 중지됩니다.");
    }
    if (!dartDisclosureClient.isEnabled && !warnedDartDisabled) {
      warnedDartDisabled = true;
      console.warn("[zone0][dart] DART_API_KEY 미설정으로 공시 수집이 비활성화됩니다.");
    }
    if (!marketFlowClient.isEnabled && !warnedMarketFlowDisabled) {
      warnedMarketFlowDisabled = true;
      console.warn("[zone0][market-flow] KRX/KOSCOM endpoint 미설정으로 시장 수급 수집이 비활성화됩니다.");
    }
    if (!macroContextClient.isEnabled && !warnedMacroDisabled) {
      warnedMacroDisabled = true;
      console.warn("[zone0][macro] 거시지표 endpoint 미설정으로 Global Context 수집이 비활성화됩니다.");
    }
    if (!isSymbolDiscoveryReady() && !warnedSymbolPoolDisabled) {
      warnedSymbolPoolDisabled = true;
      console.warn(
        "[zone0][symbol-pool] KIS 심볼 탐색 비활성화 (ZONE0_SYMBOL_DISCOVERY_ENABLED/KIS_REST_URL/KIS_APP_KEY/KIS_APP_SECRET 확인)"
      );
    }

    symbolPoolTimer = setInterval(() => {
      void refreshSymbolPool("interval");
    }, SYMBOL_POOL_REFRESH_MS);

    externalTimer = setInterval(() => {
      void pollExternalFeeds(pickRoundRobinSymbol());
    }, EXTERNAL_POLL_MS);
    restartBoardTimer();
    marketFlowTimer = setInterval(() => {
      void pollMarketFlow(pickRoundRobinSymbol());
    }, MARKET_FLOW_POLL_MS);
    macroTimer = setInterval(() => {
      void pollMacroContext(currentSymbol);
    }, MACRO_POLL_MS);

    try {
      wsClient = new KisWebSocketClient({
        targetSymbols: getWatchSymbolsSnapshot(),
        onConnectionStateChange: (connected) => {
          kisRealtimeConnected = connected;
        },
        onTick: (tick) => onKisTick(tick),
        onOrderBook: (orderBook) => onKisOrderBook(orderBook)
      });
      await wsClient.start(getWatchSymbolsSnapshot());
      console.info(`[zone0] KIS websocket started for ${getWatchSymbolsSnapshot().join(",")}`);
    } catch (error) {
      wsClient = null;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[zone0] KIS websocket init failed: ${message}`);
    }

    void refreshSymbolPool("startup");
    void pollExternalFeeds(currentSymbol);
    void pollNaverBoard(currentSymbol);
    void pollMarketFlow(currentSymbol);
    void pollMacroContext(currentSymbol);
  }

  async function stop(): Promise<void> {
    started = false;

    if (symbolPoolTimer) {
      clearInterval(symbolPoolTimer);
      symbolPoolTimer = null;
    }

    if (externalTimer) {
      clearInterval(externalTimer);
      externalTimer = null;
    }

    if (boardTimer) {
      clearInterval(boardTimer);
      boardTimer = null;
    }
    if (marketFlowTimer) {
      clearInterval(marketFlowTimer);
      marketFlowTimer = null;
    }
    if (macroTimer) {
      clearInterval(macroTimer);
      macroTimer = null;
    }

    if (wsClient) {
      await wsClient.stop();
      wsClient = null;
    }
    kisRealtimeConnected = false;
  }

  async function setTargetSymbol(symbol: string): Promise<void> {
    const next = sanitizeSymbol(symbol);
    manualTargetSymbol = next;
    manualPinEnabled = true;
    currentSymbol = next;

    const nextWatch = buildMergedWatchSymbols(discoveredSymbols);
    await applyWatchSymbols(nextWatch, "manual-target");

    void pollExternalFeeds(next);
    void pollNaverBoard(next);
    void pollMarketFlow(next);
    void pollMacroContext(next);
  }

  function ingestTelegramWebhook(payload: Zone0TelegramWebhookPayload): Zone0TelegramMessage | null {
    const candidates = collectTelegramPayloadCandidates(payload);
    const message = extractTelegramWebhookText(candidates);
    if (!message) {
      return null;
    }

    const symbolRaw = extractTelegramWebhookString(candidates, TELEGRAM_SYMBOL_KEYS);
    const sentimentRaw = extractTelegramWebhookNumber(candidates, TELEGRAM_SENTIMENT_KEYS);
    const priorityRaw = extractTelegramWebhookString(candidates, TELEGRAM_PRIORITY_KEYS);
    const timestampRaw = extractTelegramWebhookValue(candidates, TELEGRAM_TIMESTAMP_KEYS);
    const symbol = sanitizeSymbol(symbolRaw ?? currentSymbol);
    const telegramMessage: Zone0TelegramMessage = {
      id: shortId("TG"),
      symbol,
      message,
      sentimentHint: normalizeSentimentHint(sentimentRaw, message),
      priority: normalizePriority(priorityRaw ?? undefined),
      source: "TELEGRAM",
      timestamp: normalizeWebhookTimestamp(timestampRaw)
    };

    pushBuffered(telegramMessages, telegramMessage, MAX_BUFFER_SIZE);
    const bucket = getPendingBucket(symbol);
    bucket.telegramMessages.push(telegramMessage);
    flushPendingContextFrame(symbol);
    return telegramMessage;
  }

  return {
    emitter,
    start,
    stop,
    setTargetSymbol,
    consumeFrame: () => frameQueue.shift() ?? null,
    hasPendingFrame: () => frameQueue.length > 0,
    ingestTelegramWebhook,
    getConfig,
    updateConfig,
    getRealtimeStatus: () => ({
      kisConnected: kisRealtimeConnected,
      primarySymbol: currentSymbol,
      watchSymbols: [...watchSymbols]
    }),
    getBufferSnapshot: () => ({
      ticks: [...ticks],
      orderBooks: [...orderBooks],
      newsItems: [...newsItems],
      boardPosts: [...boardPosts],
      dartDisclosures: [...dartDisclosures],
      fundamentalData: [...fundamentalData],
      globalContexts: [...globalContexts],
      telegramMessages: [...telegramMessages],
      lastFrameAt
    })
  };
}

function pushBuffered<T>(buffer: T[], item: T, limit: number): void {
  buffer.push(item);
  if (buffer.length > limit) {
    buffer.shift();
  }
}

function makeSentimentPulse(
  news: Zone0NewsItem[],
  board: Zone0BoardPost[],
  disclosures: Zone0DartDisclosure[],
  telegram: Zone0TelegramMessage[]
): Zone0SentimentPulse {
  const hints = [
    ...news.map((item) => item.sentimentHint),
    ...board.map((item) => item.sentimentHint),
    ...disclosures.map((item) => item.sentimentHint),
    ...telegram.map((item) => item.sentimentHint)
  ];

  const signalCount = hints.length;
  const score = signalCount > 0 ? hints.reduce((sum, hint) => sum + hint, 0) / signalCount : 0;
  const velocity = clamp(news.length * 24 + board.length * 14 + disclosures.length * 20 + telegram.length * 30, 0, 100);

  return {
    score: Number(clamp(score, -1, 1).toFixed(2)),
    velocity: Number(velocity.toFixed(2)),
    signalCount
  };
}

function seenBefore(store: Set<string>, queue: string[], key: string, limit: number): boolean {
  if (store.has(key)) {
    return true;
  }

  store.add(key);
  queue.push(key);
  if (queue.length > limit) {
    const dropped = queue.shift();
    if (dropped) {
      store.delete(dropped);
    }
  }
  return false;
}

function buildHttpUrl(baseUrl: string, path: string): string {
  const normalizedBase = String(baseUrl).trim().replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

function normalizeSymbolList(symbols: string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const raw of symbols) {
    const symbol = sanitizeSymbol(raw);
    if (!symbol || seen.has(symbol)) {
      continue;
    }
    seen.add(symbol);
    deduped.push(symbol);
  }

  return deduped.length > 0 ? deduped : [DEFAULT_SYMBOL];
}

function sameStringArray(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }

  return true;
}

function extractSymbolsFromHotListPayload(payload: unknown, limit: number): string[] {
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const root = payload as Record<string, unknown>;
  const statusCode = String(root.rt_cd ?? "").trim();
  if (statusCode && statusCode !== "0") {
    return [];
  }

  const sources = [root.output, root.output1, root.output2, root.data, root.result, root.list, root.items];
  const symbols: string[] = [];
  const seen = new Set<string>();

  for (const source of sources) {
    if (!Array.isArray(source)) {
      continue;
    }

    for (const entry of source) {
      if (!entry || typeof entry !== "object") {
        continue;
      }

      const record = entry as Record<string, unknown>;
      const symbol = extractSymbolFromRecord(record);
      if (!symbol || seen.has(symbol)) {
        continue;
      }

      seen.add(symbol);
      symbols.push(symbol);
      if (symbols.length >= limit) {
        return symbols;
      }
    }
  }

  return symbols;
}

function extractSymbolFromRecord(record: Record<string, unknown>): string | null {
  for (const key of HOT_SYMBOL_FIELD_KEYS) {
    if (!(key in record)) {
      continue;
    }

    const candidate = String(record[key] ?? "").trim();
    if (!candidate) {
      continue;
    }

    const symbol = matchSixDigitSymbol(candidate);
    if (symbol) {
      return symbol;
    }
  }

  return null;
}

function matchSixDigitSymbol(value: string): string | null {
  const digits = value.replace(/[^\d]/g, "");
  if (digits.length < 6) {
    return null;
  }
  return digits.slice(0, 6);
}

function toExplicitSymbol(value: string | undefined): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return null;
  }

  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length >= 6) {
    return digits.slice(0, 6);
  }
  if (digits.length > 0) {
    return digits.padStart(6, "0");
  }
  return null;
}

function collectTelegramPayloadCandidates(payload: Zone0TelegramWebhookPayload): Record<string, unknown>[] {
  const root = toRecord(payload);
  if (!root) {
    return [];
  }

  const candidates: Record<string, unknown>[] = [root];
  const nestedKeys = ["data", "payload", "event", "update", "messageData", "telegram", "body", "message"];

  for (const key of nestedKeys) {
    const nested = toRecord(root[key]);
    if (nested) {
      candidates.push(nested);
    }
  }

  return candidates;
}

function extractTelegramWebhookText(candidates: Record<string, unknown>[]): string {
  return extractTelegramWebhookString(candidates, TELEGRAM_TEXT_KEYS) ?? "";
}

function extractTelegramWebhookString(candidates: Record<string, unknown>[], keys: string[]): string | null {
  const value = extractTelegramWebhookValue(candidates, keys);
  return toTrimmedString(value);
}

function extractTelegramWebhookNumber(candidates: Record<string, unknown>[], keys: string[]): number | undefined {
  const value = extractTelegramWebhookValue(candidates, keys);
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function extractTelegramWebhookValue(candidates: Record<string, unknown>[], keys: string[]): unknown {
  for (const candidate of candidates) {
    for (const key of keys) {
      const value = candidate[key];
      if (value !== undefined && value !== null) {
        return value;
      }
    }
  }
  return undefined;
}

function toTrimmedString(raw: unknown): string | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof raw === "number" && Number.isFinite(raw)) {
    return String(raw);
  }

  return null;
}

function toRecord(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return raw as Record<string, unknown>;
}

function normalizeWebhookTimestamp(raw: unknown): string {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return nowIso();
    }

    const parsedFromString = Date.parse(trimmed);
    if (Number.isFinite(parsedFromString)) {
      return new Date(parsedFromString).toISOString();
    }

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      return normalizeWebhookTimestamp(numeric);
    }

    return nowIso();
  }

  if (typeof raw === "number" && Number.isFinite(raw)) {
    const ms = raw > 1_000_000_000_000 ? raw : raw * 1_000;
    return new Date(ms).toISOString();
  }

  return nowIso();
}

function sanitizeSymbol(symbol: string): string {
  const raw = String(symbol ?? "").trim();
  if (!raw) {
    return "005930";
  }

  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length >= 6) {
    return digits.slice(0, 6);
  }
  if (digits.length > 0) {
    return digits.padStart(6, "0");
  }

  return "005930";
}

function normalizePriority(raw?: string): Zone0TelegramPriority {
  const normalized = String(raw ?? "MEDIUM")
    .trim()
    .toUpperCase();

  if (normalized === "HIGH" || normalized === "LOW") {
    return normalized;
  }
  return "MEDIUM";
}

function normalizeSentimentHint(rawHint: number | undefined, text: string): number {
  if (typeof rawHint === "number" && Number.isFinite(rawHint)) {
    return Number(clamp(rawHint, -1, 1).toFixed(2));
  }
  return estimateSentimentHint(text);
}

function estimateSentimentHint(text: string): number {
  const source = text.toLowerCase();
  let score = 0;

  for (const keyword of POSITIVE_HINTS) {
    if (source.includes(keyword.toLowerCase())) {
      score += 0.18;
    }
  }
  for (const keyword of NEGATIVE_HINTS) {
    if (source.includes(keyword.toLowerCase())) {
      score -= 0.2;
    }
  }

  return Number(clamp(score, -1, 1).toFixed(2));
}

function estimateDisclosureSentiment(disclosure: DartImpactDisclosure): number {
  let score = 0;
  for (const keyword of disclosure.impactKeywords) {
    if (keyword === "유상증자") {
      score -= 0.65;
      continue;
    }
    if (keyword === "영업실적") {
      score += 0.45;
      continue;
    }
    if (keyword === "공급계약") {
      score += 0.35;
    }
  }
  return Number(clamp(score, -1, 1).toFixed(2));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeOpenTalkMessages(raw: unknown): NaverOpenTalkMessage[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const parsed: NaverOpenTalkMessage[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (!record) {
      continue;
    }

    const content = normalizeWhitespace(String(record.content ?? ""));
    if (!content) {
      continue;
    }

    const nickname = normalizeWhitespace(String(record.nickname ?? ""));
    const createTimeRaw = String(record.createTime ?? "").trim();
    parsed.push({
      content,
      nickname,
      createTimeRaw,
      timestamp: toIsoFromUnknownTimestamp(record.createTime)
    });
  }

  return parsed;
}

function toIsoFromUnknownTimestamp(raw: unknown): string {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    const millis = raw > 10_000_000_000 ? raw : raw * 1_000;
    return new Date(millis).toISOString();
  }

  const text = String(raw ?? "").trim();
  if (!text) {
    return nowIso();
  }

  const asNumber = Number(text);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    const millis = asNumber > 10_000_000_000 ? asNumber : asNumber * 1_000;
    return new Date(millis).toISOString();
  }

  const normalized = text.replace(/\./g, "-").replace(/\s+/g, " ");
  const parsed = new Date(normalized.includes("T") ? normalized : normalized.replace(" ", "T"));
  if (Number.isNaN(parsed.getTime())) {
    return nowIso();
  }
  return parsed.toISOString();
}

function toBoardTitle(value: string): string {
  const normalized = normalizeWhitespace(value);
  if (normalized.length <= BOARD_TITLE_MAX_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, BOARD_TITLE_MAX_LENGTH - 3)}...`;
}

function normalizeWhitespace(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function resolveNaverNewsKeywords(symbol: string, keywords: string[]): string[] {
  const normalizedSymbol = sanitizeSymbol(symbol);
  const set = new Set<string>(normalizeKeywordArray(keywords));
  set.add(normalizedSymbol);
  return [...set];
}

function parseCsv(value: string): string[] {
  return String(value)
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
}

function normalizeKeywordArray(values: string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const raw of values) {
    const tokens = String(raw ?? "")
      .split(",")
      .map((token) => token.trim())
      .filter(Boolean);

    for (const token of tokens) {
      if (seen.has(token)) {
        continue;
      }
      seen.add(token);
      deduped.push(token);
    }
  }

  return deduped;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }

  const normalized = String(raw).trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }

  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}
