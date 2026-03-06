import { EventEmitter } from "node:events";

import type { Zone0Tick } from "@stock/contracts";

import { clamp, nowIso, randFloat, randInt, shortId } from "../../utils.js";

const SYMBOL_POOL = ["005930", "000660", "035420", "051910", "068270"];
const MAX_BUFFER_SIZE = Number(process.env.ZONE0_BUFFER_SIZE ?? 600);

const BASE_PRICE_BY_SYMBOL: Record<string, number> = {
  "005930": 71_000,
  "000660": 174_000,
  "035420": 192_000,
  "051910": 352_000,
  "068270": 161_000
};

const NEWS_TEMPLATES: Array<{ headline: string; body: string; sentimentHint: number }> = [
  {
    headline: "장중 수급 집중, 외국인 순매수 확대",
    body: "단기 모멘텀 구간 진입 가능성이 제기됨.",
    sentimentHint: 0.52
  },
  {
    headline: "투자경고 루머 확산, 변동성 확대 우려",
    body: "확인되지 않은 루머로 단기 변동성이 커짐.",
    sentimentHint: -0.62
  },
  {
    headline: "신사업 기대감 재부각",
    body: "관련 섹터 동반 강세와 함께 거래대금 유입.",
    sentimentHint: 0.36
  },
  {
    headline: "차익실현 매물 출회",
    body: "고점 부담 인식으로 매도 우위가 관찰됨.",
    sentimentHint: -0.34
  }
];

const BOARD_TEMPLATES: Array<{ title: string; content: string; sentimentHint: number }> = [
  {
    title: "오늘 상한가 가능?",
    content: "거래량 보니 세력이 들어온 듯.",
    sentimentHint: 0.45
  },
  {
    title: "물량 던지는 거 아님?",
    content: "호가창 매도벽 커져서 불안함.",
    sentimentHint: -0.4
  },
  {
    title: "눌림목 매수 대기",
    content: "지지선 근처에서 재진입 관점.",
    sentimentHint: 0.22
  }
];

const TELEGRAM_TEMPLATES: Array<{ message: string; sentimentHint: number; priority: Zone0TelegramPriority }> = [
  {
    message: "테마주 확산 신호, 수급 동반 확인 필요",
    sentimentHint: 0.31,
    priority: "MEDIUM"
  },
  {
    message: "기관 대량매도 루머, 팩트체크 필요",
    sentimentHint: -0.36,
    priority: "HIGH"
  },
  {
    message: "단기 재료 소멸 가능성 언급",
    sentimentHint: -0.24,
    priority: "LOW"
  }
];

export type Zone0Source = "KIS_H0STCNT0" | "KIS_H0STASP0" | "NAVER_NEWS" | "NAVER_BOARD" | "TELEGRAM";
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

export interface Zone0TelegramMessage {
  id: string;
  symbol: string;
  message: string;
  sentimentHint: number;
  priority: Zone0TelegramPriority;
  source: "TELEGRAM";
  timestamp: string;
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
  telegramMessages: Zone0TelegramMessage[];
  sentimentPulse: Zone0SentimentPulse;
  receivedAt: string;
}

export interface Zone0BufferSnapshot {
  ticks: Zone0Tick[];
  orderBooks: Zone0OrderBook[];
  newsItems: Zone0NewsItem[];
  boardPosts: Zone0BoardPost[];
  telegramMessages: Zone0TelegramMessage[];
  lastFrameAt: string | null;
}

export interface Zone0Gateway {
  emitter: EventEmitter;
  nextFrame: (params: {
    targetSymbol: string;
    previousTick: Zone0Tick;
  }) => Zone0Frame;
  getBufferSnapshot: () => Zone0BufferSnapshot;
}

export function createZone0Gateway(): Zone0Gateway {
  const emitter = new EventEmitter();
  const ticks: Zone0Tick[] = [];
  const orderBooks: Zone0OrderBook[] = [];
  const newsItems: Zone0NewsItem[] = [];
  const boardPosts: Zone0BoardPost[] = [];
  const telegramMessages: Zone0TelegramMessage[] = [];

  let lastFrameAt: string | null = null;

  return {
    emitter,
    nextFrame: ({ targetSymbol, previousTick }) => {
      const symbol = pickNextSymbol(targetSymbol);
      const tick = ingestKisTick(symbol, previousTick);
      const orderBook = ingestKisOrderBook(tick);
      const frameNews = ingestNews(symbol);
      const frameBoard = ingestBoardPosts(symbol);
      const frameTelegram = ingestTelegram(symbol);
      const sentimentPulse = makeSentimentPulse(frameNews, frameBoard, frameTelegram);
      const receivedAt = nowIso();

      pushBuffered(ticks, tick);
      pushBuffered(orderBooks, orderBook);
      frameNews.forEach((item) => pushBuffered(newsItems, item));
      frameBoard.forEach((post) => pushBuffered(boardPosts, post));
      frameTelegram.forEach((message) => pushBuffered(telegramMessages, message));
      lastFrameAt = receivedAt;

      const frame: Zone0Frame = {
        tick,
        orderBook,
        newsItems: frameNews,
        boardPosts: frameBoard,
        telegramMessages: frameTelegram,
        sentimentPulse,
        receivedAt
      };

      emitter.emit("zone1:tick", {
        tick,
        orderBook,
        emittedAt: receivedAt
      });

      emitter.emit("zone4:context", {
        symbol,
        sentimentPulse,
        newsItems: frameNews,
        boardPosts: frameBoard,
        telegramMessages: frameTelegram,
        emittedAt: receivedAt
      });

      emitter.emit("zone0:raw", frame);

      return frame;
    },
    getBufferSnapshot: () => ({
      ticks: [...ticks],
      orderBooks: [...orderBooks],
      newsItems: [...newsItems],
      boardPosts: [...boardPosts],
      telegramMessages: [...telegramMessages],
      lastFrameAt
    })
  };
}

