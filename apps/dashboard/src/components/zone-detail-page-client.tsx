"use client";

import type { DashboardSnapshot } from "@stock/contracts";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Bot,
  Brain,
  CandlestickChart,
  Database,
  FileSearch,
  History,
  MessageSquareWarning,
  RefreshCw
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { formatKrw, formatTs } from "@/lib/format";
import { decisionActionKo, madnessStageKo, patternClassKo, riskFlagKo, sourceKo } from "@/lib/korean";
import { useDashboardHealth } from "@/lib/use-dashboard-health";
import { useDashboardSocket } from "@/lib/use-dashboard-socket";
import { ZONE_IDS, type ZoneId } from "@/lib/zone-meta";
import { useDashboardStore } from "@/lib/store";

import { Panel } from "./panel";

const ORCHESTRATOR_URL = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ?? "http://localhost:5001";
const POLL_MS = 3000;

const ZONE_TITLE: Record<ZoneId, string> = {
  "0": "Raw Ingestion",
  "1": "Technical Metrics",
  "2": "Fundamental Filter",
  "3": "Pattern Vectors",
  "4": "Madness & Sentiment",
  "5": "Master AI Agent",
  "6": "History & Feedback"
};

const ZONE_ICON: Record<ZoneId, typeof Database> = {
  "0": Database,
  "1": CandlestickChart,
  "2": FileSearch,
  "3": Brain,
  "4": MessageSquareWarning,
  "5": Bot,
  "6": History
};

const ZONE_ENDPOINT: Record<ZoneId, string> = {
  "0": "/api/zone0/buffer",
  "1": "/api/zone1/state",
  "2": "/api/zone2/state",
  "3": "/api/zone3/state",
  "4": "/api/zone4/state",
  "5": "/api/zone5/state",
  "6": "/api/zone6/state"
};

type MetricRow = { label: string; value: string; tone?: string };

type ApiState = {
  loading: boolean;
  error: string | null;
  payload: unknown;
  fetchedAt: string | null;
};

