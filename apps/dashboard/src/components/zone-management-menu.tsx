"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { decisionActionKo, madnessStageKo, patternClassKo, sourceKo } from "@/lib/korean";
import type { OrchestratorHealth } from "@/lib/orchestrator-health";

import { Panel } from "./panel";

type ZoneKey = "zone0" | "zone1" | "zone2" | "zone3" | "zone4" | "zone5" | "zone6";

interface ZoneManagementMenuProps {
  health: OrchestratorHealth | null;
}

interface ZonePreviewItem {
  label: string;
  value: string;
}

interface ZonePayloadState {
  loading: boolean;
  error: string | null;
  fetchedAt: string | null;
  preview: ZonePreviewItem[];
}

const ORCHESTRATOR_URL = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ?? "http://localhost:5001";

const ZONE_KEYS: ZoneKey[] = ["zone0", "zone1", "zone2", "zone3", "zone4", "zone5", "zone6"];

const ZONE_TITLE: Record<ZoneKey, string> = {
  zone0: "존0 원시 수집",
  zone1: "존1 기술 지표",
  zone2: "존2 펀더멘털",
  zone3: "존3 패턴 매칭",
  zone4: "존4 광기 지수",
  zone5: "존5 의사결정",
  zone6: "존6 이력 피드백"
};

const ZONE_ENDPOINT: Record<ZoneKey, string> = {
  zone0: "/api/zone0/buffer",
  zone1: "/api/zone1/state",
  zone2: "/api/zone2/state",
  zone3: "/api/zone3/state",
  zone4: "/api/zone4/state",
  zone5: "/api/zone5/state",
  zone6: "/api/zone6/state"
};

