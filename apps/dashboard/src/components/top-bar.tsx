import type { DashboardSnapshot } from "@stock/contracts";
import { ArrowUpRight, PanelsTopLeft } from "lucide-react";
import Link from "next/link";

import { formatKrw, formatPct } from "@/lib/format";
import { connectionStateKo, serviceLabelKo, sourceKo } from "@/lib/korean";
import type { OrchestratorHealth } from "@/lib/orchestrator-health";
import { formatSymbolLabel } from "@/lib/symbol-label";

interface TopBarProps {
  connected: boolean;
  health: OrchestratorHealth | null;
  healthError: string | null;
  commandError: string | null;
  snapshot: DashboardSnapshot;
  busy: boolean;
  newsFeed: Array<{
    id: string;
    source: "NAVER_NEWS" | "NAVER_BOARD";
    symbol: string;
    title: string;
    timestamp: string;
  }>;
  symbolNames: Record<string, string>;
  emergencyAlerts: string[];
  onToggleKillSwitch: (enabled: boolean) => Promise<void>;
}

export function TopBar({
  connected,
  health,
  healthError,
  commandError,
  snapshot,
  busy,
  newsFeed,
  symbolNames,
  emergencyAlerts,
  onToggleKillSwitch
}: TopBarProps) {
  const zoneSummary = [
    `존2 ${sourceKo(health?.zone2.source)}`,
    `존3 ${sourceKo(health?.zone3.source)}`,
    `존4 ${sourceKo(health?.zone4.source)}`,
    `존5 ${sourceKo(health?.zone5.source)}`,
    `존6 ${sourceKo(health?.zone6.source)}`
  ];
  const latestNews = newsFeed.filter((item) => item.source === "NAVER_NEWS").slice(0, 10);
  const tickerItems = latestNews.length > 0 ? latestNews : newsFeed.slice(0, 10);
  const tickerLoop = [...tickerItems, ...tickerItems];

  return (
    <header className="panel-surface sticky top-2 z-40 mb-3 rounded-2xl px-4 py-3">
      <div className="flex flex-col gap-3">
        {emergencyAlerts.length > 0 ? (
          <div className="rounded-xl border border-rose-400/80 bg-rose-500/14 px-3 py-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-rose-200">긴급 경고 묶음</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {emergencyAlerts.map((alert) => (
                <span
                  key={alert}
                  className="rounded-full border border-rose-400/70 bg-rose-500/18 px-2 py-0.5 text-[11px] font-semibold text-rose-100"
                >
                  {alert}
                </span>
              ))}
            </div>
          </div>
        ) : null}

        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.24em] text-slate-400">글로벌 상태</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {snapshot.network.map((service) => {
              const isUp = service.state === "UP";
              return (
                <div
                  key={service.name}
                  className="rounded-lg border border-slate-700/80 bg-slate-950/50 px-2 py-1 text-[11px] text-slate-200"
                >
                  <p className="inline-flex items-center gap-1 font-semibold tracking-wide">
                    <i className={`h-2 w-2 rounded-full ${isUp ? "bg-emerald-400 shadow-[0_0_12px_rgba(52,211,153,0.7)]" : "bg-rose-500"}`} />
                    {serviceLabelKo(service.name)}
                  </p>
                  <p className="mt-0.5 text-[10px] text-slate-400">{connectionStateKo(service.state)}</p>
                  <p className="mt-0.5 max-w-[180px] truncate text-[10px] text-slate-400">{service.endpoint}</p>
                </div>
              );
            })}
            <span
              className={`rounded-full border px-2 py-1 text-[11px] ${
                connected
                  ? "border-emerald-500/40 bg-emerald-500/20 text-emerald-300"
                  : "border-rose-500/40 bg-rose-500/20 text-rose-300"
              }`}
            >
              {connected ? "소켓 연결됨" : "소켓 끊김"}
            </span>
            {healthError ? (
              <span className="rounded-full border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300">
                상태 점검 경고
              </span>
            ) : null}
            {commandError ? (
              <span className="rounded-full border border-rose-500/50 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-300">
                명령 오류
              </span>
            ) : null}
            <span className="rounded-full border border-slate-700/80 bg-slate-900/80 px-2 py-1 text-[11px] text-slate-300">
              {health?.now ? `최근 갱신 ${health.now}` : "상태 수집 대기"}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-3 flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-center">
        <div className="rounded-xl border border-slate-700/70 bg-slate-900/60 px-3 py-2 lg:min-w-[280px] xl:min-w-[360px]">
          <p className="text-[11px] uppercase tracking-[0.24em] text-slate-400">내 계좌</p>
          <div className="mt-1 flex flex-wrap items-center gap-4 text-sm text-slate-100">
            <span className="font-semibold">총 자산 {formatKrw(snapshot.account.totalAssets)} 원</span>
            <span>예수금 {formatKrw(snapshot.account.cashAvailable)} 원</span>
            <span className={snapshot.account.realizedPnlPct >= 0 ? "text-rose-300" : "text-blue-300"}>
              당일 실현손익 {formatPct(snapshot.account.realizedPnlPct)}
            </span>
          </div>
        </div>

        <div className="min-w-0 flex-1 rounded-xl border border-slate-700/70 bg-slate-900/60 px-3 py-2">
          <p className="text-[11px] uppercase tracking-[0.24em] text-slate-400">최신 뉴스 스트림</p>
          <div className="relative mt-1 h-6 overflow-hidden">
            {tickerItems.length === 0 ? (
              <p className="text-xs text-slate-500">뉴스 수신 대기 중</p>
            ) : (
              <div
                className="absolute left-0 top-0 flex min-w-full items-center whitespace-nowrap"
                style={{ animation: "topbarNewsMarquee 36s linear infinite" }}
              >
                {tickerLoop.map((item, index) => (
                  <span
                    key={`${item.id}:${index}`}
                    className="mr-7 inline-flex max-w-[340px] items-center gap-2 text-xs text-slate-200"
                  >
                    <span className="font-semibold text-cyan-300">{formatSymbolLabel(item.symbol, symbolNames)}</span>
                    <span className="truncate">{item.title}</span>
                    <span className="text-[10px] text-slate-500">{item.source === "NAVER_NEWS" ? "뉴스" : "종토방"}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <button
          type="button"
          disabled={busy}
          onClick={() => onToggleKillSwitch(!snapshot.killSwitchOn)}
          className={`self-start rounded-lg border px-4 py-2 text-sm font-semibold tracking-wide transition lg:shrink-0 lg:self-auto ${
            snapshot.killSwitchOn
              ? "border-rose-300/40 bg-rose-800 text-rose-50 hover:bg-rose-700"
              : "border-rose-500/50 bg-rose-500 text-rose-50 hover:bg-rose-400"
          } disabled:cursor-not-allowed disabled:opacity-60`}
        >
          마스터 킬스위치 {snapshot.killSwitchOn ? "작동" : "해제"}
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-slate-700/70 bg-slate-900/60 px-3 py-2">
        <span className="text-xs text-slate-400">틱 수</span>
        <span className="text-sm font-semibold text-slate-100">{health?.tickCount ?? "-"}</span>
        <span className="h-4 w-px bg-slate-700/80" />
        {zoneSummary.map((item) => (
          <span key={item} className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] text-slate-200">
            {item}
          </span>
        ))}
        <Link
          href="/zones"
          className="inline-flex items-center gap-1 rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2 py-1 text-[11px] text-cyan-200 transition hover:bg-cyan-500/20"
        >
          <PanelsTopLeft className="h-3.5 w-3.5" />
          존 관리
          <ArrowUpRight className="h-3.5 w-3.5" />
        </Link>
      </div>

      <style jsx>{`
        @keyframes topbarNewsMarquee {
          0% {
            transform: translateX(0);
          }
          100% {
            transform: translateX(-50%);
          }
        }
      `}</style>
    </header>
  );
}