function num(value: unknown, digits = 0): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  return value.toLocaleString("ko-KR", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function ts(iso: unknown): string {
  if (typeof iso !== "string" || iso.length === 0) {
    return "-";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return `${date.toLocaleDateString("ko-KR")} ${date.toLocaleTimeString("ko-KR", { hour12: false })}`;
}

function pick(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    return undefined;
  }
  return (obj as Record<string, unknown>)[key];
}

function asArray(obj: unknown, key: string): unknown[] {
  const value = pick(obj, key);
  return Array.isArray(value) ? value : [];
}

export function ZoneDetailClientPage({ zoneId }: { zoneId: ZoneId }) {
  useDashboardSocket();
  useDashboardHealth();

  const connected = useDashboardStore((state) => state.connected);
  const health = useDashboardStore((state) => state.health);
  const snapshot = useDashboardStore((state) => state.snapshot);
  const zone0Raw = useDashboardStore((state) => state.zone0Raw);
  const tickLogs = useDashboardStore((state) => state.tickLogs);
  const brainLogs = useDashboardStore((state) => state.brainLogs);
  const newsFeed = useDashboardStore((state) => state.newsBoardFeed);
  const telegramFeed = useDashboardStore((state) => state.telegramFeed);

  const [reloadKey, setReloadKey] = useState(0);
  const [apiState, setApiState] = useState<ApiState>({ loading: true, error: null, payload: null, fetchedAt: null });

  useEffect(() => {
    let alive = true;
    let pending: AbortController | null = null;

    const run = async () => {
      pending?.abort();
      const controller = new AbortController();
      pending = controller;

      setApiState((prev) => ({ ...prev, loading: prev.payload === null, error: null }));

      try {
        const response = await fetch(`${ORCHESTRATOR_URL}${ZONE_ENDPOINT[zoneId]}`, {
          method: "GET",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          signal: controller.signal
        });
        if (!response.ok) {
          throw new Error(`zone request failed (${response.status})`);
        }
        const payload = (await response.json()) as unknown;
        if (!alive || controller.signal.aborted) {
          return;
        }
        setApiState({ loading: false, error: null, payload, fetchedAt: new Date().toISOString() });
      } catch (error) {
        if (!alive || controller.signal.aborted) {
          return;
        }
        const message = error instanceof Error ? error.message : "zone request failed";
        setApiState((prev) => ({ ...prev, loading: false, error: message }));
      }
    };

    void run();
    const timer = setInterval(run, POLL_MS);

    return () => {
      alive = false;
      pending?.abort();
      clearInterval(timer);
    };
  }, [reloadKey, zoneId]);

  const zoneIndex = ZONE_IDS.indexOf(zoneId);
  const prevZone = zoneIndex > 0 ? ZONE_IDS[zoneIndex - 1] ?? null : null;
  const nextZone = zoneIndex < ZONE_IDS.length - 1 ? ZONE_IDS[zoneIndex + 1] ?? null : null;

  const ZoneIcon = ZONE_ICON[zoneId];

  const rows = useMemo(() => buildRows(zoneId, snapshot, health, apiState.payload, zone0Raw), [zoneId, snapshot, health, apiState.payload, zone0Raw]);
  const logs = useMemo(() => buildLogs(zoneId, snapshot, tickLogs, brainLogs, newsFeed, telegramFeed), [zoneId, snapshot, tickLogs, brainLogs, newsFeed, telegramFeed]);

  return (
    <main className="min-h-screen bg-slate-950 p-2 text-slate-100">
      <header className="panel-surface mb-3 rounded-2xl p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ZoneIcon className="h-5 w-5 text-cyan-300" />
            <h1 className="text-lg font-semibold">Zone {zoneId} · {ZONE_TITLE[zoneId]}</h1>
            <span className={`rounded-full border px-2 py-0.5 text-[11px] ${connected ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300" : "border-rose-500/40 bg-rose-500/10 text-rose-300"}`}>
              {connected ? "소켓 연결" : "소켓 끊김"}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-slate-700 bg-slate-900 px-2 py-0.5 text-[11px] text-slate-300">{snapshot.targetSymbol}</span>
            <span className="rounded-full border border-slate-700 bg-slate-900 px-2 py-0.5 text-[11px] text-slate-300">API {ts(apiState.fetchedAt)}</span>
            <button
              type="button"
              onClick={() => setReloadKey((value) => value + 1)}
              className="inline-flex items-center gap-1 rounded border border-cyan-500/50 bg-cyan-500/10 px-2 py-1 text-xs text-cyan-200"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${apiState.loading ? "animate-spin" : ""}`} />
              새로고침
            </button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Link href="/" className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200">
            <ArrowLeft className="h-3.5 w-3.5" /> Dashboard
          </Link>
          {prevZone ? <Link href={`/zone/${prevZone}`} className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200">Prev Z{prevZone}</Link> : null}
          {nextZone ? <Link href={`/zone/${nextZone}`} className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200">Next Z{nextZone}<ArrowRight className="h-3.5 w-3.5" /></Link> : null}

          <div className="ml-auto flex flex-wrap gap-1">
            {ZONE_IDS.map((id) => (
              <Link
                key={id}
                href={`/zone/${id}`}
                className={`rounded border px-2 py-1 text-xs ${id === zoneId ? "border-cyan-400 bg-cyan-500/20 text-cyan-200" : "border-slate-700 bg-slate-900 text-slate-300"}`}
              >
                Z{id}
              </Link>
            ))}
          </div>
        </div>

        {apiState.error ? <p className="mt-2 text-xs text-rose-300">{apiState.error}</p> : null}
      </header>

      <section className="grid gap-3 xl:grid-cols-[1.2fr_1fr]">
        <Panel title="Live Metrics" subtitle="현재 연결된 실데이터 기반 지표" className="h-full">
          <div className="grid gap-2 sm:grid-cols-2">
            {rows.map((row) => (
              <div key={row.label} className="rounded-lg border border-slate-700 bg-slate-950/70 p-2">
                <p className="text-[11px] text-slate-400">{row.label}</p>
                <p className={`mt-1 text-sm font-semibold ${row.tone ?? "text-slate-100"}`}>{row.value}</p>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title="Live Stream" subtitle="Zone별 스트림/로그" className="h-full">
          <div className="terminal-font h-[520px] overflow-auto space-y-1 text-xs text-emerald-300">
            {logs.length === 0 ? <p className="text-slate-500">로그 대기 중...</p> : logs.map((line) => <p key={line}>{line}</p>)}
          </div>
        </Panel>
      </section>

      <footer className="mt-3 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs text-slate-400">
        <div className="flex flex-wrap items-center gap-3">
          <span className="inline-flex items-center gap-1"><Activity className="h-3.5 w-3.5 text-emerald-300" /> Tick {health?.tickCount ?? "-"}</span>
          <span>Pattern {patternClassKo(snapshot.pattern.klass)} {(snapshot.pattern.similarity * 100).toFixed(1)}%</span>
          <span>Madness {snapshot.madness.score.toFixed(1)} ({madnessStageKo(snapshot.madness.stage)})</span>
          <span>Decision {decisionActionKo(snapshot.decision.action)}</span>
        </div>
      </footer>
    </main>
  );
}

function buildRows(
  zoneId: ZoneId,
  snapshot: DashboardSnapshot,
  health: ReturnType<typeof useDashboardStore.getState>["health"],
  payload: unknown,
  zone0Raw: ReturnType<typeof useDashboardStore.getState>["zone0Raw"]
): MetricRow[] {
  const p = payload as Record<string, unknown> | null;

  if (zoneId === "0") {
    return [
      { label: "현재가", value: `${formatKrw(zone0Raw?.tick.price ?? snapshot.tick.price)}원`, tone: (zone0Raw?.tick.price ?? snapshot.tick.price) >= snapshot.tick.price ? "text-rose-300" : "text-blue-300" },
      { label: "단일 체결량", value: formatKrw(zone0Raw?.tick.volume ?? snapshot.tick.volume) },
      { label: "총 매수/매도 잔량", value: `${formatKrw(zone0Raw?.orderBook.totalBidDepth ?? snapshot.tick.bidDepth)} / ${formatKrw(zone0Raw?.orderBook.totalAskDepth ?? snapshot.tick.askDepth)}` },
      { label: "뉴스/종토방/텔레그램", value: `${num(health?.zone0.newsBuffered)} / ${num(health?.zone0.boardBuffered)} / ${num(health?.zone0.telegramBuffered)}` },
      { label: "DART/수급/거시 버퍼", value: `${num(health?.zone0.dartBuffered)} / ${num(health?.zone0.fundamentalBuffered)} / ${num(health?.zone0.macroBuffered)}` },
      { label: "마지막 프레임", value: ts(health?.zone0.lastFrameAt) }
    ];
  }

  if (zoneId === "1") {
    return [
      { label: "체결강도", value: snapshot.technical.volumePower.toFixed(2) },
      { label: "거래대금 스파이크", value: `${snapshot.technical.spikeRatio.toFixed(1)}%`, tone: snapshot.technical.spikeRatio >= 300 ? "text-rose-300" : "text-cyan-200" },
      { label: "MA 이격도", value: `${snapshot.technical.maDivergence.toFixed(2)}%`, tone: snapshot.technical.maDivergence >= 0 ? "text-rose-300" : "text-blue-300" },
      { label: "호가 잔량비", value: snapshot.technical.orderImbalance.toFixed(2) },
      { label: "지지/저항", value: `${formatKrw(snapshot.technical.support)} / ${formatKrw(snapshot.technical.resistance)}` },
      { label: "세션 MA3/MA5", value: `${num(pick(p, "ma3"), 2)} / ${num(pick(p, "ma5"), 2)}` }
    ];
  }

  if (zoneId === "2") {
    return [
      { label: "리스크 플래그", value: riskFlagKo(snapshot.fundamental.riskFlag), tone: snapshot.fundamental.riskFlag === "BLOCKED" ? "text-amber-300" : "text-emerald-300" },
      { label: "Provider / Source", value: `${sourceKo(pick(p, "provider") as string | null | undefined)} / ${sourceKo(pick(p, "source") as string | null | undefined)}` },
      { label: "Cache Size", value: num(pick(p, "cacheSize")) },
      { label: "Refresh/Stale", value: `${num(pick(p, "refreshTicks"))} / ${num(pick(p, "staleSeconds"))}` },
      { label: "최근 점검", value: ts(pick(p, "lastCheckedAt")) },
      { label: "이슈", value: snapshot.fundamental.issues.join(", ") || "-" }
    ];
  }

  if (zoneId === "3") {
    return [
      { label: "Pattern Class", value: patternClassKo(snapshot.pattern.klass) },
      { label: "Similarity", value: `${(snapshot.pattern.similarity * 100).toFixed(1)}%` },
      { label: "Matched Pattern", value: snapshot.pattern.matchedPatternId },
      { label: "Provider / Source", value: `${sourceKo(pick(p, "provider") as string | null | undefined)} / ${sourceKo(pick(p, "source") as string | null | undefined)}` },
      { label: "Vector Dim", value: num(pick(p, "vectorDim")) },
      { label: "Candle Count", value: num(pick(p, "candleCount")) }
    ];
  }

  if (zoneId === "4") {
    return [
      { label: "Madness Score", value: snapshot.madness.score.toFixed(1) },
      { label: "Stage", value: madnessStageKo(snapshot.madness.stage) },
      { label: "Sentiment", value: snapshot.madness.sentiment.toFixed(2), tone: snapshot.madness.sentiment >= 0 ? "text-rose-300" : "text-blue-300" },
      { label: "News Velocity", value: snapshot.madness.newsVelocity.toFixed(2) },
      { label: "signalRate1m", value: num(pick(p, "signalRate1m"), 2) },
      { label: "Threshold(2/3)", value: `${num(pick(p, "stage2Threshold"))} / ${num(pick(p, "stage3Threshold"))}` }
    ];
  }

  if (zoneId === "5") {
    return [
      { label: "Action", value: decisionActionKo(snapshot.decision.action) },
      { label: "Confidence", value: `${(snapshot.decision.confidenceScore * 100).toFixed(1)}%` },
      { label: "Suggested Weight", value: `${snapshot.decision.suggestedWeightPct.toFixed(0)}%` },
      { label: "Provider / Source", value: `${sourceKo(pick(p, "provider") as string | null | undefined)} / ${sourceKo(pick(p, "source") as string | null | undefined)}` },
      { label: "LLM Model", value: String(pick(p, "llmModel") ?? "-") },
      { label: "Last Error", value: String(pick(p, "lastError") ?? "없음") }
    ];
  }

  return [
    { label: "History WinRate", value: `${(snapshot.history.winRate * 100).toFixed(1)}%` },
    { label: "Similar Trade", value: snapshot.history.similarTradeId },
    { label: "Summary", value: snapshot.history.summary },
    { label: "Provider / Source", value: `${sourceKo(pick(p, "provider") as string | null | undefined)} / ${sourceKo(pick(p, "source") as string | null | undefined)}` },
    { label: "Record Count", value: num(pick(p, "recordCount")) },
    { label: "Last Ingested", value: `${String(pick(p, "lastIngestedTradeId") ?? "-")} / ${num(pick(p, "lastIngestedPnlPct"), 2)}%` }
  ];
}

function buildLogs(
  zoneId: ZoneId,
  snapshot: DashboardSnapshot,
  tickLogs: Array<{ id: string; text: string }>,
  brainLogs: Array<{ id: string; text: string }>,
  newsFeed: Array<{ id: string; source: string; symbol: string; title: string; sentimentHint: number; timestamp: string }>,
  telegramFeed: Array<{ id: string; symbol: string; message: string; priority: string; timestamp: string }>
): string[] {
  if (zoneId === "0") {
    const lines = [
      ...tickLogs.slice(0, 15).map((line) => line.text),
      ...newsFeed.slice(0, 10).map((item) => `[${formatTs(item.timestamp)}] ${item.symbol} ${item.source} ${item.title}`),
      ...telegramFeed.slice(0, 10).map((item) => `[${formatTs(item.timestamp)}] TG(${item.priority}) ${item.symbol} ${item.message}`)
    ];
    return lines;
  }

  if (zoneId === "1") {
    return tickLogs.slice(0, 30).map((line) => line.text);
  }

  if (zoneId === "2") {
    const riskLines = snapshot.fundamental.issues.map((issue) => `[RISK] ${issue}`);
    return riskLines.length > 0 ? riskLines : ["[RISK] 이슈 없음"];
  }

  if (zoneId === "3") {
    return [
      `[PATTERN] ${snapshot.pattern.matchedPatternId}`,
      `[PATTERN] class=${snapshot.pattern.klass}, similarity=${(snapshot.pattern.similarity * 100).toFixed(1)}%`,
      ...tickLogs.slice(0, 20).map((line) => line.text)
    ];
  }

  if (zoneId === "4") {
    return [
      ...newsFeed.slice(0, 15).map((item) => `[${formatTs(item.timestamp)}] ${item.title} (${item.sentimentHint >= 0 ? "+" : ""}${item.sentimentHint.toFixed(2)})`),
      ...telegramFeed.slice(0, 10).map((item) => `[${formatTs(item.timestamp)}] ${item.message}`)
    ];
  }

  if (zoneId === "5") {
    return brainLogs.slice(0, 36).map((line) => line.text);
  }

  const orderLines = snapshot.orderLog.slice(0, 30).map((order) => {
    return `[${formatTs(order.timestamp)}] ${order.symbol} ${order.side} ${order.qty}주 @ ${formatKrw(order.price)} (${order.status})`;
  });
  return orderLines;
}
