"use client";

import type { DashboardSnapshot } from "@stock/contracts";
import {
  AreaSeries, CandlestickSeries, ColorType, LineSeries, createChart, LineStyle,
  type AreaData, type IChartApi, type IPriceLine, type ISeriesApi, type LineData, type UTCTimestamp
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";

import { patternClassKo } from "@/lib/korean";
import type { OrchestratorHealth } from "@/lib/orchestrator-health";
import { formatSymbolLabel } from "@/lib/symbol-label";

type ViewMode = "1m" | "3m";

interface CandlePoint { time: UTCTimestamp; open: number; high: number; low: number; close: number; }

function toEpochSeconds(iso: string | undefined): number {
  const parsed = Date.parse(String(iso ?? ""));
  if (!Number.isFinite(parsed)) return Math.floor(Date.now() / 1_000);
  return Math.floor(parsed / 1_000);
}

function buildCandles(series: number[], viewMode: ViewMode, lastTickAt: string): CandlePoint[] {
  if (series.length < 2) return [];
  const targetCandles = viewMode === "1m" ? 56 : 36;
  const bucketSize = Math.max(1, Math.floor(series.length / targetCandles));
  const intervalSec = viewMode === "1m" ? 60 : 180;
  const chunks: number[][] = [];
  for (let start = 0; start < series.length; start += bucketSize) {
    const chunk = series.slice(start, Math.min(start + bucketSize, series.length));
    if (chunk.length > 0) chunks.push(chunk);
  }
  const endTime = toEpochSeconds(lastTickAt);
  const firstTime = endTime - (chunks.length - 1) * intervalSec;
  return chunks.map((chunk, index) => {
    const open = chunk[0] ?? 0;
    const close = chunk[chunk.length - 1] ?? open;
    const high = Math.max(...chunk);
    const low = Math.min(...chunk);
    return { time: (firstTime + index * intervalSec) as UTCTimestamp, open, high, low, close };
  });
}

function buildGhostSeries(candles: CandlePoint[], klass: DashboardSnapshot["pattern"]["klass"], viewMode: ViewMode): LineData<UTCTimestamp>[] {
  if (candles.length < 6) return [];
  const tail = candles.slice(-18).map((item) => item.close);
  const returns: number[] = [];
  for (let index = 1; index < tail.length; index += 1) {
    const prev = tail[index - 1];
    const curr = tail[index];
    if (prev === undefined || curr === undefined) continue;
    const change = prev === 0 ? 0 : (curr - prev) / prev;
    returns.push(Math.max(-0.05, Math.min(0.05, change)));
  }
  const avgReturn = returns.length > 0 ? returns.reduce((acc, value) => acc + value, 0) / returns.length : 0;
  const intervalSec = viewMode === "1m" ? 60 : 180;
  const steps = 14;
  const lastCandle = candles[candles.length - 1];
  if (!lastCandle) return [];
  let projected = lastCandle.close;
  const ghost: LineData<UTCTimestamp>[] = [{ time: lastCandle.time, value: projected }];
  for (let step = 1; step <= steps; step += 1) {
    const templateReturn = returns[(step - 1) % Math.max(1, returns.length)] ?? avgReturn;
    let directionalReturn = templateReturn * 0.6 + avgReturn * 0.4;
    if (klass === "CLASS_A") directionalReturn = Math.max(0, directionalReturn) * 1.12 + avgReturn * 0.12;
    else if (klass === "CLASS_C") directionalReturn = Math.min(0, directionalReturn) * 1.12 + avgReturn * 0.12;
    directionalReturn = Math.max(-0.03, Math.min(0.03, directionalReturn));
    projected = Math.max(1, projected * (1 + directionalReturn));
    ghost.push({ time: (lastCandle.time + step * intervalSec) as UTCTimestamp, value: projected });
  }
  return ghost;
}

function TacticalChart({ snapshot, health, priceSeries, viewMode }: { snapshot: DashboardSnapshot; health: OrchestratorHealth | null; priceSeries: number[]; viewMode: ViewMode; }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const ghostLineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const ghostAreaRef = useRef<ISeriesApi<"Area"> | null>(null);
  const supportLineRef = useRef<IPriceLine | null>(null);
  const resistanceLineRef = useRef<IPriceLine | null>(null);
  const candles = useMemo(() => buildCandles(priceSeries, viewMode, snapshot.tick.timestamp), [priceSeries, snapshot.tick.timestamp, viewMode]);
  const ghostSeries = useMemo(() => buildGhostSeries(candles, snapshot.pattern.klass, viewMode), [candles, snapshot.pattern.klass, viewMode]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = createChart(container, {
      width: container.clientWidth, height: container.clientHeight,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#52525b", fontFamily: "JetBrains Mono, monospace" },
      grid: { vertLines: { color: "rgba(39,39,42,0.5)" }, horzLines: { color: "rgba(39,39,42,0.5)" } },
      rightPriceScale: { borderColor: "rgba(63,63,70,0.5)", autoScale: true },
      timeScale: { borderColor: "rgba(63,63,70,0.5)", rightOffset: 4, timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { labelBackgroundColor: "#18181b", color: "#3f3f46" }, horzLine: { labelBackgroundColor: "#18181b", color: "#3f3f46" } }
    });
    
    // 네온 톤의 캔들스틱
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: "#06b6d4", downColor: "#e11d48", borderVisible: false, wickUpColor: "#06b6d4", wickDownColor: "#e11d48", priceLineVisible: true, lastValueVisible: true
    });
    const ghostLine = chart.addSeries(LineSeries, { color: "rgba(255,255,255,0.2)", lineWidth: 2, lineStyle: LineStyle.Dotted, lastValueVisible: false, priceLineVisible: false });
    const ghostArea = chart.addSeries(AreaSeries, { lineColor: "transparent", topColor: "rgba(255,255,255,0.05)", bottomColor: "transparent", lineWidth: 1, lastValueVisible: false, priceLineVisible: false });
    
    chartRef.current = chart; candleSeriesRef.current = candleSeries; ghostLineRef.current = ghostLine; ghostAreaRef.current = ghostArea;
    const resizeObserver = new ResizeObserver(() => chart.applyOptions({ width: container.clientWidth, height: container.clientHeight }));
    resizeObserver.observe(container);
    return () => { resizeObserver.disconnect(); chart.remove(); };
  }, []);

  useEffect(() => {
    if (!chartRef.current || !candleSeriesRef.current || !ghostLineRef.current || !ghostAreaRef.current) return;
    candleSeriesRef.current.setData(candles);
    ghostLineRef.current.setData(ghostSeries);
    ghostAreaRef.current.setData(ghostSeries.map((point) => ({ time: point.time, value: point.value })) as AreaData<UTCTimestamp>[]);
    if (supportLineRef.current) candleSeriesRef.current.removePriceLine(supportLineRef.current);
    if (resistanceLineRef.current) candleSeriesRef.current.removePriceLine(resistanceLineRef.current);
    
    // 지지/저항선도 미니멀하게
    if (snapshot.technical.support > 0) {
      supportLineRef.current = candleSeriesRef.current.createPriceLine({ price: snapshot.technical.support, color: "rgba(6,182,212,0.4)", lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: "SUP" });
    }
    if (snapshot.technical.resistance > 0) {
      resistanceLineRef.current = candleSeriesRef.current.createPriceLine({ price: snapshot.technical.resistance, color: "rgba(225,29,72,0.4)", lineWidth: 1, lineStyle: LineStyle.Solid, axisLabelVisible: true, title: "RES" });
    }
    chartRef.current.timeScale().fitContent();
  }, [candles, ghostSeries, snapshot.technical.resistance, snapshot.technical.support]);

  return <div ref={containerRef} className="h-full w-full" />;
}

