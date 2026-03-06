import type { DashboardSnapshot } from "@stock/contracts";

import { formatKrw, formatTs } from "@/lib/format";
import { fundamentalIssueKo, riskFlagKo, sourceKo } from "@/lib/korean";
import type { OrchestratorHealth } from "@/lib/orchestrator-health";
import { decorateSymbolCodes, formatSymbolLabel } from "@/lib/symbol-label";
import type { UiLogLine } from "@/lib/store";

import { Panel } from "./panel";

interface LeftPanelProps {
  snapshot: DashboardSnapshot;
  health: OrchestratorHealth | null;
  tickLogs: UiLogLine[];
  targetLogs: UiLogLine[];
  symbolNames: Record<string, string>;
}

function meterWidth(value: number, max: number): string {
  const ratio = Math.min(100, Math.max(0, (value / Math.max(1, max)) * 100));
  return `${ratio.toFixed(1)}%`;
}

export function LeftPanel({ snapshot, health, tickLogs, targetLogs, symbolNames }: LeftPanelProps) {
  const spikeDanger = snapshot.technical.spikeRatio >= 300;
  const blocked = snapshot.fundamental.riskFlag === "BLOCKED";
  const targetLabel = formatSymbolLabel(snapshot.targetSymbol, symbolNames);

  return (
    <Panel
      title="레이더 및 존 1"
      subtitle="시장 감시 / 원시 데이터 / 펀더멘털 필터"
      className="h-full min-w-0 overflow-hidden"
      rightSlot={
        <span className="rounded-full border border-slate-700/80 bg-slate-900/70 px-2 py-0.5 text-[11px] text-slate-300">
          존0 {health?.zone0.ticksBuffered ?? 0}틱
        </span>
      }
    >
      <div className="grid h-full grid-rows-[auto_auto_auto_1fr_auto_auto] gap-3">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-slate-700/70 bg-slate-950/60 p-2">
            <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400">뉴스</p>
            <p className="mt-1 text-lg font-semibold text-slate-100">{health?.zone0.newsBuffered ?? 0}</p>
          </div>
          <div className="rounded-lg border border-slate-700/70 bg-slate-950/60 p-2">
            <p className="text-[11px] uppercase tracking-[0.2em] text-slate-400">텔레그램</p>
            <p className="mt-1 text-lg font-semibold text-slate-100">{health?.zone0.telegramBuffered ?? 0}</p>
          </div>
        </div>

        {spikeDanger ? (
          <div className="zone-alert-flash rounded-lg border border-rose-500/80 bg-rose-500/18 px-3 py-2">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-rose-200">긴급 경보</p>
            <p className="mt-1 text-sm font-semibold text-rose-100">
              거래대금 급증 감지: {targetLabel} / {snapshot.technical.spikeRatio.toFixed(1)}%
            </p>
            <p className="text-[11px] text-rose-200/90">
              존1 임계값(300%) 초과. 추격 진입 전 존2/존5 조건을 재확인하세요.
            </p>
          </div>
        ) : null}

        <div className="rounded-lg border border-slate-700/60 bg-slate-900/55 p-2.5">
          <div className="mb-1 flex items-center justify-between">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">관심 종목 풀</p>
            <span className="rounded-full border border-slate-700/80 bg-slate-900/80 px-2 py-0.5 text-[10px] text-slate-300">
              {snapshot.watchPool.length}개 감시
            </span>
          </div>

          <p className="text-[11px] text-amber-300">현재 타겟 {targetLabel}</p>
          <p className="max-h-9 overflow-hidden break-words text-[11px] text-slate-300">
            {decorateSymbolCodes(snapshot.targetReason, symbolNames)}
          </p>

          <div className="mt-2 space-y-1">
            {snapshot.watchPool.length === 0 ? (
              <p className="text-[11px] text-slate-500">감시풀 데이터 수집 대기</p>
            ) : (
              snapshot.watchPool.slice(0, 12).map((item) => {
                const focused = item.symbol === snapshot.targetSymbol;
                return (
                  <div
                    key={item.symbol}
                    className={`flex items-center justify-between gap-1.5 rounded border px-2 py-1 text-[11px] ${
                      focused
                        ? "border-emerald-400/70 bg-emerald-500/10 shadow-[0_0_14px_rgba(16,185,129,0.22)]"
                        : "border-slate-700/70 bg-slate-950/55"
                    }`}
                  >
                    <span className={`min-w-0 truncate font-semibold ${focused ? "text-emerald-200" : "text-slate-200"}`}>
                      {formatSymbolLabel(item.symbol, symbolNames)}
                    </span>
                    <span className={`shrink-0 ${item.spikeRatio > 500 ? "text-rose-300" : "text-slate-300"}`}>
                      S {item.spikeRatio.toFixed(0)}%
                    </span>
                    <span className={`shrink-0 ${item.volumePower > 120 ? "text-emerald-300" : "text-slate-300"}`}>
                      VP {item.volumePower.toFixed(0)}
                    </span>
                  </div>
                );
              })
            )}
          </div>

          <div className="mt-2 rounded border border-slate-700/70 bg-slate-950/60 p-1.5">
            <p className="mb-1 text-[10px] uppercase tracking-[0.18em] text-slate-500">타겟 전환 로그</p>
            <div className="terminal-font max-h-20 overflow-auto text-[11px] text-emerald-300">
              {targetLogs.length === 0 ? (
                <p className="text-slate-500">전환 로그 대기</p>
              ) : (
                targetLogs.slice(0, 6).map((line) => (
                  <p key={line.id} className="truncate leading-relaxed">
                    {decorateSymbolCodes(line.text, symbolNames)}
                  </p>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-slate-700/60 bg-slate-950/65 p-2">
          <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">존 0 실시간 틱 로그</p>
            <p className="truncate text-[11px] text-slate-500">
              {health?.zone0.lastFrameAt ? formatTs(health.zone0.lastFrameAt) : "스트림 수신 대기"}
            </p>
          </div>
          <div className="terminal-font h-[220px] overflow-auto text-xs text-tactical-terminal">
            {tickLogs.length === 0 ? (
              <p className="text-slate-500">스트림 대기 중...</p>
            ) : (
              tickLogs.map((line) => (
                <p key={line.id} className="truncate leading-relaxed">
                  {decorateSymbolCodes(line.text, symbolNames)}
                </p>
              ))
            )}
          </div>
        </div>

        <div
          className={`rounded-lg border px-3 py-2 ${
            spikeDanger ? "border-rose-500 bg-rose-500/15 shadow-[0_0_18px_rgba(244,63,94,0.3)]" : "border-slate-700/60 bg-slate-900/60"
          }`}
        >
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">존 1 거래대금 급증 경보</p>
          <p className={`mt-1 text-sm font-semibold ${spikeDanger ? "text-rose-300" : "text-slate-200"}`}>
            급증 비율 {snapshot.technical.spikeRatio.toFixed(2)}%
          </p>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-slate-800">
            <div
              className={`h-full ${spikeDanger ? "bg-rose-400" : "bg-cyan-400"}`}
              style={{ width: meterWidth(snapshot.technical.spikeRatio, 400) }}
            />
          </div>
          <p className="text-xs text-slate-400">
            체결강도 {snapshot.technical.volumePower.toFixed(2)} / 호가잔량비 {snapshot.technical.orderImbalance.toFixed(2)}
          </p>
        </div>

        <div
          className={`rounded-lg border px-3 py-2 ${
            blocked ? "border-amber-500/80 bg-amber-500/10" : "border-emerald-500/60 bg-emerald-500/10"
          }`}
        >
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">존 2 펀더멘털 필터</p>
          <p className={`mt-1 text-sm font-semibold ${blocked ? "text-amber-300" : "text-emerald-300"}`}>
            {formatSymbolLabel(snapshot.fundamental.symbol, symbolNames)} {riskFlagKo(snapshot.fundamental.riskFlag)}
          </p>
          <p className="mt-1 text-[11px] text-slate-400">
            제공자 {sourceKo(health?.zone2.provider)} / 공급원 {sourceKo(health?.zone2.source)}
          </p>
          <p className="text-xs text-slate-300">
            {blocked
              ? snapshot.fundamental.issues.map((issue) => fundamentalIssueKo(issue)).join(", ")
              : `기준가 ${formatKrw(snapshot.tick.price)}원 / 악재 신호 없음`}
          </p>
        </div>
      </div>
    </Panel>
  );
}
