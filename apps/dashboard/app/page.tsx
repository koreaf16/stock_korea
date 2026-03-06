"use client";

import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Flame,
  Newspaper,
  Power,
  Radar,
  Server,
  ShieldAlert,
  Target,
  TerminalSquare,
  Wallet,
  Zap
} from "lucide-react";
import Link from "next/link";
import { Fragment, useEffect, useMemo, useState } from "react";

type HeartbeatStatus = "online" | "degraded" | "offline";
type FeedSource = "TELEGRAM" | "NAVER";
type OrderAction = "BUY" | "SELL";

type Heartbeat = {
  id: string;
  name: string;
  status: HeartbeatStatus;
  latency: string;
};

type RadarEvent = {
  id: string;
  source: FeedSource;
  channel: string;
  symbol: string;
  text: string;
  greed: number;
  fear: number;
};

type PipelineZone = {
  id: number;
  name: string;
  tps: number;
  latency: string;
};

type Position = {
  symbol: string;
  code: string;
  entry: number;
  last: number;
  qty: number;
};

type OrderLog = {
  time: string;
  symbol: string;
  qty: number;
  action: OrderAction;
  price: number;
};

const HEARTBEATS: Heartbeat[] = [
  { id: "kis", name: "KIS API", status: "online", latency: "19ms" },
  { id: "oracle", name: "Oracle DB", status: "online", latency: "12ms" },
  { id: "llm", name: "Local LLM", status: "online", latency: "48ms" }
];

const GLOBAL_STATUS = [
  "현재 시장 감시 중 (Scanning 1,452 symbols...)",
  "체결강도 스파이크 감지, 상위 12개 종목 재랭킹 중",
  "타겟 락온: 알테오젠(196170) 집중 분석 중",
  "리스크 가드 정상, Zone 3 패턴 벡터 캐시 재정렬 완료"
];

const RADAR_EVENTS: RadarEvent[] = [
  {
    id: "r1",
    source: "NAVER",
    channel: "특징주 속보",
    symbol: "한화에어로",
    text: "방산 업황 상향 기대, 프로그램 매수 급증",
    greed: 0.81,
    fear: -0.22
  },
  {
    id: "r2",
    source: "TELEGRAM",
    channel: "찌라시-알파",
    symbol: "알테오젠",
    text: "단타방 동시 언급량 폭증, 호가 간격 축소",
    greed: 0.92,
    fear: -0.11
  },
  {
    id: "r3",
    source: "NAVER",
    channel: "특징주 속보",
    symbol: "두산로보틱스",
    text: "거래대금 급증 후 매도벽 출현, 변동성 경고",
    greed: 0.54,
    fear: -0.48
  },
  {
    id: "r4",
    source: "TELEGRAM",
    channel: "단타헌터",
    symbol: "에코프로비엠",
    text: "리젠율 290/min, 추가 추격매수 심리 확산",
    greed: 0.87,
    fear: -0.16
  },
  {
    id: "r5",
    source: "NAVER",
    channel: "특징주 속보",
    symbol: "셀트리온",
    text: "기관 수급 유입 전환, 단기 지지선 회복",
    greed: 0.64,
    fear: -0.33
  },
  {
    id: "r6",
    source: "TELEGRAM",
    channel: "스캘핑봇",
    symbol: "LG이노텍",
    text: "상위호가 잔량 급감, 체결 강도 180 돌파",
    greed: 0.73,
    fear: -0.28
  },
  {
    id: "r7",
    source: "NAVER",
    channel: "특징주 속보",
    symbol: "POSCO홀딩스",
    text: "원자재 이슈 재점화, 단기 차익매물 경계",
    greed: 0.43,
    fear: -0.62
  },
  {
    id: "r8",
    source: "TELEGRAM",
    channel: "오더북체크",
    symbol: "삼성전자",
    text: "매수벽 두터워짐, 1분 내 재돌파 시그널",
    greed: 0.69,
    fear: -0.25
  }
];

