import {
  Bot,
  Brain,
  CandlestickChart,
  ChevronRight,
  Database,
  FileSearch,
  History,
  MessageSquareWarning
} from "lucide-react";
import Link from "next/link";

const ZONES = [
  {
    id: "0",
    title: "Raw Ingestion",
    subtitle: "실시간 틱/호가/뉴스 원시 수집",
    icon: Database
  },
  {
    id: "1",
    title: "Technical Metrics",
    subtitle: "체결강도/스파이크/지지저항 계산",
    icon: CandlestickChart
  },
  {
    id: "2",
    title: "Fundamental Filter",
    subtitle: "DART/리스크 플래그 필터링",
    icon: FileSearch
  },
  {
    id: "3",
    title: "Pattern Vectors",
    subtitle: "패턴 유사도 및 벡터 매칭",
    icon: Brain
  },
  {
    id: "4",
    title: "Madness & Sentiment",
    subtitle: "뉴스/텔레그램 감성 및 광기 단계",
    icon: MessageSquareWarning
  },
  {
    id: "5",
    title: "Master AI Agent",
    subtitle: "LLM 추론 로그와 매매 의사결정",
    icon: Bot
  },
  {
    id: "6",
    title: "History & Feedback",
    subtitle: "과거 매매 이력과 승률 피드백",
    icon: History
  }
] as const;

export default function ZoneMenuPage() {
  return (
    <main className="min-h-screen bg-slate-950 px-3 py-4 text-slate-100">
      <section className="mx-auto w-full max-w-5xl rounded-2xl border border-slate-800 bg-slate-900/70 p-4">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
          <div>
            <p className="text-[11px] uppercase tracking-[0.24em] text-slate-400">Zone Navigation</p>
            <h1 className="mt-1 text-lg font-semibold text-slate-100">존별 관리 메뉴</h1>
            <p className="mt-1 text-xs text-slate-400">필요한 존만 눌러서 해당 상세 화면으로 이동합니다.</p>
          </div>
          <Link
            href="/"
            className="rounded-lg border border-slate-700/80 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 transition hover:bg-slate-800"
          >
            대시보드로 복귀
          </Link>
        </header>

        <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {ZONES.map((zone) => {
            const Icon = zone.icon;
            return (
              <Link
                key={zone.id}
                href={`/zone/${zone.id}`}
                className="group rounded-xl border border-slate-800 bg-slate-950/80 p-3 transition hover:border-cyan-500/50 hover:bg-cyan-500/5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Icon className="mt-0.5 h-4 w-4 text-cyan-300" />
                    <p className="text-sm font-semibold text-slate-100">
                      Z{zone.id} {zone.title}
                    </p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-slate-500 transition group-hover:text-cyan-300" />
                </div>
                <p className="mt-2 text-xs text-slate-400">{zone.subtitle}</p>
              </Link>
            );
          })}
        </div>
      </section>
    </main>
  );
}
