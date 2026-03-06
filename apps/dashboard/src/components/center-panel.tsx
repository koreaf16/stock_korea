"use client";

import type { DashboardSnapshot } from "@stock/contracts";
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  LineSeries,
  createChart,
  LineStyle,
  type AreaData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";

import { formatPct } from "@/lib/format";
import { decisionActionKo, madnessStageKo, narrativeKo, patternClassKo, sourceKo } from "@/lib/korean";
import type { OrchestratorHealth } from "@/lib/orchestrator-health";
import type { UiLogLine } from "@/lib/store";

import { Panel } from "./panel";

interface CenterPanelProps {
  snapshot: DashboardSnapshot;
  health: OrchestratorHealth | null;
  priceSeries: number[];
  brainLogs: UiLogLine[];
}

interface CandlePoint {
  time: UTCTimestamp;
  open: number;
  high: number;
  low: number;
  close: number;
}

type ViewMode = "1m" | "3m";

function toEpochSeconds(iso: string | undefined): number {
  const parsed = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(parsed)) {
    return Math.floor(Date.now() / 1_000);
  }
  return Math.floor(parsed / 1_000);
}

function buildCandles(series: number[], viewMode: ViewMode, lastTickAt: string): CandlePoint[] {
  if (series.length < 2) {
    return [];
  }

  const targetCandles = viewMode === "1m" ? 56 : 36;
  const bucketSize = Math.max(1, Math.floor(series.length / targetCandles));
  const intervalSec = viewMode === "1m" ? 60 : 180;

  const chunks: number[][] = [];
  for (let start = 0; start < series.length; start += bucketSize) {
    const chunk = series.slice(start, Math.min(start + bucketSize, series.length));
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
  }

  const endTime = toEpochSeconds(lastTickAt);
  const firstTime = endTime - (chunks.length - 1) * intervalSec;

  return chunks.map((chunk, index) => {
    const open = chunk[0] ?? 0;
    const close = chunk[chunk.length - 1] ?? open;
    const high = Math.max(...chunk);
    const low = Math.min(...chunk);
    return {
      time: (firstTime + index * intervalSec) as UTCTimestamp,
      open,
      high,
      low,
      close
    };
  });
}

function buildGhostSeries(candles: CandlePoint[], klass: DashboardSnapshot["pattern"]["klass"], viewMode: ViewMode): LineData<UTCTimestamp>[] {
  if (candles.length < 6) {
    return [];
  }

  const tail = candles.slice(-18).map((item) => item.close);
  const returns: number[] = [];
  for (let index = 1; index < tail.length; index += 1) {
    const prev = tail[index - 1];
    const curr = tail[index];
    if (prev === undefined || curr === undefined) {
      continue;
    }
    const change = prev === 0 ? 0 : (curr - prev) / prev;
    returns.push(Math.max(-0.05, Math.min(0.05, change)));
  }

  const avgReturn = returns.length > 0 ? returns.reduce((acc, value) => acc + value, 0) / returns.length : 0;
  const intervalSec = viewMode === "1m" ? 60 : 180;
  const steps = 14;
  const lastCandle = candles[candles.length - 1];
  if (!lastCandle) {
    return [];
  }

  let projected = lastCandle.close;
  const ghost: LineData<UTCTimestamp>[] = [{ time: lastCandle.time, value: projected }];

  for (let step = 1; step <= steps; step += 1) {
    const templateReturn = returns[(step - 1) % Math.max(1, returns.length)] ?? avgReturn;
    let directionalReturn = templateReturn * 0.6 + avgReturn * 0.4;

    if (klass === "CLASS_A") {
      directionalReturn = Math.max(0, directionalReturn) * 1.12 + avgReturn * 0.12;
    } else if (klass === "CLASS_C") {
      directionalReturn = Math.min(0, directionalReturn) * 1.12 + avgReturn * 0.12;
    }

    directionalReturn = Math.max(-0.03, Math.min(0.03, directionalReturn));
    projected = Math.max(1, projected * (1 + directionalReturn));

    ghost.push({
      time: (lastCandle.time + step * intervalSec) as UTCTimestamp,
      value: projected
    });
  }

  return ghost;
}

function gaugeGradient(score: number): string {
  const pct = Math.max(0, Math.min(100, score));
  if (pct >= 75) {
    return `conic-gradient(#f43f5e ${pct}%, rgba(15, 23, 42, 0.2) 0)`;
  }
  if (pct >= 55) {
    return `conic-gradient(#f59e0b ${pct}%, rgba(15, 23, 42, 0.2) 0)`;
  }
  return `conic-gradient(#38bdf8 ${pct}%, rgba(15, 23, 42, 0.2) 0)`;
}

