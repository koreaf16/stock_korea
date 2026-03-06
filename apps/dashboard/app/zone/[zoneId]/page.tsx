import type { LucideIcon } from "lucide-react";
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
  ShieldAlert
} from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

const ZONE_IDS = ["0", "1", "2", "3", "4", "5", "6"] as const;
type ZoneId = (typeof ZONE_IDS)[number];
type MetricState = "stable" | "warn" | "risk";

type ZoneMetric = {
  label: string;
  value: string;
  state: MetricState;
};

type ZoneConfig = {
  title: string;
  subtitle: string;
  objective: string;
  metrics: ZoneMetric[];
  logs: string[];
  checklist: string[];
};

const ZONE_CONFIGS: Record<ZoneId, ZoneConfig> = {
  "0": {
    title: "Raw Ingestion",
    subtitle: "KIS websocket raw tick intake",
    objective: "원시 틱/호가 데이터 수집 무결성 확보",
    metrics: [
      { label: "Tick Stream", value: "184,220 msg/s", state: "stable" },
      { label: "Queue Depth", value: "12,401", state: "warn" },
      { label: "Packet Loss", value: "0.01%", state: "stable" },
      { label: "Ingress Lag", value: "2.8 ms", state: "stable" }
    ],
    logs: [
      "[09:48:12.209] KRX:041960 TICK px=319800 vol=221 side=BUY",
      "[09:48:12.205] KRX:012450 BID/ASK depth updated (5-level)",
      "[09:48:12.200] burst_guard trip=FALSE queue=12401",
      "[09:48:12.194] channel=KIS_WS_A heartbeat ok",
      "[09:48:12.188] parser raw frame normalized"
    ],
    checklist: ["웹소켓 heartbeat 누락 < 3회/분", "원시 패킷 파싱 실패율 < 0.1%", "저장 큐 초과 시 백프레셔 활성"]
  },
  "1": {
    title: "Technical Metrics",
    subtitle: "execution pressure and short-term levels",
    objective: "체결강도/거래대금 기반 단기 모멘텀 탐지",
    metrics: [
      { label: "Strength Rank", value: "Top 20 updated", state: "stable" },
      { label: "1m Value Spike", value: "18 symbols", state: "warn" },
      { label: "S/R Draw Time", value: "24 ms", state: "stable" },
      { label: "Metric Drift", value: "0.3%", state: "stable" }
    ],
    logs: [
      "[09:48:11.100] 041960 strength=182.4 rank=2",
      "[09:48:10.882] 247540 1m_turnover_spike=+312%",
      "[09:48:10.401] auto trendline support @318700",
      "[09:48:09.995] resistance cluster updated @321200",
      "[09:48:09.550] noise filter passed 12/31"
    ],
    checklist: ["체결강도 계산 윈도우 동기화", "1분 거래대금 스파이크 임계치 점검", "지지/저항선 자동 작도 오류 모니터링"]
  },
  "2": {
    title: "Fundamental Filter",
    subtitle: "DART event screening and blocked list",
    objective: "유상증자/CB 등 리스크 종목 영구 차단",
    metrics: [
      { label: "DART Pull", value: "Last sync 09:45", state: "stable" },
      { label: "Blocked Symbols", value: "137", state: "warn" },
      { label: "Rule Hit", value: "21 today", state: "stable" },
      { label: "API Retry", value: "1 pending", state: "warn" }
    ],
    logs: [
      "[09:45:32.200] DART notice parsed: CB issuance",
      "[09:45:31.500] symbol=005930 block_reason=rights_offering",
      "[09:45:30.910] blacklist checksum verified",
      "[09:45:30.210] incremental fetch window=15m",
      "[09:45:29.876] python filter pipeline complete"
    ],
    checklist: ["차단 룰 버전 해시 점검", "DART 지연 시 fallback 캐시 사용", "차단 리스트 TTL 24시간 유지"]
  },
  "3": {
    title: "Pattern Vectors",
    subtitle: "Oracle vector search against historical crashes/rallies",
    objective: "현재 차트와 과거 패턴 유사도 상위군 실시간 비교",
    metrics: [
      { label: "Top Similarity", value: "95.2%", state: "stable" },
      { label: "Vector Query", value: "740 qps", state: "warn" },
      { label: "Cache Hit", value: "88%", state: "stable" },
      { label: "Overlay Latency", value: "138 ms", state: "warn" }
    ],
    logs: [
      "[09:48:08.104] symbol=196170 cosine=0.952 template=RALLY_2211",
      "[09:48:07.900] oracle26ai vec index partial refresh",
      "[09:48:07.511] overlay renderer frame=60fps",
      "[09:48:07.188] historical segment trim length=128",
      "[09:48:06.902] fallback vector source not used"
    ],
    checklist: ["벡터 인덱스 stale 비율 < 5%", "코사인 계산 배치 지연 확인", "오버레이 차트 프레임 드랍 모니터링"]
  },
  "4": {
    title: "Madness & Sentiment",
    subtitle: "news/telegram LLM greed-fear analysis",
    objective: "시장 광기 단계(STAGE) 및 감성 과열도 계산",
    metrics: [
      { label: "Greed Score", value: "79.4", state: "warn" },
      { label: "Fear Score", value: "20.6", state: "stable" },
      { label: "LLM Throughput", value: "31,310 msg/s", state: "stable" },
      { label: "Stage Gauge", value: "STAGE 3", state: "warn" }
    ],
    logs: [
      "[09:48:06.300] headline sentiment greed=0.82 confidence=0.91",
      "[09:48:06.110] telegram room surge rate=318/min",
      "[09:48:05.705] stage estimator switched 2 -> 3",
      "[09:48:05.410] negative sentiment cluster shrunk",
      "[09:48:04.992] llm tokenizer queue healthy"
    ],
    checklist: ["감성 모델 confidence < 0.7 항목 재평가", "STAGE 4 진입 시 자동 리스크 축소", "채널별 리젠율 급등 알림 유지"]
  },
  "5": {
    title: "Master AI Agent",
    subtitle: "final execution policy and order decision",
    objective: "멀티존 시그널 취합 후 최종 주문 판단",
    metrics: [
      { label: "Prompt Queue", value: "6 pending", state: "warn" },
      { label: "Decision Time", value: "233 ms", state: "warn" },
      { label: "Execution Success", value: "99.2%", state: "stable" },
      { label: "Safety Guard", value: "ACTIVE", state: "stable" }
    ],
    logs: [
      "[09:48:04.130] CoT token stream chunk=122",
      "[09:48:03.900] policy score long_bias=0.61",
      "[09:48:03.441] order plan created: market_buy 15%",
      "[09:48:03.021] risk guard approved max slippage",
      "[09:48:02.740] final JSON emitted to executor"
    ],
    checklist: ["프롬프트 길이 상한 8k 토큰 유지", "결정 지연 > 300ms 시 경고", "주문 전 슬리피지 한도 재검증"]
  },
  "6": {
    title: "History & Feedback",
    subtitle: "trade archive, replay and win-rate learning",
    objective: "과거 체결/스냅샷 회고와 전략 피드백 반영",
    metrics: [
      { label: "Stored Trades", value: "1,294,331", state: "stable" },
      { label: "Win Rate", value: "63.8%", state: "stable" },
      { label: "Replay Jobs", value: "4 running", state: "warn" },
      { label: "Snapshot Gap", value: "0.02%", state: "stable" }
    ],
    logs: [
      "[09:47:59.812] replay job=RPL_240306_1 finished",
      "[09:47:59.201] feedback weights updated +0.014",
      "[09:47:58.744] failed trade cluster re-labeled",
      "[09:47:58.133] snapshot index compact complete",
      "[09:47:57.908] win/loss dashboard cache refreshed"
    ],
    checklist: ["승/패 태깅 누락 샘플 보정", "리플레이 데이터 무결성 해시 점검", "피드백 가중치 버전 롤백 포인트 유지"]
  }
};

