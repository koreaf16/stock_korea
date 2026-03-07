"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";

import { DashboardFrame } from "@/components/dashboard-frame";

type Zone0Tab = "telegram" | "keywords" | "board";

const TABS: Array<{ id: Zone0Tab; label: string }> = [
  { id: "telegram", label: "Telegram 수집 채널" },
  { id: "keywords", label: "뉴스/공시 키워드 감시" },
  { id: "board", label: "종토방 크롤링 제어" }
];

function resolveTab(raw: string | null): Zone0Tab {
  if (raw === "keywords" || raw === "board" || raw === "telegram") {
    return raw;
  }
  return "telegram";
}

export default function Zone0SettingsLayout({ children }: { children: React.ReactNode }) {
  const searchParams = useSearchParams();
  const activeTab = resolveTab(searchParams.get("tab"));

  return (
    <DashboardFrame>
      <div className="flex-1 min-w-0 overflow-y-auto pr-1">
        <div className="mx-auto w-full max-w-none rounded-2xl border border-zinc-800/60 bg-black/70 p-4">
          <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Tactical Dashboard</p>
              <h1 className="text-2xl font-semibold text-cyan-400">Zone 0 Data Integration</h1>
              <p className="text-sm text-zinc-400">텔레그램/뉴스/종토방 연동 설정을 실시간으로 제어합니다.</p>
            </div>

            <Link
              href="/"
              className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 transition-colors hover:border-cyan-400/70 hover:text-cyan-300 focus:border-cyan-400 focus:outline-none"
            >
              대시보드 복귀
            </Link>
          </header>

          <nav className="mb-4 flex flex-wrap gap-1 border-b border-zinc-800/80">
            {TABS.map((tab) => {
              const selected = tab.id === activeTab;
              return (
                <Link
                  key={tab.id}
                  href={`/settings/zone0?tab=${tab.id}`}
                  className={`border-b-2 px-3 py-2 text-sm transition-colors ${
                    selected ? "border-cyan-500 text-cyan-200" : "border-transparent text-slate-400 hover:text-slate-200"
                  }`}
                >
                  {tab.label}
                </Link>
              );
            })}
          </nav>

          {children}
        </div>
      </div>
    </DashboardFrame>
  );
}