interface CenterPanelProps {
  snapshot: DashboardSnapshot;
  health: OrchestratorHealth | null;
  priceSeries: number[];
  symbolNames: Record<string, string>;
}

export function CenterPanel({ snapshot, health, priceSeries, symbolNames }: CenterPanelProps) {
  const [viewMode, setViewMode] = useState<ViewMode>("1m");

  return (
    <div className="relative isolate h-full w-full bg-black">
      {/* 1. Main Background Chart */}
      <div className="absolute inset-0 z-0">
        <TacticalChart snapshot={snapshot} health={health} priceSeries={priceSeries} viewMode={viewMode} />
      </div>

      {/* 2. Cyberpunk HUD Overlay (Minimal) */}
      <div className="pointer-events-none absolute left-6 top-6 z-20 flex gap-6">
        <div className="border-l-2 border-cyan-500 pl-3">
          <p className="text-[9px] tracking-[0.3em] text-cyan-500 mb-1">TARGET_LOCK</p>
          <p className="text-2xl font-light tracking-wider text-white">
            {formatSymbolLabel(snapshot.targetSymbol, symbolNames)}
          </p>
        </div>
        <div className="border-l-2 border-zinc-700 pl-3">
          <p className="text-[9px] tracking-[0.3em] text-zinc-500 mb-1">PATTERN_MATCH</p>
          <p className="text-xl font-light text-zinc-300">
            {patternClassKo(snapshot.pattern.klass)} <span className="text-sm text-zinc-500 ml-1">{(snapshot.pattern.similarity * 100).toFixed(1)}%</span>
          </p>
        </div>
      </div>

      {/* View Mode Toggles */}
      <div className="pointer-events-auto absolute right-6 top-6 z-30 flex gap-2">
        <button type="button" onClick={() => setViewMode("1m")} className={`px-3 py-1 text-[10px] uppercase tracking-widest border backdrop-blur-[1px] transition-colors ${viewMode === "1m" ? "border-cyan-500/50 text-cyan-400 bg-cyan-500/10" : "border-zinc-800 text-zinc-500 hover:text-zinc-300"}`}>1 MIN</button>
        <button type="button" onClick={() => setViewMode("3m")} className={`px-3 py-1 text-[10px] uppercase tracking-widest border backdrop-blur-[1px] transition-colors ${viewMode === "3m" ? "border-cyan-500/50 text-cyan-400 bg-cyan-500/10" : "border-zinc-800 text-zinc-500 hover:text-zinc-300"}`}>3 MIN</button>
      </div>
    </div>
  );
}
