"use client";

import type { DashboardSnapshot } from "@stock/contracts";
import { useMemo, useState } from "react";

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

interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
}

type ViewMode = "1m" | "3m";

function buildCandles(series: number[], viewMode: ViewMode): Candle[] {
  if (series.length < 4) {
    return [];
  }

  const baseBucketSize = Math.max(3, Math.floor(series.length / 28));
  const bucketSize = viewMode === "3m" ? baseBucketSize * 3 : baseBucketSize;
  const candles: Candle[] = [];

  for (let start = 0; start < series.length; start += bucketSize) {
    const chunk = series.slice(start, start + bucketSize);
    const first = chunk[0];
    const last = chunk[chunk.length - 1];
    if (first === undefined || last === undefined) {
      continue;
    }

    candles.push({
      open: first,
      high: Math.max(...chunk),
      low: Math.min(...chunk),
      close: last
    });
  }

  return candles;
}

function toY(value: number, minPrice: number, maxPrice: number, height: number): number {
  const span = Math.max(1, maxPrice - minPrice);
  return height - ((value - minPrice) / span) * height;
}

function ghostPath(klass: DashboardSnapshot["pattern"]["klass"], width: number, height: number): string {
  const points: Array<[number, number]> = [];
  const n = 42;

  for (let i = 0; i < n; i += 1) {
    const t = i / (n - 1);
    let y = 0.5;

    if (klass === "CLASS_A") {
      y = 0.62 - 0.44 * t - Math.max(0, t - 0.72) * 0.24;
    } else if (klass === "CLASS_C") {
      y = 0.36 + 0.41 * t + Math.max(0, t - 0.68) * 0.18;
    } else {
      y = 0.5 + Math.sin(t * Math.PI * 3.5) * 0.06;
    }

    points.push([t * width, y * height]);
  }

  return points
    .map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`)
    .join(" ");
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

function fmtPrice(value: number): string {
  return Math.round(value).toLocaleString();
}

export function CenterPanel({ snapshot, health, priceSeries, brainLogs }: CenterPanelProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("1m");

  const width = 860;
  const height = 290;

  const candles = useMemo(() => buildCandles(priceSeries, viewMode), [priceSeries, viewMode]);

  const allPrices = candles.flatMap((candle) => [candle.high, candle.low]);
  const minPrice = allPrices.length > 0 ? Math.min(...allPrices) : snapshot.tick.price * 0.98;
  const maxPrice = allPrices.length > 0 ? Math.max(...allPrices) : snapshot.tick.price * 1.02;
  const midPrice = (minPrice + maxPrice) / 2;

  const candleGap = width / Math.max(1, candles.length);
  const bodyWidth = Math.max(4, candleGap * 0.55);

  const supportY = toY(snapshot.technical.support, minPrice, maxPrice, height);
  const resistanceY = toY(snapshot.technical.resistance, minPrice, maxPrice, height);
  const patternGhost = ghostPath(snapshot.pattern.klass, width, height);
  const madnessGauge = gaugeGradient(snapshot.madness.score);

  const latestPrice = priceSeries[priceSeries.length - 1] ?? snapshot.tick.price;
  const prevPrice = priceSeries[priceSeries.length - 2] ?? latestPrice;
  const lastPriceUp = latestPrice >= prevPrice;
  const lastPriceY = toY(latestPrice, minPrice, maxPrice, height);

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
    <div className="grid h-full grid-rows-[1fr_1fr] gap-3">
      <Panel
        title="전술 차트 (존 1 + 존 3)"
        subtitle="실시간 캔들 / 지지·저항 / 패턴 고스트 오버레이"
        className="h-full"
        rightSlot={
          <div className="flex items-center gap-2 text-[11px]">
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
        <div className="signal-grid relative h-full rounded-xl border border-slate-700/60 bg-slate-950/65 p-3">
          <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full">
            {[0.2, 0.4, 0.6, 0.8].map((ratio) => {
              const y = height * ratio;
              return <line key={ratio} x1="0" y1={y} x2={width} y2={y} stroke="rgba(148,163,184,0.16)" strokeWidth="1" />;
            })}

            <line x1="0" y1={supportY} x2={width} y2={supportY} stroke="#34d399" strokeDasharray="7 7" strokeOpacity="0.9" />
            <line
              x1="0"
              y1={resistanceY}
              x2={width}
              y2={resistanceY}
              stroke="#38bdf8"
              strokeDasharray="7 7"
              strokeOpacity="0.9"
            />

            <line
              x1="0"
              y1={lastPriceY}
              x2={width}
              y2={lastPriceY}
              stroke={lastPriceUp ? "#f87171" : "#60a5fa"}
              strokeDasharray="3 5"
              strokeOpacity="0.85"
            />

            <path d={patternGhost} fill="none" stroke="#cbd5e1" strokeWidth={1.5} strokeOpacity="0.36" />

            {candles.map((candle, index) => {
              const xCenter = candleGap * index + candleGap / 2;
              const yOpen = toY(candle.open, minPrice, maxPrice, height);
              const yClose = toY(candle.close, minPrice, maxPrice, height);
              const yHigh = toY(candle.high, minPrice, maxPrice, height);
              const yLow = toY(candle.low, minPrice, maxPrice, height);
              const bullish = candle.close >= candle.open;
              const top = Math.min(yOpen, yClose);
              const bodyHeight = Math.max(2, Math.abs(yClose - yOpen));

              return (
                <g key={`${index}-${candle.open}-${candle.close}`}>
                  <line
                    x1={xCenter}
                    y1={yHigh}
                    x2={xCenter}
                    y2={yLow}
                    stroke={bullish ? "#f87171" : "#60a5fa"}
                    strokeWidth="1.3"
                    strokeOpacity="0.92"
                  />
                  <rect
                    x={xCenter - bodyWidth / 2}
                    y={top}
                    width={bodyWidth}
                    height={bodyHeight}
                    rx="1.4"
                    fill={bullish ? "rgba(248,113,113,0.88)" : "rgba(96,165,250,0.84)"}
                  />
                </g>
              );
            })}

            <text x={width - 6} y={Math.max(12, lastPriceY - 5)} textAnchor="end" fill={lastPriceUp ? "#fda4af" : "#93c5fd"} fontSize="11">
              {fmtPrice(latestPrice)}
            </text>
          </svg>

          <div className="absolute left-3 top-3 flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded-md border border-slate-700/80 bg-slate-900/80 px-2 py-1 text-slate-200">
              패턴 {patternClassKo(snapshot.pattern.klass)}
            </span>
            <span className="rounded-md border border-slate-700/80 bg-slate-900/80 px-2 py-1 text-slate-200">
              공급원 {sourceKo(health?.zone3.source)}
            </span>
            <span className="rounded-md border border-slate-700/80 bg-slate-900/80 px-2 py-1 text-slate-200">
              벡터 {health?.zone3.vectorDim ?? "-"}차원
            </span>
            <span className="rounded-md border border-slate-700/80 bg-slate-900/80 px-2 py-1 text-slate-200">
              급증 {snapshot.technical.spikeRatio.toFixed(1)}%
            </span>
          </div>

          <div className="pointer-events-none absolute right-3 top-10 flex h-[calc(100%-56px)] flex-col justify-between text-[10px] text-slate-400">
            <span>{fmtPrice(maxPrice)}</span>
            <span>{fmtPrice(midPrice)}</span>
            <span>{fmtPrice(minPrice)}</span>
          </div>

          <div className="absolute bottom-3 left-3 rounded-md border border-slate-700/80 bg-slate-900/80 px-2 py-1 text-xs text-slate-200">
            지지선 {snapshot.technical.support.toLocaleString()} / 저항선 {snapshot.technical.resistance.toLocaleString()}
          </div>
          <div className="absolute bottom-3 right-3 rounded-md border border-slate-700/80 bg-slate-900/80 px-2 py-1 text-xs text-slate-200">
            {viewMode === "1m" ? "1분 차트" : "3분 차트"} | 틱 {health?.tickCount ?? "-"} | 현재가 {snapshot.tick.price.toLocaleString()}
          </div>
        </div>
      </Panel>

      <Panel title="인공지능 브레인 터미널 (존 4 / 5 / 6)" subtitle="광기게이지 + 판단로그 + 유사이력 피드백" className="h-full">
        <div className="grid h-full grid-cols-1 gap-3 xl:grid-cols-[260px_1fr_290px]">
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