function TacticalChart({
  snapshot,
  health,
  priceSeries,
  viewMode
}: {
  snapshot: DashboardSnapshot;
  health: OrchestratorHealth | null;
  priceSeries: number[];
  viewMode: ViewMode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const ghostLineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const ghostAreaRef = useRef<ISeriesApi<"Area"> | null>(null);
  const supportLineRef = useRef<IPriceLine | null>(null);
  const resistanceLineRef = useRef<IPriceLine | null>(null);

  const candles = useMemo(() => buildCandles(priceSeries, viewMode, snapshot.tick.timestamp), [priceSeries, snapshot.tick.timestamp, viewMode]);
  const ghostSeries = useMemo(
    () => buildGhostSeries(candles, snapshot.pattern.klass, viewMode),
    [candles, snapshot.pattern.klass, viewMode]
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const chart = createChart(container, {
      width: container.clientWidth,
      height: container.clientHeight,
      layout: {
        background: { type: ColorType.Solid, color: "rgba(2, 6, 23, 0.78)" },
        textColor: "#cbd5e1",
        fontFamily: "JetBrains Mono, D2Coding, Consolas, monospace"
      },
      grid: {
        vertLines: { color: "rgba(71,85,105,0.18)" },
        horzLines: { color: "rgba(71,85,105,0.18)" }
      },
      rightPriceScale: {
        borderColor: "rgba(100,116,139,0.35)",
        autoScale: true
      },
      timeScale: {
        borderColor: "rgba(100,116,139,0.35)",
        rightOffset: 4,
        timeVisible: true,
        secondsVisible: false
      },
      crosshair: {
        vertLine: {
          labelBackgroundColor: "rgba(8,47,73,0.95)"
        },
        horzLine: {
          labelBackgroundColor: "rgba(8,47,73,0.95)"
        }
      }
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#f87171",
      downColor: "#60a5fa",
      borderVisible: false,
      wickUpColor: "#fca5a5",
      wickDownColor: "#93c5fd",
      priceLineVisible: true,
      lastValueVisible: true
    });

    const ghostLine = chart.addSeries(LineSeries, {
      color: "rgba(226,232,240,0.58)",
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      lastValueVisible: false,
      priceLineVisible: false
    });

    const ghostArea = chart.addSeries(AreaSeries, {
      lineColor: "rgba(148,163,184,0.28)",
      topColor: "rgba(148,163,184,0.18)",
      bottomColor: "rgba(148,163,184,0.02)",
      lineWidth: 1,
      lastValueVisible: false,
      priceLineVisible: false
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    ghostLineRef.current = ghostLine;
    ghostAreaRef.current = ghostArea;

    const resize = () => {
      chart.applyOptions({
        width: container.clientWidth,
        height: container.clientHeight
      });
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      supportLineRef.current = null;
      resistanceLineRef.current = null;
      candleSeriesRef.current = null;
      ghostLineRef.current = null;
      ghostAreaRef.current = null;
      chartRef.current = null;
      chart.remove();
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    const ghostLine = ghostLineRef.current;
    const ghostArea = ghostAreaRef.current;
    if (!chart || !candleSeries || !ghostLine || !ghostArea) {
      return;
    }

    candleSeries.setData(candles);
    ghostLine.setData(ghostSeries);
    ghostArea.setData(
      ghostSeries.map((point) => ({
        time: point.time,
        value: point.value
      })) as AreaData<UTCTimestamp>[]
    );

    if (supportLineRef.current) {
      candleSeries.removePriceLine(supportLineRef.current);
      supportLineRef.current = null;
    }
    if (resistanceLineRef.current) {
      candleSeries.removePriceLine(resistanceLineRef.current);
      resistanceLineRef.current = null;
    }

    if (snapshot.technical.support > 0) {
      supportLineRef.current = candleSeries.createPriceLine({
        price: snapshot.technical.support,
        color: "rgba(16,185,129,0.85)",
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "S"
      });
    }
    if (snapshot.technical.resistance > 0) {
      resistanceLineRef.current = candleSeries.createPriceLine({
        price: snapshot.technical.resistance,
        color: "rgba(56,189,248,0.9)",
        lineWidth: 2,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "R"
      });
    }

    chart.timeScale().fitContent();
  }, [candles, ghostSeries, snapshot.technical.resistance, snapshot.technical.support]);

  return (
    <div className="signal-grid relative h-full overflow-hidden rounded-xl border border-slate-700/60 bg-slate-950/65 p-3">
      <div ref={containerRef} className="h-full w-full" />

      <div className="pointer-events-none absolute left-3 top-3 flex max-w-[calc(100%-92px)] flex-wrap items-center gap-2 text-[11px]">
        <span className="max-w-[160px] truncate rounded-md border border-slate-700/80 bg-slate-900/80 px-2 py-1 text-slate-200">
          패턴 {patternClassKo(snapshot.pattern.klass)}
        </span>
        <span className="max-w-[160px] truncate rounded-md border border-slate-700/80 bg-slate-900/80 px-2 py-1 text-slate-200">
          공급원 {sourceKo(health?.zone3.source)}
        </span>
        <span className="max-w-[140px] truncate rounded-md border border-slate-700/80 bg-slate-900/80 px-2 py-1 text-slate-200">
          벡터 {health?.zone3.vectorDim ?? "-"}차원
        </span>
        <span className="max-w-[140px] truncate rounded-md border border-slate-700/80 bg-slate-900/80 px-2 py-1 text-slate-200">
          급증 {snapshot.technical.spikeRatio.toFixed(1)}%
        </span>
      </div>

      <div className="pointer-events-none absolute inset-x-3 bottom-3 flex flex-wrap items-center justify-between gap-2 text-xs">
        <div className="min-w-0 rounded-md border border-slate-700/80 bg-slate-900/80 px-2 py-1 text-slate-200 sm:max-w-[58%]">
          <p className="truncate">
            지지선 {snapshot.technical.support.toLocaleString()} / 저항선 {snapshot.technical.resistance.toLocaleString()}
          </p>
        </div>
        <div className="min-w-0 rounded-md border border-slate-700/80 bg-slate-900/80 px-2 py-1 text-slate-200 sm:max-w-[42%]">
          <p className="truncate text-right">
            {viewMode === "1m" ? "1분 차트" : "3분 차트"} | 틱 {health?.tickCount ?? "-"} | 현재가 {snapshot.tick.price.toLocaleString()}
          </p>
        </div>
      </div>
    </div>
  );
}

export function CenterPanel({ snapshot, health, priceSeries, brainLogs }: CenterPanelProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("1m");

  const madnessGauge = gaugeGradient(snapshot.madness.score);

  const madnessLabel =
    snapshot.madness.stage === "STAGE_3"
      ? "광기 구간"
      : snapshot.madness.stage === "STAGE_2"
        ? "폭발 구간"
        : "발화 구간";

  const systemLines = [
    `[시스템] 존3 패턴 ${patternClassKo(snapshot.pattern.klass)} / ${(snapshot.pattern.similarity * 100).toFixed(1)}% 일치`,
    `[시스템] 존4 단계 ${madnessStageKo(snapshot.madness.stage)}, 점수 ${snapshot.madness.score.toFixed(1)}`,
    `[시스템] 존6 승률 ${(snapshot.history.winRate * 100).toFixed(1)}% | 유사 ${snapshot.history.similarTradeId}`,
    `[시스템] 존5 판단 ${decisionActionKo(snapshot.decision.action)} / 신뢰도 ${(snapshot.decision.confidenceScore * 100).toFixed(1)}%`
  ];

  const mergedBrainLogs = [...systemLines.map((text) => ({ id: `sys:${text}`, text })), ...brainLogs].slice(0, 36);

  return (
    <div className="grid h-full min-w-0 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-3">
      <Panel
        title="전술 차트 (존 1 + 존 3)"
        subtitle="lightweight-charts 캔들 / 지지·저항 Price Line / 패턴 고스트 오버레이"
        className="min-w-0"
        rightSlot={
          <div className="flex flex-wrap items-center justify-end gap-2 text-[11px]">
            <div className="flex items-center gap-1 rounded-full border border-slate-700/80 bg-slate-900/80 p-1">
              <button
                type="button"
                onClick={() => setViewMode("1m")}
                className={`rounded-full px-2 py-0.5 ${
                  viewMode === "1m" ? "bg-cyan-500/20 text-cyan-300" : "text-slate-300 hover:bg-slate-800"
                }`}
              >
                1분
              </button>
              <button
                type="button"
                onClick={() => setViewMode("3m")}
                className={`rounded-full px-2 py-0.5 ${
                  viewMode === "3m" ? "bg-cyan-500/20 text-cyan-300" : "text-slate-300 hover:bg-slate-800"
                }`}
              >
                3분
              </button>
            </div>
            <span className="rounded-full border border-slate-700/80 bg-slate-900/80 px-2 py-0.5 text-slate-300">
              {patternClassKo(snapshot.pattern.klass)}
            </span>
            <span className="rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 text-cyan-300">
              {(snapshot.pattern.similarity * 100).toFixed(1)}%
            </span>
          </div>
        }
      >
        <div className="h-[420px] min-h-[360px] w-full md:h-[500px]">
          <TacticalChart snapshot={snapshot} health={health} priceSeries={priceSeries} viewMode={viewMode} />
        </div>
      </Panel>

      <Panel title="인공지능 브레인 터미널 (존 4 / 5 / 6)" subtitle="광기게이지 + 판단로그 + 유사이력 피드백" className="h-full min-w-0">
        <div className="grid h-full grid-cols-1 gap-3 2xl:grid-cols-[240px_minmax(0,1fr)_260px]">
          <div className="rounded-xl border border-slate-700/60 bg-slate-900/65 p-3">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">존 4 광기 게이지</p>

            <div className="mt-3 flex items-center justify-center">
              <div className="relative h-36 w-36 rounded-full p-2" style={{ background: madnessGauge }}>
                <div className="flex h-full w-full flex-col items-center justify-center rounded-full bg-slate-950/95">
                  <p className="text-3xl font-semibold text-slate-100">{snapshot.madness.score.toFixed(0)}</p>
                  <p className="text-[11px] uppercase tracking-wide text-slate-400">{madnessStageKo(snapshot.madness.stage)}</p>
                </div>
              </div>
            </div>

            <p className="mt-3 text-xs text-slate-300">
              {madnessLabel} / 감성 {formatPct(snapshot.madness.sentiment * 100)} / 뉴스 속도
              {snapshot.madness.newsVelocity.toFixed(1)}
            </p>
            <p className="mt-1 text-[11px] text-slate-400">
              제공자 {sourceKo(health?.zone4.provider)} / 공급원 {sourceKo(health?.zone4.source)}
            </p>
          </div>

          <div className="rounded-xl border border-slate-700/60 bg-slate-950/72 p-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">존 5 추론 로그</p>
              <span className="rounded-full border border-slate-700/80 bg-slate-900/80 px-2 py-0.5 text-[11px] text-slate-300">
                {sourceKo(health?.zone5.source)} / {sourceKo(health?.zone5.provider)}
              </span>
            </div>
            <div className="terminal-font h-[180px] overflow-auto text-xs text-tactical-terminal">
              {mergedBrainLogs.map((line) => (
                <p key={line.id} className="truncate leading-relaxed">
                  {line.text}
                </p>
              ))}
            </div>
            <div className="mt-2 rounded-lg border border-slate-700/70 bg-slate-900/70 px-2 py-2 text-xs text-slate-300">
              최종 판단 {decisionActionKo(snapshot.decision.action)} / {(snapshot.decision.confidenceScore * 100).toFixed(1)}% / 비중{" "}
              {snapshot.decision.suggestedWeightPct.toFixed(0)}%
            </div>
          </div>

          <div className="rounded-xl border border-slate-700/60 bg-slate-900/65 p-3">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">존 6 이력 벡터 피드백</p>
            <p className="mt-2 text-sm font-semibold text-slate-100">유사 거래 #{snapshot.history.similarTradeId}</p>
            <p className="text-xs text-slate-300">과거 승률 {(snapshot.history.winRate * 100).toFixed(1)}%</p>

            <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800">
              <div className="h-full bg-emerald-400" style={{ width: `${Math.max(5, snapshot.history.winRate * 100)}%` }} />
            </div>

            <p className="mt-3 text-xs leading-relaxed text-slate-300">{narrativeKo(snapshot.history.summary)}</p>

            <div className="mt-3 space-y-1 rounded-lg border border-slate-700/70 bg-slate-950/70 px-2 py-2 text-[11px] text-slate-300">
              <p>공급원 {sourceKo(health?.zone6.source)}</p>
              <p>기록 수 {health?.zone6.recordCount ?? "-"}</p>
              <p>최근 유사 {health?.zone6.lastSimilarTradeId ?? "-"}</p>
              <p>최근 적재 {health?.zone6.lastIngestedTradeId ?? "-"}</p>
            </div>
          </div>
        </div>
      </Panel>
    </div>
  );
}
