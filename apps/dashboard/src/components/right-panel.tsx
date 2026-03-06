"use client";

import type { DashboardSnapshot } from "@stock/contracts";
import { formatPct, formatTs } from "@/lib/format";
import type { OrchestratorHealth } from "@/lib/orchestrator-health";
import { formatSymbolLabel } from "@/lib/symbol-label";

interface RightPanelProps {
  snapshot: DashboardSnapshot;
  health: OrchestratorHealth | null;
  symbolNames: Record<string, string>;
  newsFeed?: any[];
}

export function RightPanel({ snapshot, health, symbolNames, newsFeed = [] }: RightPanelProps) {
  const isBuy = snapshot.decision.action === "BUY";
  const actionColor = isBuy ? "text-cyan-400" : 
                      snapshot.decision.action === "SELL" ? "text-rose-500" : 
                      "text-zinc-500";

  // RPM 게이지 계산
  const madnessPct = Math.min(100, Math.max(0, snapshot.madness.score));
  const isStage3 = snapshot.madness.stage === 'STAGE_3';
  const isStage2 = snapshot.madness.stage === 'STAGE_2';
  const madnessColor = isStage3 ? 'text-rose-500' : isStage2 ? 'text-amber-500' : 'text-cyan-400';
  const strokeColor = isStage3 ? '#f43f5e' : isStage2 ? '#f59e0b' : '#22d3ee';
  
  const radius = 30;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (madnessPct / 100) * circumference;

  return (
    <div className="flex h-full flex-col gap-2 font-mono">
      
      {/* 1. TOP COMPACT ROW: AI & MADNESS */}
      <div className="grid grid-cols-2 gap-2 shrink-0">
        {/* AI COMMANDER */}
        <div className="border border-zinc-800/60 bg-zinc-950/50 p-2 relative flex flex-col justify-center items-center min-h-[100px]">
          <p className="absolute top-2 left-2 text-[9px] tracking-[0.2em] text-zinc-500">AI_CMD</p>
          <div className="mt-2 flex flex-col items-center text-center">
            <span className={`text-3xl font-light tracking-widest ${actionColor} leading-none mb-1`}>
              {snapshot.decision.action}
            </span>
            <span className="text-[10px] text-zinc-400 font-mono">
              CONF {(snapshot.decision.confidenceScore * 100).toFixed(0)}%
            </span>
          </div>
        </div>

        {/* RPM MADNESS GAUGE */}
        <div className="border border-zinc-800/60 bg-zinc-950/50 p-2 relative flex flex-col items-center justify-center min-h-[100px]">
          <p className="absolute top-2 left-2 text-[9px] tracking-[0.2em] text-zinc-500">MADNESS</p>
          <div className="relative mt-2 flex items-center justify-center h-20 w-20">
            {/* SVG RPM Gauge */}
            <svg className="transform -rotate-90 w-20 h-20">
              <circle cx="40" cy="40" r={radius} stroke="#27272a" strokeWidth="5" fill="transparent" />
              <circle 
                cx="40" cy="40" r={radius} 
                stroke={strokeColor} strokeWidth="5" fill="transparent" 
                strokeDasharray={circumference} 
                strokeDashoffset={offset} 
                strokeLinecap="round"
                className="transition-all duration-700 ease-out" 
              />
            </svg>
            {/* Inside the Gauge */}
            <div className="absolute flex flex-col items-center">
              <span className="text-xl font-light text-white font-mono leading-none">
                {snapshot.madness.score.toFixed(0)}
              </span>
              <span className={`text-[8px] uppercase tracking-widest mt-1 font-bold ${madnessColor}`}>
                {snapshot.madness.stage.replace('STAGE_', 'LV')}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* 2. ZONE 0 DATA LINK (유입량 모니터링) */}
      <div className="border border-zinc-800/60 bg-zinc-950/50 p-2 shrink-0">
        <div className="flex items-center justify-between mb-2">
          <p className="text-[9px] tracking-[0.2em] text-cyan-500/80">ZONE0_INFLUX</p>
          <span className="h-1.5 w-1.5 rounded-full bg-cyan-500 animate-ping" />
        </div>
        <div className="grid grid-cols-3 gap-1 text-center">
          <div className="bg-zinc-900/30 p-1.5">
            <p className="text-[8px] text-zinc-500 mb-0.5">TICKS</p>
            <p className="text-[11px] text-zinc-300">{health?.zone0?.ticksBuffered ?? 0}</p>
          </div>
          <div className="bg-zinc-900/30 p-1.5">
            <p className="text-[8px] text-zinc-500 mb-0.5">NEWS</p>
            <p className="text-[11px] text-cyan-400">{health?.zone0?.newsBuffered ?? 0}</p>
          </div>
          <div className="bg-zinc-900/30 p-1.5">
            <p className="text-[8px] text-zinc-500 mb-0.5">TELEGRAM</p>
            <p className="text-[11px] text-cyan-400">{health?.zone0?.telegramBuffered ?? 0}</p>
          </div>
        </div>
      </div>

      {/* 3. LIVE INTEL STREAM (전체 실시간 뉴스 속보) */}
      <div className="border border-zinc-800/60 bg-zinc-950/50 p-2.5 flex-1 flex flex-col overflow-hidden">
        <p className="text-[9px] tracking-[0.2em] text-zinc-500 mb-2">LIVE_INTEL_STREAM</p>
        <div className="space-y-1 overflow-y-auto pr-1 custom-scrollbar">
          {newsFeed.length === 0 ? (
            <p className="text-[9px] text-zinc-600 mt-4">&gt; AWAITING SIGINT...</p>
          ) : (
            newsFeed.map((news, idx) => {
              const isTarget = news.symbol === snapshot.targetSymbol;
              return (
                <div key={news.id || idx} className={`p-1.5 border-l-2 ${isTarget ? "border-cyan-500 bg-cyan-500/5" : "border-zinc-800"}`}>
                  <div className="flex justify-between items-center">
                    <span className="text-[8px] text-zinc-500">
                      [{news.timestamp ? formatTs(news.timestamp) : "NOW"}]
                    </span>
                    <span className={`text-[8px] font-bold truncate max-w-[80px] text-right ${isTarget ? "text-cyan-400" : "text-zinc-600"}`}>
                      {formatSymbolLabel(news.symbol, symbolNames)}
                    </span>
                  </div>
                  <p className={`text-[10px] mt-1 leading-snug line-clamp-2 ${isTarget ? "text-cyan-100" : "text-zinc-400"}`}>
                    {news.title || news.text}
                  </p>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* 4. RADAR & ARSENAL (바닥에 얇게 배치) */}
      <div className="grid grid-cols-2 gap-2 shrink-0 h-[100px]">
        {/* RADAR */}
        <div className="border border-zinc-800/60 bg-zinc-950/50 p-2 overflow-y-auto custom-scrollbar">
          <p className="text-[9px] tracking-[0.2em] text-zinc-500 mb-1">RADAR</p>
          <div className="space-y-1 text-[9px]">
            {snapshot.watchPool.slice(0, 4).map(item => (
              <div key={item.symbol} className="flex justify-between">
                <span className="text-zinc-300 truncate mr-2">{formatSymbolLabel(item.symbol, symbolNames)}</span>
                <span className="text-rose-400 shrink-0">{item.spikeRatio.toFixed(0)}%</span>
              </div>
            ))}
          </div>
        </div>
        {/* ARSENAL */}
        <div className="border border-zinc-800/60 bg-zinc-950/50 p-2 overflow-y-auto custom-scrollbar">
          <p className="text-[9px] tracking-[0.2em] text-zinc-500 mb-1">POSITIONS</p>
          <div className="space-y-1 text-[9px]">
            {snapshot.positions.length === 0 ? (
              <span className="text-zinc-600">&gt; EMPTY</span>
            ) : (
              snapshot.positions.map(pos => (
                <div key={pos.symbol} className="flex justify-between">
                  <span className="text-zinc-300 truncate mr-2">{formatSymbolLabel(pos.symbol, symbolNames)}</span>
                  <span className={pos.pnlPct >= 0 ? "text-cyan-400" : "text-rose-500"}>
                    {pos.pnlPct >= 0 ? '+' : ''}{formatPct(pos.pnlPct)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <style dangerouslySetInnerHTML={{__html: `
        .custom-scrollbar::-webkit-scrollbar { width: 3px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #3f3f46; border-radius: 2px; }
      `}} />
    </div>
  );
}