const PIPELINE_ZONES: PipelineZone[] = [
  { id: 0, name: "Raw", tps: 184220, latency: "2.8ms" },
  { id: 1, name: "Tech", tps: 97210, latency: "5.4ms" },
  { id: 2, name: "Fund", tps: 2210, latency: "81ms" },
  { id: 3, name: "Pattern", tps: 740, latency: "138ms" },
  { id: 4, name: "Sentiment", tps: 31310, latency: "13ms" },
  { id: 5, name: "Master AI", tps: 420, latency: "233ms" },
  { id: 6, name: "History", tps: 1120, latency: "52ms" }
];

const TERMINAL_THOUGHTS = [
  "패턴 95% 일치군 3개 포착 -> 거래대금 재검증 시작",
  "종토방 리젠율 급등 확인 -> 감성 과열 가중치 +0.22 반영",
  "리스크 한도 68% 유지, 신규 진입 가능 슬롯 2개",
  "예수금 15% 비중으로 시장가 매수 주문 전송 완료",
  "체결 완료 후 10틱 트레일링 스탑 자동 배치"
];

const POSITIONS: Position[] = [
  { symbol: "알테오젠", code: "196170", entry: 312500, last: 319800, qty: 42 },
  { symbol: "한화에어로", code: "012450", entry: 194500, last: 198700, qty: 120 },
  { symbol: "에코프로비엠", code: "247540", entry: 247000, last: 244600, qty: 55 },
  { symbol: "두산로보틱스", code: "454910", entry: 89100, last: 90300, qty: 210 },
  { symbol: "LG이노텍", code: "011070", entry: 237500, last: 241200, qty: 70 }
];

const ORDER_LOGS: OrderLog[] = [
  { time: "09:42:10.481", symbol: "알테오젠", qty: 8, action: "BUY", price: 319600 },
  { time: "09:42:03.904", symbol: "한화에어로", qty: 20, action: "BUY", price: 198500 },
  { time: "09:41:58.331", symbol: "에코프로비엠", qty: 5, action: "SELL", price: 245100 },
  { time: "09:41:52.205", symbol: "두산로보틱스", qty: 30, action: "BUY", price: 90200 },
  { time: "09:41:45.900", symbol: "LG이노텍", qty: 15, action: "SELL", price: 241500 },
  { time: "09:41:39.218", symbol: "삼성전자", qty: 40, action: "BUY", price: 81200 },
  { time: "09:41:32.707", symbol: "셀트리온", qty: 12, action: "SELL", price: 187400 },
  { time: "09:41:26.013", symbol: "POSCO홀딩스", qty: 6, action: "BUY", price: 391500 }
];

const heartbeatIndicatorByStatus: Record<HeartbeatStatus, string> = {
  online: "bg-emerald-400 shadow-[0_0_14px_rgba(74,222,128,0.8)]",
  degraded: "bg-amber-400 shadow-[0_0_14px_rgba(251,191,36,0.8)]",
  offline: "bg-rose-500 shadow-[0_0_14px_rgba(244,63,94,0.8)]"
};

const heartbeatTextByStatus: Record<HeartbeatStatus, string> = {
  online: "text-emerald-300",
  degraded: "text-amber-300",
  offline: "text-rose-300"
};

const actionColor: Record<OrderAction, string> = {
  BUY: "text-rose-300",
  SELL: "text-sky-300"
};

const actionBadgeColor: Record<OrderAction, string> = {
  BUY: "border-rose-500/50 bg-rose-500/10 text-rose-300",
  SELL: "border-sky-500/50 bg-sky-500/10 text-sky-300"
};

function formatKRW(value: number) {
  return value.toLocaleString("ko-KR");
}

