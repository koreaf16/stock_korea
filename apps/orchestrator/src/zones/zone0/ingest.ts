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

const DEFAULT_SYMBOL = (process.env.ZONE0_TARGET_SYMBOL ?? "005930").trim();
const MAX_BUFFER_SIZE = Math.max(100, Number(process.env.ZONE0_BUFFER_SIZE ?? 600));
const MAX_FRAME_QUEUE_SIZE = Math.max(10, Number(process.env.ZONE0_FRAME_QUEUE_SIZE ?? 3_000));
const EXTERNAL_POLL_MS = clamp(Number(process.env.ZONE0_EXTERNAL_POLL_MS ?? 60_000), 60_000, 300_000);
const BOARD_POLL_MS = clamp(Number(process.env.ZONE0_BOARD_POLL_MS ?? 20_000), 10_000, 60_000);
const MARKET_FLOW_POLL_MS = clamp(Number(process.env.ZONE0_MARKET_FLOW_POLL_MS ?? 60_000), 30_000, 300_000);
const MACRO_POLL_MS = clamp(Number(process.env.ZONE0_MACRO_POLL_MS ?? 1_800_000), 300_000, 3_600_000);
const SEEN_KEY_LIMIT = Math.max(1_000, Number(process.env.ZONE0_SEEN_KEY_LIMIT ?? 20_000));
const NAVER_REQUEST_TIMEOUT_MS = Math.max(2_000, Number(process.env.ZONE0_NAVER_TIMEOUT_MS ?? 8_000));
const NEWS_KEYWORDS = parseCsv(process.env.ZONE0_NEWS_KEYWORDS ?? "");

const NAVER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Referer: "https://finance.naver.com/"
};

const POSITIVE_HINTS = ["상승", "강세", "매수", "급등", "호재", "돌파", "수주", "확대", "회복", "신고가"];
const NEGATIVE_HINTS = ["하락", "약세", "매도", "급락", "악재", "경고", "축소", "우려", "불안", "루머"];

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
  symbol?: string;
  message?: string;
  text?: string;
  priority?: string;
  sentimentHint?: number;
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

export interface Zone0Gateway {
  emitter: EventEmitter;
  start: (params?: { targetSymbol?: string }) => Promise<void>;
  stop: () => Promise<void>;
  setTargetSymbol: (symbol: string) => Promise<void>;
  consumeFrame: () => Zone0Frame | null;
  hasPendingFrame: () => boolean;
  ingestTelegramWebhook: (payload: Zone0TelegramWebhookPayload) => Zone0TelegramMessage | null;
  getBufferSnapshot: () => Zone0BufferSnapshot;
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