function pushBuffered<T>(buffer: T[], item: T): void {
  buffer.push(item);
  if (buffer.length > MAX_BUFFER_SIZE) {
    buffer.shift();
  }
}

function pickNextSymbol(current: string): string {
  if (Math.random() < 0.25) {
    return SYMBOL_POOL[randInt(0, SYMBOL_POOL.length - 1)] ?? current;
  }
  return current;
}

function ingestKisTick(symbol: string, previousTick: Zone0Tick): Zone0Tick {
  const basePrice = symbol === previousTick.symbol ? previousTick.price : BASE_PRICE_BY_SYMBOL[symbol] ?? 50_000;
  const drift = randFloat(-0.012, 0.014);
  const price = Math.round(clamp(basePrice * (1 + drift), 2_000, 600_000));
  const volume = Math.round(clamp(previousTick.volume * randFloat(0.72, 1.55), 800, 2_000_000));

  return {
    symbol,
    price,
    volume,
    bidDepth: Math.round(clamp(previousTick.bidDepth * randFloat(0.78, 1.24), 50_000, 2_500_000)),
    askDepth: Math.round(clamp(previousTick.askDepth * randFloat(0.74, 1.2), 50_000, 2_500_000)),
    timestamp: nowIso()
  };
}

function ingestKisOrderBook(tick: Zone0Tick): Zone0OrderBook {
  const step = Math.max(1, Math.round(tick.price * 0.0004));
  const asks: Zone0OrderBookLevel[] = [];
  const bids: Zone0OrderBookLevel[] = [];

  for (let level = 1; level <= 10; level += 1) {
    asks.push({
      price: tick.price + step * level,
      qty: randInt(500, 45_000)
    });
    bids.push({
      price: Math.max(1, tick.price - step * level),
      qty: randInt(500, 45_000)
    });
  }

  const totalAskDepth = asks.reduce((acc, level) => acc + level.qty, 0);
  const totalBidDepth = bids.reduce((acc, level) => acc + level.qty, 0);

  return {
    symbol: tick.symbol,
    asks,
    bids,
    totalAskDepth,
    totalBidDepth,
    source: "KIS_H0STASP0",
    timestamp: nowIso()
  };
}

function ingestNews(symbol: string): Zone0NewsItem[] {
  if (Math.random() > 0.55) {
    return [];
  }

  const count = randInt(1, 2);
  const list: Zone0NewsItem[] = [];
  for (let i = 0; i < count; i += 1) {
    const tpl = NEWS_TEMPLATES[randInt(0, NEWS_TEMPLATES.length - 1)];
    if (!tpl) {
      continue;
    }
    list.push({
      id: shortId("NEWS"),
      symbol,
      headline: `[${symbol}] ${tpl.headline}`,
      body: tpl.body,
      sentimentHint: tpl.sentimentHint,
      source: "NAVER_NEWS",
      timestamp: nowIso()
    });
  }

  return list;
}

function ingestBoardPosts(symbol: string): Zone0BoardPost[] {
  const count = Math.random() < 0.75 ? randInt(0, 3) : 0;
  const list: Zone0BoardPost[] = [];

  for (let i = 0; i < count; i += 1) {
    const tpl = BOARD_TEMPLATES[randInt(0, BOARD_TEMPLATES.length - 1)];
    if (!tpl) {
      continue;
    }

    list.push({
      id: shortId("BOARD"),
      symbol,
      title: tpl.title,
      content: tpl.content,
      sentimentHint: tpl.sentimentHint,
      source: "NAVER_BOARD",
      timestamp: nowIso()
    });
  }

  return list;
}

function ingestTelegram(symbol: string): Zone0TelegramMessage[] {
  if (Math.random() > 0.42) {
    return [];
  }

  const count = randInt(1, 2);
  const list: Zone0TelegramMessage[] = [];

  for (let i = 0; i < count; i += 1) {
    const tpl = TELEGRAM_TEMPLATES[randInt(0, TELEGRAM_TEMPLATES.length - 1)];
    if (!tpl) {
      continue;
    }

    list.push({
      id: shortId("TG"),
      symbol,
      message: tpl.message,
      sentimentHint: tpl.sentimentHint,
      priority: tpl.priority,
      source: "TELEGRAM",
      timestamp: nowIso()
    });
  }

  return list;
}

function makeSentimentPulse(
  news: Zone0NewsItem[],
  board: Zone0BoardPost[],
  telegram: Zone0TelegramMessage[]
): Zone0SentimentPulse {
  const hints = [...news.map((item) => item.sentimentHint), ...board.map((post) => post.sentimentHint), ...telegram.map((msg) => msg.sentimentHint)];
  const score = hints.length === 0 ? 0 : hints.reduce((acc, hint) => acc + hint, 0) / hints.length;
  const rawVelocity = news.length * 22 + board.length * 14 + telegram.length * 30 + randFloat(-4, 8);

  return {
    score: Number(clamp(score, -1, 1).toFixed(2)),
    velocity: Number(clamp(rawVelocity, 0, 100).toFixed(2)),
    signalCount: hints.length
  };
}
