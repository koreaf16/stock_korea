"use client";

import { createEmptyDashboardSnapshot, type DashboardSnapshot, type Zone3MiningSocketEvent } from "@stock/contracts";
import { create } from "zustand";

import { formatKrw, formatTs } from "./format";
import { decisionActionKo, narrativeKo } from "./korean";
import type { OrchestratorHealth } from "./orchestrator-health";

const MAX_PRICE_POINTS = 150;
const MAX_TICK_LOGS = 36;
const MAX_BRAIN_LOGS = 24;
const MAX_FEED_ITEMS = 50;
const MAX_TELEGRAM_ITEMS = 50;
const MAX_TARGET_LOGS = 24;
const MAX_ZONE3_MINING_LOGS = 250;

export interface UiLogLine {
  id: string;
  text: string;
}

export interface Zone3MiningState {
  running: boolean;
  progress: number;
  lastMessage: string;
  lastUpdatedAt: string | null;
  processed: number;
  inserted: number;
  stats: {
    totalPatterns: number;
    classA: number;
    classC: number;
    classARatio: number;
    classCRatio: number;
    lastUpdatedAt: string | null;
  } | null;
  logs: UiLogLine[];
}

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
  priority: "LOW" | "MEDIUM" | "HIGH";
  source: "TELEGRAM";
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

export interface Zone0SentimentPulse {
  score: number;
  velocity: number;
  signalCount: number;
}

export interface Zone0RawFrame {
  tick: DashboardSnapshot["tick"];
  orderBook: Zone0OrderBook;
  newsItems: Zone0NewsItem[];
  boardPosts: Zone0BoardPost[];
  dartDisclosures?: Zone0DartDisclosure[];
  fundamentalData?: Zone0Fundamental[];
  globalContext?: DashboardSnapshot["globalContext"] | null;
  telegramMessages: Zone0TelegramMessage[];
  sentimentPulse: Zone0SentimentPulse;
  receivedAt: string;
}

export interface Zone0FeedItem {
  id: string;
  source: "NAVER_NEWS" | "NAVER_BOARD";
  symbol: string;
  title: string;
  content: string;
  sentimentHint: number;
  timestamp: string;
}

export type PriceDirection = "UP" | "DOWN" | "FLAT";

interface DashboardStore {
  connected: boolean;
  health: OrchestratorHealth | null;
  healthError: string | null;
  logSeq: number;
  symbolNames: Record<string, string>;
  snapshot: DashboardSnapshot;
  zone0Raw: Zone0RawFrame | null;
  priceDirection: PriceDirection;
  cumulativeVolume: number;
  newsBoardFeed: Zone0FeedItem[];
  telegramFeed: Zone0TelegramMessage[];
  priceSeries: number[];
  tickLogs: UiLogLine[];
  brainLogs: UiLogLine[];
  targetLogs: UiLogLine[];
  zone3Mining: Zone3MiningState;
  setConnected: (connected: boolean) => void;
  setHealth: (health: OrchestratorHealth) => void;
  setHealthError: (error: string | null) => void;
  mergeSymbolNames: (entries: Record<string, string>) => void;
  setSnapshot: (snapshot: DashboardSnapshot) => void;
  setZone0RawFrame: (frame: Zone0RawFrame) => void;
  setZone3MiningEvent: (event: Zone3MiningSocketEvent) => void;
  clearZone3MiningLogs: () => void;
}