function formatSignedPercent(value: number) {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export default function DashboardPage() {
  const [statusIndex, setStatusIndex] = useState(0);
  const [activeZone, setActiveZone] = useState(0);
  const [killModalOpen, setKillModalOpen] = useState(false);
  const [systemHalted, setSystemHalted] = useState(false);

  useEffect(() => {
    const statusTimer = window.setInterval(() => {
      setStatusIndex((prev) => (prev + 1) % GLOBAL_STATUS.length);
    }, 4200);

    const zoneTimer = window.setInterval(() => {
      setActiveZone((prev) => (prev + 1) % PIPELINE_ZONES.length);
    }, 1200);

    return () => {
      window.clearInterval(statusTimer);
      window.clearInterval(zoneTimer);
    };
  }, []);

  const runtimeHeartbeats = useMemo(() => {
    if (!systemHalted) {
      return HEARTBEATS;
    }

    return HEARTBEATS.map<Heartbeat>((heartbeat, idx) => ({
      ...heartbeat,
      status: idx === 1 ? "degraded" : "offline",
      latency: idx === 1 ? "291ms" : "---"
    }));
  }, [systemHalted]);

  const loopedRadarEvents = useMemo(() => [...RADAR_EVENTS, ...RADAR_EVENTS], []);

  const portfolio = useMemo(() => {
    const invested = POSITIONS.reduce((sum, row) => sum + row.entry * row.qty, 0);
    const valuation = POSITIONS.reduce((sum, row) => sum + row.last * row.qty, 0);
    const pnl = valuation - invested;
    const pnlPercent = (pnl / invested) * 100;

    return {
      invested,
      valuation,
      pnl,
      pnlPercent
    };
  }, []);

  const focusedStatus = systemHalted
    ? "MASTER KILL-SWITCH 발동됨. 모든 Zone 거래 액션 차단 상태"
    : GLOBAL_STATUS[statusIndex];

  return (
    <>
      <main className="flex h-screen flex-col overflow-hidden bg-slate-950 text-slate-100">
        <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/95 backdrop-blur">
          <div className="grid min-h-20 grid-cols-1 gap-2 px-3 py-2 xl:grid-cols-[320px_minmax(0,1fr)_430px]">
            <div className="rounded-md border border-slate-800 bg-slate-900/70 px-3 py-2">
              <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-300">
                <Activity className="h-4 w-4 text-emerald-300" />
                System Heartbeat
              </div>
              <div className="grid grid-cols-1 gap-1.5">
                {runtimeHeartbeats.map((heartbeat) => (
                  <div key={heartbeat.id} className="flex items-center justify-between rounded border border-slate-800 bg-black/40 px-2 py-1">
                    <div className="flex items-center gap-2">
                      <span className="relative inline-flex h-2.5 w-2.5">
                        {heartbeat.status === "online" ? (
                          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
                        ) : null}
                        <span
                          className={`relative inline-flex h-2.5 w-2.5 rounded-full ${heartbeatIndicatorByStatus[heartbeat.status]}`}
                        />
                      </span>
                      <span className="text-xs text-slate-100">{heartbeat.name}</span>
                    </div>
                    <span className={`text-[11px] font-mono ${heartbeatTextByStatus[heartbeat.status]}`}>{heartbeat.latency}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-md border border-slate-800 bg-gradient-to-r from-slate-900/80 via-slate-900/50 to-slate-900/80 px-3 py-2">
              <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-300">
                <Radar className="h-4 w-4 text-cyan-300" />
                Global Status
              </div>
              <div className="flex h-[54px] items-center rounded border border-cyan-900/40 bg-cyan-500/5 px-3">
                <p className="text-sm font-semibold text-cyan-100 transition-all duration-500">{focusedStatus}</p>
              </div>
            </div>

            <div className="rounded-md border border-slate-800 bg-slate-900/70 px-3 py-2">
              <div className="mb-1 flex items-center justify-between text-[11px]">
                <span className="flex items-center gap-2 font-semibold uppercase tracking-[0.15em] text-slate-300">
                  <Wallet className="h-4 w-4 text-violet-300" />
                  Portfolio
                </span>
                <span className={`font-mono ${portfolio.pnl >= 0 ? "text-rose-300" : "text-sky-300"}`}>
                  {formatSignedPercent(portfolio.pnlPercent)}
                </span>
              </div>
              <div className="grid grid-cols-[1fr_auto] items-center gap-2">
                <div className="rounded border border-slate-800 bg-black/40 px-2 py-1 text-[11px]">
                  <p className="font-mono text-slate-300">Eval {formatKRW(portfolio.valuation)} KRW</p>
                  <p className={`font-mono ${portfolio.pnl >= 0 ? "text-rose-300" : "text-sky-300"}`}>
                    PnL {portfolio.pnl >= 0 ? "+" : ""}
                    {formatKRW(portfolio.pnl)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setKillModalOpen(true)}
                  className="h-12 rounded-md border border-rose-500/70 bg-rose-600/20 px-3 text-[11px] font-black uppercase tracking-[0.1em] text-rose-200 transition-all hover:bg-rose-600/35 hover:text-rose-50"
                >
                  <span className="flex items-center gap-1">
                    <Power className="h-4 w-4" />
                    Master Kill-Switch
                  </span>
                </button>
              </div>
            </div>
          </div>
        </header>

        <section className="grid min-h-0 flex-1 grid-cols-1 gap-2 p-2 lg:grid-cols-12">
          <aside className="min-h-0 rounded-md border border-slate-800 bg-slate-900/50 p-2 lg:col-span-3">
            <div className="mb-2 flex items-center justify-between">
              <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-300">
                <Newspaper className="h-4 w-4 text-cyan-300" />
                Market Radar
              </p>
              <span className="rounded border border-cyan-500/40 bg-cyan-500/10 px-1.5 py-0.5 text-[10px] font-mono text-cyan-200">
                LIVE FEED
              </span>
            </div>

            <div className="relative h-[calc(100%-32px)] overflow-hidden rounded-md border border-slate-800 bg-black/35 p-2">
              <div className="animate-[radar-scroll_28s_linear_infinite] space-y-2">
                {loopedRadarEvents.map((event, idx) => (
                  <article key={`${event.id}-${idx}`} className="rounded border border-slate-800 bg-slate-900/60 p-2 text-[11px]">
                    <div className="mb-1 flex items-center justify-between text-[10px] text-slate-400">
                      <span className="font-mono">{event.source === "TELEGRAM" ? "TG" : "NV"} · {event.channel}</span>
                      <span>{event.symbol}</span>
                    </div>
                    <p className="mb-1 text-slate-100">{event.text}</p>
                    <div className="flex items-center gap-1.5">
                      <span className="rounded border border-rose-500/40 bg-rose-500/10 px-1.5 py-0.5 font-mono text-[10px] text-rose-300">
                        <Flame className="mr-1 inline h-3 w-3" />
                        탐욕 +{event.greed.toFixed(2)}
                      </span>
                      <span className="rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 font-mono text-[10px] text-sky-300">
                        <ShieldAlert className="mr-1 inline h-3 w-3" />
                        공포 {event.fear.toFixed(2)}
                      </span>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </aside>

          <section className="min-h-0 rounded-md border border-slate-800 bg-slate-900/50 p-2 lg:col-span-6">
            <div className="mb-2 rounded-md border border-slate-800 bg-slate-950/40 p-2">
              <div className="mb-2 flex items-center justify-between">
                <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-300">
                  <Server className="h-4 w-4 text-emerald-300" />
                  Pipeline Flow
                </p>
                <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-mono text-emerald-200">
                  DATA PULSE
                </span>
              </div>

              <div className="flex items-center gap-2 overflow-x-auto pb-1">
                {PIPELINE_ZONES.map((zone, idx) => {
                  const isActive = activeZone === zone.id && !systemHalted;
                  return (
                    <Fragment key={zone.id}>
                      <Link
                        href={`/zone/${zone.id}`}
                        className={`min-w-[112px] rounded border bg-black/35 p-2 transition-all ${
                          isActive
                            ? "border-emerald-400/70 ring-2 ring-emerald-500 shadow-[0_0_18px_rgba(74,222,128,0.45)]"
                            : "border-slate-700 hover:border-cyan-400/50"
                        }`}
                      >
                        <p className="text-xs font-semibold text-slate-200">Z{zone.id}</p>
                        <p className="text-[10px] text-slate-400">{zone.name}</p>
                        <p className="mt-1 font-mono text-[10px] text-cyan-200">{Math.round(zone.tps / 1000)}k TPS</p>
                        <p className="font-mono text-[10px] text-slate-400">{zone.latency}</p>
                      </Link>
                      {idx < PIPELINE_ZONES.length - 1 ? <ArrowRight className="h-4 w-4 shrink-0 text-slate-500" /> : null}
                    </Fragment>
                  );
                })}
              </div>
            </div>

            <div className="h-[calc(100%-152px)] rounded-md border border-green-900/60 bg-black p-2">
              <div className="mb-2 flex items-center justify-between text-[11px]">
                <p className="flex items-center gap-2 font-semibold uppercase tracking-[0.18em] text-green-300">
                  <TerminalSquare className="h-4 w-4" />
                  AI Terminal (Zone 5)
                </p>
                <span className="rounded border border-green-600/40 bg-green-500/10 px-1.5 py-0.5 font-mono text-[10px] text-green-300">
                  STREAMING
                </span>
              </div>

              <div className="h-[calc(100%-30px)] overflow-y-auto font-mono text-[11px] leading-5 text-green-400">
                <p className="text-green-300">[SYS] {focusedStatus}</p>
                {TERMINAL_THOUGHTS.map((line, idx) => (
                  <p key={`${line}-${idx}`} className={idx === TERMINAL_THOUGHTS.length - 1 ? "animate-pulse text-green-300" : ""}>
                    [Z{(activeZone + idx + 1) % PIPELINE_ZONES.length}] {line}
                  </p>
                ))}
                <p className="mt-1 flex items-center gap-2 text-green-300">
                  <span>&gt;</span>
                  <span>next signal waiting...</span>
                  <span className="inline-block h-3 w-2 animate-pulse bg-green-400" />
                </p>
              </div>
            </div>
          </section>

          <aside className="min-h-0 rounded-md border border-slate-800 bg-slate-900/50 p-2 lg:col-span-3">
            <div className="mb-2 rounded-md border border-slate-800 bg-slate-950/40 p-2">
              <div className="mb-2 flex items-center justify-between">
                <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-300">
                  <Target className="h-4 w-4 text-rose-300" />
                  Active Positions
                </p>
                <span className="rounded border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-mono text-violet-200">
                  {POSITIONS.length} OPEN
                </span>
              </div>

              <div className="grid grid-cols-[1.35fr_0.8fr_0.8fr_0.75fr] gap-1 border-b border-slate-800 pb-1 text-[10px] uppercase tracking-wider text-slate-400">
                <span>Symbol</span>
                <span className="text-right">Entry</span>
                <span className="text-right">Last</span>
                <span className="text-right">PnL%</span>
              </div>
              <div className="mt-1 space-y-1">
                {POSITIONS.map((position) => {
                  const pnlPercent = ((position.last - position.entry) / position.entry) * 100;
                  const positive = pnlPercent >= 0;
                  return (
                    <div
                      key={position.code}
                      className="grid grid-cols-[1.35fr_0.8fr_0.8fr_0.75fr] items-center gap-1 rounded border border-slate-800 bg-black/30 px-1.5 py-1 text-[11px]"
                    >
                      <div>
                        <p className="text-slate-100">{position.symbol}</p>
                        <p className="font-mono text-[10px] text-slate-400">{position.code}</p>
                      </div>
                      <span className="text-right font-mono text-slate-300">{Math.round(position.entry / 1000)}k</span>
                      <span className="text-right font-mono text-slate-200">{Math.round(position.last / 1000)}k</span>
                      <span
                        className={`text-right font-mono ${
                          positive ? "animate-pulse text-rose-300" : "animate-pulse text-sky-300"
                        }`}
                      >
                        {formatSignedPercent(pnlPercent)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="h-[calc(100%-194px)] rounded-md border border-slate-800 bg-slate-950/40 p-2">
              <div className="mb-2 flex items-center justify-between">
                <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-300">
                  <Zap className="h-4 w-4 text-amber-300" />
                  Order Book
                </p>
                <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-mono text-amber-200">
                  FILLED ORDERS
                </span>
              </div>

              <div className="grid grid-cols-[0.9fr_1fr_0.6fr_0.8fr] gap-1 border-b border-slate-800 pb-1 text-[10px] uppercase tracking-wider text-slate-400">
                <span>Time</span>
                <span>Symbol</span>
                <span className="text-right">Qty</span>
                <span className="text-right">Action</span>
              </div>

              <div className="mt-1 h-[calc(100%-28px)] space-y-1 overflow-y-auto pr-1">
                {ORDER_LOGS.map((order) => (
                  <div
                    key={`${order.time}-${order.symbol}-${order.action}`}
                    className="grid grid-cols-[0.9fr_1fr_0.6fr_0.8fr] items-center gap-1 rounded border border-slate-800 bg-black/35 px-1.5 py-1 text-[11px]"
                  >
                    <span className="font-mono text-slate-400">{order.time.slice(0, 8)}</span>
                    <div className="leading-tight">
                      <p className="text-slate-100">{order.symbol}</p>
                      <p className="font-mono text-[10px] text-slate-400">@{Math.round(order.price / 1000)}k</p>
                    </div>
                    <span className="text-right font-mono text-slate-300">{order.qty}</span>
                    <span
                      className={`ml-auto inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-semibold ${
                        actionBadgeColor[order.action]
                      } ${actionColor[order.action]}`}
                    >
                      {order.action}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </aside>
        </section>
      </main>

      {killModalOpen ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-4">
          <div className="w-full max-w-xl rounded-md border border-rose-500/60 bg-slate-950 p-4 shadow-[0_0_45px_rgba(244,63,94,0.3)]">
            <div className="mb-3 flex items-center gap-2 text-rose-300">
              <AlertTriangle className="h-5 w-5" />
              <p className="text-sm font-bold uppercase tracking-[0.12em]">Emergency Stop Confirmation</p>
            </div>
            <p className="mb-4 text-sm text-slate-200">
              MASTER KILL-SWITCH를 실행하면 모든 주문 전송과 Zone 파이프라인이 즉시 정지됩니다.
            </p>

            <button
              type="button"
              onClick={() => {
                setSystemHalted(true);
                setKillModalOpen(false);
              }}
              className="mb-2 h-16 w-full rounded-md border border-rose-300 bg-rose-600 text-sm font-black uppercase tracking-[0.14em] text-white transition-all hover:bg-rose-500"
            >
              <span className="inline-flex items-center gap-2">
                <Power className="h-5 w-5" />
                Emergency Halt All Zones
              </span>
            </button>

            <button
              type="button"
              onClick={() => setKillModalOpen(false)}
              className="h-11 w-full rounded-md border border-slate-700 bg-slate-900 text-sm font-semibold text-slate-200 transition-all hover:bg-slate-800"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <style jsx global>{`
        @keyframes radar-scroll {
          0% {
            transform: translateY(0);
          }
          100% {
            transform: translateY(-50%);
          }
        }
      `}</style>
    </>
  );
}