  let currentSymbol = sanitizeSymbol(DEFAULT_SYMBOL);
  let started = false;
  let lastFrameAt: string | null = null;
  let wsClient: KisWebSocketClient | null = null;
  let externalTimer: NodeJS.Timeout | null = null;
  let boardTimer: NodeJS.Timeout | null = null;
  let marketFlowTimer: NodeJS.Timeout | null = null;
  let macroTimer: NodeJS.Timeout | null = null;
  let pollingNews = false;
  let pollingDart = false;
  let pollingBoard = false;
  let pollingMarketFlow = false;
  let pollingMacro = false;
  let warnedNaverDisabled = false;
  let warnedDartDisabled = false;
  let warnedMarketFlowDisabled = false;
  let warnedMacroDisabled = false;
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
    receivedAt: string;
  }): void {
    const symbol = sanitizeSymbol(rawTick.symbol || currentSymbol);
    const timestamp = rawTick.receivedAt || nowIso();
    const latestBook = latestOrderBookBySymbol.get(symbol);

    const tick: Zone0Tick = {
      symbol,
      price: Math.max(1, Math.floor(rawTick.price)),
      volume: Math.max(0, Math.floor(rawTick.volume)),
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
      const keywords = resolveNaverNewsKeywords(symbol);
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

  async function pollNaverBoard(symbol: string): Promise<void> {
    if (pollingBoard) {
      return;
    }
    pollingBoard = true;

    try {
      const url = `https://finance.naver.com/item/board.naver?code=${encodeURIComponent(symbol)}&page=1`;
      const response = await runWithRetry(
        () =>
          axios.get<string>(url, {
            headers: NAVER_HEADERS,
            responseType: "text",
            timeout: NAVER_REQUEST_TIMEOUT_MS
          }),
        {
          context: `naver-board:${symbol}`
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

        const title = anchor.text().trim();
        if (!title) {
          continue;
        }

        const dateText = $(row).find("td span.tah").first().text().trim();
        const dedupeKey = `${symbol}|${title}|${dateText}`;
        if (seenBefore(boardSeen, boardSeenQueue, dedupeKey, SEEN_KEY_LIMIT)) {
          continue;
        }

        discovered.push({
          id: shortId("BOARD"),
          symbol,
          title,
          content: title,
          sentimentHint: estimateSentimentHint(title),
          source: "NAVER_BOARD",
          timestamp: nowIso()
        });
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
    if (params?.targetSymbol) {
      currentSymbol = sanitizeSymbol(params.targetSymbol);
    }

    if (started) {
      await setTargetSymbol(currentSymbol);
      return;
    }

    started = true;

    if (!naverNewsClient.isEnabled && !warnedNaverDisabled) {
      warnedNaverDisabled = true;
      console.warn("[zone0][news] NAVER_CLIENT_ID 또는 NAVER_CLIENT_SECRET 미설정으로 뉴스 수집이 비활성화됩니다.");
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

    externalTimer = setInterval(() => {
      void pollExternalFeeds(currentSymbol);
    }, EXTERNAL_POLL_MS);
    boardTimer = setInterval(() => {
      void pollNaverBoard(currentSymbol);
    }, BOARD_POLL_MS);
    marketFlowTimer = setInterval(() => {
      void pollMarketFlow(currentSymbol);
    }, MARKET_FLOW_POLL_MS);
    macroTimer = setInterval(() => {
      void pollMacroContext(currentSymbol);
    }, MACRO_POLL_MS);

    void pollExternalFeeds(currentSymbol);
    void pollNaverBoard(currentSymbol);
    void pollMarketFlow(currentSymbol);
    void pollMacroContext(currentSymbol);

    try {
      wsClient = new KisWebSocketClient({
        targetSymbol: currentSymbol,
        onTick: (tick) => onKisTick(tick),
        onOrderBook: (orderBook) => onKisOrderBook(orderBook)
      });
      await wsClient.start(currentSymbol);
      console.info(`[zone0] KIS websocket started for ${currentSymbol}`);
    } catch (error) {
      wsClient = null;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[zone0] KIS websocket init failed: ${message}`);
    }
  }

  async function stop(): Promise<void> {
    started = false;

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
  }

  async function setTargetSymbol(symbol: string): Promise<void> {
    const next = sanitizeSymbol(symbol);
    currentSymbol = next;

    if (wsClient) {
      await wsClient.changeSymbol(next);
    }

    void pollExternalFeeds(next);
    void pollNaverBoard(next);
    void pollMarketFlow(next);
    void pollMacroContext(next);
  }

  function ingestTelegramWebhook(payload: Zone0TelegramWebhookPayload): Zone0TelegramMessage | null {
    const message = String(payload.message ?? payload.text ?? "").trim();
    if (!message) {
      return null;
    }

    const symbol = sanitizeSymbol(payload.symbol ?? currentSymbol);
    const telegramMessage: Zone0TelegramMessage = {
      id: shortId("TG"),
      symbol,
      message,
      sentimentHint: normalizeSentimentHint(payload.sentimentHint, message),
      priority: normalizePriority(payload.priority),
      source: "TELEGRAM",
      timestamp: nowIso()
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

function sanitizeSymbol(symbol: string): string {
  const sanitized = String(symbol).trim();
  return sanitized.length > 0 ? sanitized : "005930";
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

function resolveNaverNewsKeywords(symbol: string): string[] {
  const normalizedSymbol = sanitizeSymbol(symbol);
  const set = new Set<string>(NEWS_KEYWORDS);
  set.add(normalizedSymbol);
  return [...set];
}

function parseCsv(value: string): string[] {
  return String(value)
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
}