export const useDashboardStore = create<DashboardStore>((set) => ({
  connected: false,
  health: null,
  healthError: null,
  logSeq: 0,
  symbolNames: {},
  snapshot: createEmptyDashboardSnapshot(),
  zone0Raw: null,
  priceDirection: "FLAT",
  cumulativeVolume: 0,
  newsBoardFeed: [],
  telegramFeed: [],
  priceSeries: [],
  tickLogs: [],
  brainLogs: [],
  targetLogs: [],
  zone3Mining: {
    running: false,
    progress: 0,
    lastMessage: "대기 중",
    lastUpdatedAt: null,
    processed: 0,
    inserted: 0,
    stats: null,
    logs: []
  },
  setConnected: (connected) => {
    set({ connected });
  },
  setHealth: (health) => {
    set({ health });
  },
  setHealthError: (healthError) => {
    set({ healthError });
  },
  mergeSymbolNames: (entries) => {
    set((state) => {
      if (!entries || Object.keys(entries).length === 0) {
        return state;
      }

      let changed = false;
      const next = { ...state.symbolNames };

      for (const [key, value] of Object.entries(entries)) {
        const symbol = normalizeSymbolCode(key);
        const name = String(value ?? "").trim();
        if (!symbol || !name) {
          continue;
        }
        if (next[symbol] === name) {
          continue;
        }
        next[symbol] = name;
        changed = true;
      }

      if (!changed) {
        return state;
      }

      return {
        ...state,
        symbolNames: next
      };
    });
  },
  setSnapshot: (snapshot) => {
    set((state) => {
      if (state.snapshot.lastUpdatedAt === snapshot.lastUpdatedAt) {
        return state;
      }

      const nextLogSeq = state.logSeq + 1;
      const tickLine = `[${formatTs(snapshot.tick.timestamp)}] ${snapshot.tick.symbol} ${formatKrw(snapshot.tick.price)}원 거래량:${formatKrw(snapshot.tick.volume)}`;
      const brainLine = `[${formatTs(snapshot.decision.generatedAt)}] [존5_${decisionActionKo(snapshot.decision.action)}] ${narrativeKo(
        snapshot.decision.reasoning
      )}`;
      const targetChanged = state.snapshot.targetSymbol !== snapshot.targetSymbol;
      const reasonChanged = state.snapshot.targetReason !== snapshot.targetReason;
      const targetLine = `[${formatTs(snapshot.lastUpdatedAt)}] 타겟 ${snapshot.targetSymbol} - ${snapshot.targetReason}`;
      const tickId = `tick:${nextLogSeq}:${snapshot.tick.timestamp}:${snapshot.tick.symbol}`;
      const brainId = `brain:${nextLogSeq}:${snapshot.decision.generatedAt}:${snapshot.decision.decisionId}`;
      const targetId = `target:${nextLogSeq}:${snapshot.lastUpdatedAt}:${snapshot.targetSymbol}`;
      const nextTargetLogs =
        targetChanged || reasonChanged
          ? [{ id: targetId, text: targetLine }, ...state.targetLogs].slice(0, MAX_TARGET_LOGS)
          : state.targetLogs;

      return {
        logSeq: nextLogSeq,
        snapshot,
        priceSeries: [...state.priceSeries, snapshot.tick.price].slice(-MAX_PRICE_POINTS),
        tickLogs: [{ id: tickId, text: tickLine }, ...state.tickLogs].slice(0, MAX_TICK_LOGS),
        brainLogs: [{ id: brainId, text: brainLine }, ...state.brainLogs].slice(0, MAX_BRAIN_LOGS),
        targetLogs: nextTargetLogs
      };
    });
  },
  setZone0RawFrame: (frame) => {
    set((state) => {
      const nextSymbol = frame.tick.symbol;
      const prevTick = state.zone0Raw?.tick;
      const sameSymbol = prevTick?.symbol === nextSymbol;
      const previousPrice = sameSymbol ? prevTick?.price ?? frame.tick.price : frame.tick.price;
      const priceDirection: PriceDirection =
        frame.tick.price > previousPrice ? "UP" : frame.tick.price < previousPrice ? "DOWN" : "FLAT";

      const cumulativeVolume = sameSymbol ? state.cumulativeVolume + Math.max(0, frame.tick.volume) : Math.max(0, frame.tick.volume);

      const mergedFeed: Zone0FeedItem[] = [
        ...frame.newsItems.map((item) => ({
          id: `news:${item.id}`,
          source: item.source,
          symbol: item.symbol,
          title: item.headline,
          content: item.body,
          sentimentHint: item.sentimentHint,
          timestamp: item.timestamp
        })),
        ...frame.boardPosts.map((item) => ({
          id: `board:${item.id}`,
          source: item.source,
          symbol: item.symbol,
          title: item.title,
          content: item.content,
          sentimentHint: item.sentimentHint,
          timestamp: item.timestamp
        })),
        ...state.newsBoardFeed
      ].slice(0, MAX_FEED_ITEMS);

      const telegramFeed = [...frame.telegramMessages, ...state.telegramFeed].slice(0, MAX_TELEGRAM_ITEMS);

      return {
        zone0Raw: frame,
        priceDirection,
        cumulativeVolume,
        newsBoardFeed: mergedFeed,
        telegramFeed
      };
    });
  },
  setZone3MiningEvent: (event) => {
    set((state) => {
      const level = event.level ?? (event.type === "error" ? "error" : event.type === "completed" ? "info" : "info");
      const prefix = level === "error" ? "[ERR]" : level === "warn" ? "[WARN]" : "[INFO]";
      const logLine = `[${formatTs(event.timestamp)}] ${prefix} ${event.message}`;
      const logId = `z3m:${state.logSeq + 1}:${event.timestamp}`;

      const nextStats =
        event.stats ??
        state.zone3Mining.stats;

      return {
        logSeq: state.logSeq + 1,
        zone3Mining: {
          running: event.running,
          progress: event.progress,
          lastMessage: event.message,
          lastUpdatedAt: event.timestamp,
          processed: event.processed ?? state.zone3Mining.processed,
          inserted: event.inserted ?? state.zone3Mining.inserted,
          stats: nextStats,
          logs:
            event.type === "status" && event.message === "idle"
              ? state.zone3Mining.logs
              : [{ id: logId, text: logLine }, ...state.zone3Mining.logs].slice(0, MAX_ZONE3_MINING_LOGS)
        }
      };
    });
  },
  clearZone3MiningLogs: () => {
    set((state) => ({
      zone3Mining: {
        ...state.zone3Mining,
        logs: []
      }
    }));
  }
}));

function normalizeSymbolCode(raw: string): string | null {
  const digits = String(raw ?? "").trim().replace(/[^\d]/g, "");
  if (digits.length < 6) {
    return null;
  }
  return digits.slice(0, 6);
}