const ICON_BY_ZONE: Record<ZoneId, LucideIcon> = {
  "0": Database,
  "1": CandlestickChart,
  "2": FileSearch,
  "3": Brain,
  "4": MessageSquareWarning,
  "5": Bot,
  "6": History
};

const STATE_TONE: Record<MetricState, string> = {
  stable: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  warn: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  risk: "border-rose-500/40 bg-rose-500/10 text-rose-300"
};

function isZoneId(value: string): value is ZoneId {
  return ZONE_IDS.includes(value as ZoneId);
}

export function generateStaticParams() {
  return ZONE_IDS.map((zoneId) => ({ zoneId }));
}

export default async function ZoneDetailPage({ params }: { params: Promise<{ zoneId: string }> }) {
  const { zoneId } = await params;

  if (!isZoneId(zoneId)) {
    notFound();
  }

  const zone = ZONE_CONFIGS[zoneId];
  const ZoneIcon = ICON_BY_ZONE[zoneId];
  const index = ZONE_IDS.indexOf(zoneId);
  const prevZone = index > 0 ? ZONE_IDS[index - 1] : null;
  const nextZone = index < ZONE_IDS.length - 1 ? ZONE_IDS[index + 1] : null;

  return (
    <main className="min-h-screen bg-slate-950 px-3 py-3 text-slate-100 sm:px-4">
      <header className="mb-3 rounded-md border border-slate-800 bg-slate-900/70 p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ZoneIcon className="h-5 w-5 text-cyan-300" />
            <h1 className="text-lg font-semibold">
              Zone {zoneId} · {zone.title}
            </h1>
          </div>

          <div className="flex items-center gap-2">
            <Link
              href="/"
              className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 transition-all hover:border-cyan-400/60"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Dashboard
            </Link>

            {prevZone ? (
              <Link
                href={`/zone/${prevZone}`}
                className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 transition-all hover:border-cyan-400/60"
              >
                Prev Z{prevZone}
              </Link>
            ) : null}

            {nextZone ? (
              <Link
                href={`/zone/${nextZone}`}
                className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 transition-all hover:border-cyan-400/60"
              >
                Next Z{nextZone}
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            ) : null}
          </div>
        </div>

        <p className="text-sm text-cyan-100">{zone.subtitle}</p>
        <p className="mt-1 text-xs text-slate-300">{zone.objective}</p>
      </header>

      <section className="grid gap-3 xl:grid-cols-[1.2fr_1fr]">
        <div className="rounded-md border border-slate-800 bg-slate-900/60 p-3">
          <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-300">
            <Activity className="h-4 w-4 text-emerald-300" />
            Live Metrics
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {zone.metrics.map((metric) => (
              <article key={metric.label} className="rounded border border-slate-800 bg-black/35 p-2">
                <p className="text-[11px] uppercase tracking-wider text-slate-400">{metric.label}</p>
                <p className="mt-1 font-mono text-sm text-slate-100">{metric.value}</p>
                <span className={`mt-2 inline-flex rounded border px-1.5 py-0.5 text-[10px] font-semibold ${STATE_TONE[metric.state]}`}>
                  {metric.state.toUpperCase()}
                </span>
              </article>
            ))}
          </div>

          <div className="mt-3 rounded border border-emerald-900/50 bg-black p-2">
            <p className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-emerald-300">
              <ShieldAlert className="h-4 w-4" />
              Recent Stream
            </p>
            <div className="space-y-1 font-mono text-[11px] text-emerald-300">
              {zone.logs.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </div>
        </div>

        <aside className="rounded-md border border-slate-800 bg-slate-900/60 p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-300">Operational Checklist</p>
          <div className="space-y-2">
            {zone.checklist.map((item) => (
              <div key={item} className="rounded border border-slate-800 bg-black/35 p-2 text-sm text-slate-200">
                {item}
              </div>
            ))}
          </div>

          <div className="mt-3 rounded border border-slate-800 bg-black/35 p-2">
            <p className="mb-1 text-xs uppercase tracking-wider text-slate-400">Route Index</p>
            <div className="grid grid-cols-4 gap-1 sm:grid-cols-7">
              {ZONE_IDS.map((id) => (
                <Link
                  key={id}
                  href={`/zone/${id}`}
                  className={`rounded border px-2 py-1 text-center text-xs font-semibold transition-all ${
                    id === zoneId
                      ? "border-cyan-400 bg-cyan-500/20 text-cyan-200"
                      : "border-slate-700 bg-slate-900 text-slate-300 hover:border-cyan-400/50"
                  }`}
                >
                  Z{id}
                </Link>
              ))}
            </div>
          </div>
        </aside>
      </section>
    </main>
  );
}
