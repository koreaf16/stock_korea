import type { DashboardSnapshot } from "@stock/contracts";

import { formatKrw, formatTs } from "@/lib/format";
import { fundamentalIssueKo, riskFlagKo, sourceKo } from "@/lib/korean";
import type { OrchestratorHealth } from "@/lib/orchestrator-health";
import type { UiLogLine } from "@/lib/store";

import { Panel } from "./panel";

interface LeftPanelProps {
  snapshot: DashboardSnapshot;
  health: OrchestratorHealth | null;
  tickLogs: UiLogLine[];
}

function meterWidth(value: number, max: number): string {
  const ratio = Math.min(100, Math.max(0, (value / Math.max(1, max)) * 100));
  return `${ratio.toFixed(1)}%`;
}

export function LeftPanel({ snapshot, health, tickLogs }: LeftPanelProps) {
  const spikeDanger = snapshot.technical.spikeRatio >= 300;
  const blocked = snapshot.fundamental.riskFlag === "BLOCKED";

  return (
    <Panel
      title="레이더 및 존 1"
      subtitle="시장 감시 / 원시 데이터 / 펀더멘털 필터"
      className="h-full overflow-hidden"
      rightSlot={
        <span className="rounded-full border border-slate-700/80 bg-slate-900/70 px-2 py-0.5 text-[11px] text-slate-300">
          존0 {health?.zone0.ticksBuffered ?? 0}틱
        </span>
      }
    >
      <div className="grid h-full grid-rows-[auto_auto_1fr_auto_auto] gap-3">
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
              거래대금 급증 감지: {snapshot.targetSymbol} / {snapshot.technical.spikeRatio.toFixed(1)}%
            </p>
            <p className="text-[11px] text-rose-200/90">
              존1 임계값(300%) 초과. 추격 진입 전 존2/존5 조건을 재확인하세요.
            </p>
          </div>
        ) : null}

        <div className="rounded-lg border border-slate-700/60 bg-slate-950/65 p-2">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">존 0 실시간 틱 로그</p>
            <p className="text-[11px] text-slate-500">
              {health?.zone0.lastFrameAt ? formatTs(health.zone0.lastFrameAt) : "스트림 수신 대기"}
            </p>
          </div>
          <div className="terminal-font h-[220px] overflow-auto text-xs text-tactical-terminal">
            {tickLogs.length === 0 ? (
              <p className="text-slate-500">스트림 대기 중...</p>
            ) : (
              tickLogs.map((line) => (
                <p key={line.id} className="truncate leading-relaxed">
                  {line.text}
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
            {snapshot.fundamental.symbol} {riskFlagKo(snapshot.fundamental.riskFlag)}
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