function createInitialZoneStates(): Record<ZoneKey, ZonePayloadState> {
  return ZONE_KEYS.reduce(
    (acc, zone) => {
      acc[zone] = {
        loading: false,
        error: null,
        fetchedAt: null,
        preview: []
      };
      return acc;
    },
    {} as Record<ZoneKey, ZonePayloadState>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function lastRecord(list: unknown[]): Record<string, unknown> | null {
  if (list.length === 0) {
    return null;
  }
  const item = list[list.length - 1];
  return isRecord(item) ? item : null;
}

function numberText(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value.toLocaleString("ko-KR");
  }
  return "-";
}

function shortText(value: unknown, limit = 110): string {
  if (value === null || value === undefined) {
    return "-";
  }
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : JSON.stringify(value);

  if (!text) {
    return "-";
  }
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, Math.max(1, limit - 3))}...`;
}

function dateTimeText(iso: unknown): string {
  if (typeof iso !== "string" || iso.trim().length === 0) {
    return "-";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return `${date.toLocaleDateString("ko-KR")} ${date.toLocaleTimeString("ko-KR", { hour12: false })}`;
}

function genericPreview(payload: unknown): ZonePreviewItem[] {
  if (!isRecord(payload)) {
    return [
      {
        label: "결과",
        value: shortText(payload)
      }
    ];
  }

  return Object.entries(payload)
    .slice(0, 16)
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        return {
          label: key,
          value: `${value.length.toLocaleString("ko-KR")}개`
        };
      }
      if (isRecord(value)) {
        return {
          label: key,
          value: shortText(value)
        };
      }
      return {
        label: key,
        value: shortText(value)
      };
    });
}

function previewFromPayload(zone: ZoneKey, payload: unknown): ZonePreviewItem[] {
  if (!isRecord(payload)) {
    return genericPreview(payload);
  }

  if (zone === "zone0") {
    const ticks = asArray(payload.ticks);
    const newsItems = asArray(payload.newsItems);
    const boardPosts = asArray(payload.boardPosts);
    const telegramMessages = asArray(payload.telegramMessages);
    const orderBooks = asArray(payload.orderBooks);

    const lastTick = lastRecord(ticks);
    const lastNews = lastRecord(newsItems);
    const lastBoard = lastRecord(boardPosts);
    const lastTelegram = lastRecord(telegramMessages);

    return [
      { label: "틱 버퍼", value: `${ticks.length.toLocaleString("ko-KR")}개` },
      { label: "호가 버퍼", value: `${orderBooks.length.toLocaleString("ko-KR")}개` },
      { label: "뉴스 버퍼", value: `${newsItems.length.toLocaleString("ko-KR")}개` },
      { label: "종토방 버퍼", value: `${boardPosts.length.toLocaleString("ko-KR")}개` },
      { label: "텔레그램 버퍼", value: `${telegramMessages.length.toLocaleString("ko-KR")}개` },
      { label: "최근 프레임", value: dateTimeText(payload.lastFrameAt) },
      {
        label: "최근 틱",
        value: lastTick
          ? `${shortText(lastTick.symbol)} / ${numberText(lastTick.price)}원 / 거래량 ${numberText(lastTick.volume)}`
          : "-"
      },
      {
        label: "최근 뉴스",
        value: lastNews ? shortText(lastNews.headline) : "-"
      },
      {
        label: "최근 종토방",
        value: lastBoard ? shortText(lastBoard.title) : "-"
      },
      {
        label: "최근 텔레그램",
        value: lastTelegram ? shortText(lastTelegram.message) : "-"
      }
    ];
  }

  return genericPreview(payload);
}

function healthSummary(zone: ZoneKey, health: OrchestratorHealth | null): ZonePreviewItem[] {
  if (!health) {
    return [{ label: "상태", value: "헬스 데이터 수집 대기" }];
  }

  if (zone === "zone0") {
    return [
      { label: "틱 버퍼", value: `${health.zone0.ticksBuffered.toLocaleString("ko-KR")}개` },
      { label: "뉴스 버퍼", value: `${health.zone0.newsBuffered.toLocaleString("ko-KR")}개` },
      { label: "종토방 버퍼", value: `${health.zone0.boardBuffered.toLocaleString("ko-KR")}개` },
      { label: "텔레그램 버퍼", value: `${health.zone0.telegramBuffered.toLocaleString("ko-KR")}개` },
      { label: "최근 프레임", value: dateTimeText(health.zone0.lastFrameAt) }
    ];
  }

  if (zone === "zone1") {
    return [
      { label: "세션 일자", value: shortText(health.zone1.sessionDate) },
      { label: "당일 고가", value: numberText(health.zone1.high) },
      { label: "당일 저가", value: numberText(health.zone1.low) },
      { label: "이평 MA3", value: numberText(health.zone1.ma3) },
      { label: "이평 MA5", value: numberText(health.zone1.ma5) }
    ];
  }

  if (zone === "zone2") {
    return [
      { label: "제공자", value: sourceKo(health.zone2.provider) },
      { label: "공급원", value: sourceKo(health.zone2.source) },
      { label: "캐시 건수", value: `${health.zone2.cacheSize.toLocaleString("ko-KR")}개` },
      { label: "최근 점검", value: dateTimeText(health.zone2.lastCheckedAt) }
    ];
  }

  if (zone === "zone3") {
    return [
      { label: "제공자", value: sourceKo(health.zone3.provider) },
      { label: "공급원", value: sourceKo(health.zone3.source) },
      { label: "캔들 수", value: `${health.zone3.candleCount.toLocaleString("ko-KR")}개` },
      { label: "벡터 차원", value: `${health.zone3.vectorDim.toLocaleString("ko-KR")}차원` },
      { label: "최근 클래스", value: patternClassKo(health.zone3.lastClass ?? "-") },
      { label: "최근 유사도", value: health.zone3.lastSimilarity === null ? "-" : `${(health.zone3.lastSimilarity * 100).toFixed(1)}%` }
    ];
  }

  if (zone === "zone4") {
    return [
      { label: "제공자", value: sourceKo(health.zone4.provider) },
      { label: "공급원", value: sourceKo(health.zone4.source) },
      { label: "신호율(1분)", value: numberText(health.zone4.signalRate1m) },
      { label: "최근 점수", value: health.zone4.lastScore === null ? "-" : `${health.zone4.lastScore.toFixed(1)}점` },
      { label: "최근 단계", value: madnessStageKo(health.zone4.lastStage ?? "-") }
    ];
  }

  if (zone === "zone5") {
    return [
      { label: "제공자", value: sourceKo(health.zone5.provider) },
      { label: "공급원", value: sourceKo(health.zone5.source) },
      { label: "모델", value: shortText(health.zone5.llmModel) },
      { label: "최근 결정 ID", value: shortText(health.zone5.lastDecisionId ?? "-") },
      { label: "최근 액션", value: decisionActionKo(health.zone5.lastAction ?? "-") },
      {
        label: "최근 신뢰도",
        value: health.zone5.lastConfidence === null ? "-" : `${(health.zone5.lastConfidence * 100).toFixed(1)}%`
      }
    ];
  }

  return [
    { label: "제공자", value: sourceKo(health.zone6.provider) },
    { label: "공급원", value: sourceKo(health.zone6.source) },
    { label: "기록 수", value: `${health.zone6.recordCount.toLocaleString("ko-KR")}개` },
    { label: "최근 유사 이력", value: shortText(health.zone6.lastSimilarTradeId ?? "-") },
    { label: "최근 승률", value: health.zone6.lastWinRate === null ? "-" : `${(health.zone6.lastWinRate * 100).toFixed(1)}%` },
    { label: "최근 적재 이력", value: shortText(health.zone6.lastIngestedTradeId ?? "-") }
  ];
}

export function ZoneManagementMenu({ health }: ZoneManagementMenuProps) {
  const [opened, setOpened] = useState(true);
  const [activeZone, setActiveZone] = useState<ZoneKey>("zone0");
  const [zoneState, setZoneState] = useState<Record<ZoneKey, ZonePayloadState>>(createInitialZoneStates);

  const activeEndpoint = `${ORCHESTRATOR_URL}${ZONE_ENDPOINT[activeZone]}`;
  const currentState = zoneState[activeZone];

  const loadZoneState = useCallback(async (zone: ZoneKey) => {
    setZoneState((prev) => ({
      ...prev,
      [zone]: {
        ...prev[zone],
        loading: true,
        error: null
      }
    }));

    try {
      const response = await fetch(`${ORCHESTRATOR_URL}${ZONE_ENDPOINT[zone]}`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json"
        },
        cache: "no-store"
      });

      if (!response.ok) {
        throw new Error(`zone state request failed (${response.status})`);
      }

      const payload = (await response.json()) as unknown;
      const preview = previewFromPayload(zone, payload);

      setZoneState((prev) => ({
        ...prev,
        [zone]: {
          loading: false,
          error: null,
          fetchedAt: new Date().toISOString(),
          preview
        }
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "존 상태 조회 실패";
      setZoneState((prev) => ({
        ...prev,
        [zone]: {
          ...prev[zone],
          loading: false,
          error: message
        }
      }));
    }
  }, []);

  useEffect(() => {
    if (!opened) {
      return;
    }
    if (currentState.loading || currentState.fetchedAt) {
      return;
    }
    void loadZoneState(activeZone);
  }, [activeZone, currentState.fetchedAt, currentState.loading, loadZoneState, opened]);

  const healthItems = useMemo(() => healthSummary(activeZone, health), [activeZone, health]);

  return (
    <Panel
      title="존별 관리 메뉴"
      subtitle="Zone0~Zone6 상태 조회 / API 바로가기 / 운영 점검"
      className="mb-3"
      rightSlot={
        <button
          type="button"
          onClick={() => setOpened((prev) => !prev)}
          className="rounded-md border border-slate-700/80 bg-slate-900/80 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800"
        >
          {opened ? "메뉴 접기" : "메뉴 열기"}
        </button>
      }
    >
      {opened ? (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {ZONE_KEYS.map((zone) => (
              <button
                key={zone}
                type="button"
                onClick={() => setActiveZone(zone)}
                className={`rounded-md border px-2 py-1 text-xs ${
                  activeZone === zone
                    ? "border-cyan-500/60 bg-cyan-500/15 text-cyan-200"
                    : "border-slate-700/80 bg-slate-900/70 text-slate-300 hover:bg-slate-800"
                }`}
              >
                {ZONE_TITLE[zone]}
              </button>
            ))}
          </div>

          <div className="grid gap-3 xl:grid-cols-[1fr_1fr]">
            <div className="rounded-lg border border-slate-700/70 bg-slate-950/60 p-3">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">헬스 요약</p>
              <div className="mt-2 grid grid-cols-1 gap-1 text-xs text-slate-200 sm:grid-cols-2">
                {healthItems.map((item) => (
                  <p key={`${activeZone}:${item.label}`} className="truncate">
                    <span className="text-slate-400">{item.label}</span> {item.value}
                  </p>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-slate-700/70 bg-slate-950/60 p-3">
              <p className="text-xs uppercase tracking-[0.2em] text-slate-400">운영 액션</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void loadZoneState(activeZone)}
                  disabled={currentState.loading}
                  className="rounded-md border border-cyan-500/50 bg-cyan-500/10 px-2 py-1 text-xs text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-60"
                >
                  {currentState.loading ? "조회 중..." : "상태 새로고침"}
                </button>
                <a
                  href={activeEndpoint}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-md border border-slate-700/80 bg-slate-900/80 px-2 py-1 text-xs text-slate-200 hover:bg-slate-800"
                >
                  API 열기
                </a>
                <span className="text-[11px] text-slate-400">
                  최근 조회 {currentState.fetchedAt ? dateTimeText(currentState.fetchedAt) : "-"}
                </span>
              </div>
              <p className="mt-2 truncate text-[11px] text-slate-400">엔드포인트 {activeEndpoint}</p>
            </div>
          </div>

          <div className="rounded-lg border border-slate-700/70 bg-slate-950/60 p-3">
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">상세 조회 결과</p>
            {currentState.error ? (
              <p className="mt-2 text-sm text-rose-300">{currentState.error}</p>
            ) : currentState.loading ? (
              <p className="mt-2 text-sm text-slate-300">존 상태를 조회하고 있습니다...</p>
            ) : currentState.preview.length === 0 ? (
              <p className="mt-2 text-sm text-slate-400">조회 결과가 없습니다.</p>
            ) : (
              <div className="mt-2 grid grid-cols-1 gap-1 text-xs text-slate-200 sm:grid-cols-2">
                {currentState.preview.map((item) => (
                  <p key={`${activeZone}:${item.label}`} className="truncate">
                    <span className="text-slate-400">{item.label}</span> {item.value}
                  </p>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : (
        <p className="text-sm text-slate-400">존별 운영 메뉴가 접혀 있습니다. 우측 상단에서 열어주세요.</p>
      )}
    </Panel>
  );
}

