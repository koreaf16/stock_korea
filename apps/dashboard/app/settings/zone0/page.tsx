"use client";

import { X } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { TelegramChannelManager } from "@/components/settings/telegram-channel-manager";

const ORCHESTRATOR_URL = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ?? "http://localhost:5001";
const MIN_BOARD_POLL_MS = 10_000;
const MAX_BOARD_POLL_MS = 60_000;
const BOARD_POLL_STEP_MS = 1_000;
const REALTIME_POLL_MS = 4_000;
const LIVE_PREVIEW_LIMIT = 15;
const TELEGRAM_FRESH_WINDOW_MS = 120_000;

type Zone0Tab = "telegram" | "keywords" | "board";
type SaveMode = "keywords" | "board";

interface Zone0ConfigResponse {
  ok?: boolean;
  keywords?: unknown;
  boardPollMs?: unknown;
  error?: string;
}

interface Zone0NewsItem {
  id?: string;
  symbol?: string;
  headline?: string;
  body?: string;
  sentimentHint?: number;
  timestamp?: string;
}

interface Zone0BoardPost {
  id?: string;
  symbol?: string;
  title?: string;
  content?: string;
  sentimentHint?: number;
  timestamp?: string;
}

interface Zone0DartDisclosure {
  id?: string;
  symbol?: string;
  corpName?: string;
  reportName?: string;
  sentimentHint?: number;
  timestamp?: string;
}

interface Zone0TelegramMessage {
  id?: string;
  symbol?: string;
  message?: string;
  priority?: string;
  sentimentHint?: number;
  timestamp?: string;
}

interface Zone0BufferSnapshot {
  newsItems: Zone0NewsItem[];
  boardPosts: Zone0BoardPost[];
  dartDisclosures: Zone0DartDisclosure[];
  telegramMessages: Zone0TelegramMessage[];
  lastFrameAt: string | null;
}

interface Zone0HealthSnapshot {
  ticksBuffered?: unknown;
  newsBuffered?: unknown;
  boardBuffered?: unknown;
  dartBuffered?: unknown;
  fundamentalBuffered?: unknown;
  macroBuffered?: unknown;
  telegramBuffered?: unknown;
  lastFrameAt?: unknown;
}

interface Zone0HealthResponse {
  ok?: boolean;
  zone0?: Zone0HealthSnapshot;
  now?: string;
  error?: string;
}

const CONTROL_INPUT_CLASS =
  "w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-cyan-400 focus:outline-none";
const CONTROL_BUTTON_CLASS =
  "inline-flex items-center rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 transition-colors hover:border-cyan-400/70 hover:text-cyan-300 focus:border-cyan-400 focus:outline-none disabled:opacity-50";
const LIVE_PANEL_CLASS = "rounded-md border border-slate-800 bg-slate-900/60 p-4";
const LIVE_SECTION_CLASS = "rounded-md border border-slate-800 bg-slate-950/50 p-3";

function resolveTab(raw: string | null): Zone0Tab {
  if (raw === "keywords" || raw === "board" || raw === "telegram") {
    return raw;
  }
  return "telegram";
}

function normalizeKeywords(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const token = String(value ?? "").trim();
    if (!token || seen.has(token)) {
      continue;
    }
    seen.add(token);
    deduped.push(token);
  }
  return deduped;
}

function normalizeBoardPollMs(raw: unknown, fallback = 20_000): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  const asInt = Math.floor(parsed);
  return Math.max(MIN_BOARD_POLL_MS, Math.min(MAX_BOARD_POLL_MS, asInt));
}

function parseKeywordTokens(raw: string): string[] {
  return raw
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
}

function pickObject(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return raw as Record<string, unknown>;
}

function pickArray<T>(raw: unknown, key: string): T[] {
  const obj = pickObject(raw);
  if (!obj) {
    return [];
  }
  const value = obj[key];
  return Array.isArray(value) ? (value as T[]) : [];
}

function pickStringOrNull(raw: unknown, key: string): string | null {
  const obj = pickObject(raw);
  if (!obj) {
    return null;
  }
  const value = obj[key];
  return typeof value === "string" ? value : null;
}

function normalizeBufferSnapshot(raw: unknown): Zone0BufferSnapshot {
  return {
    newsItems: pickArray<Zone0NewsItem>(raw, "newsItems"),
    boardPosts: pickArray<Zone0BoardPost>(raw, "boardPosts"),
    dartDisclosures: pickArray<Zone0DartDisclosure>(raw, "dartDisclosures"),
    telegramMessages: pickArray<Zone0TelegramMessage>(raw, "telegramMessages"),
    lastFrameAt: pickStringOrNull(raw, "lastFrameAt")
  };
}

function formatTimestamp(raw?: string | null): string {
  if (!raw) {
    return "-";
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return raw;
  }
  return `${date.toLocaleDateString("ko-KR")} ${date.toLocaleTimeString("ko-KR", { hour12: false })}`;
}

function sliceLatest<T>(items: T[], limit = LIVE_PREVIEW_LIMIT): T[] {
  if (items.length <= limit) {
    return [...items].reverse();
  }
  return items.slice(items.length - limit).reverse();
}

function toCountOrNull(raw: unknown): number | null {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return Math.floor(parsed);
}

function truncateText(raw: string | undefined, maxLength = 120): string {
  const text = String(raw ?? "").trim();
  if (!text) {
    return "-";
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function resolveTabTitle(tab: Zone0Tab): string {
  if (tab === "telegram") {
    return "Telegram 수집 채널";
  }
  if (tab === "keywords") {
    return "뉴스/공시 키워드 감시";
  }
  return "종토방 크롤링 제어";
}

function resolveTelegramCollectionState(latestTimestamp: string | null): { label: string; tone: string } {
  if (!latestTimestamp) {
    return {
      label: "미수신",
      tone: "text-rose-300"
    };
  }

  const parsed = Date.parse(latestTimestamp);
  if (!Number.isFinite(parsed)) {
    return {
      label: "상태 확인 필요",
      tone: "text-yellow-400"
    };
  }

  const delta = Date.now() - parsed;
  if (delta <= TELEGRAM_FRESH_WINDOW_MS) {
    return {
      label: "수집 중",
      tone: "text-emerald-400"
    };
  }

  return {
    label: "수집 지연",
    tone: "text-yellow-400"
  };
}

export default function Zone0SettingsPage() {
  const searchParams = useSearchParams();
  const activeTab = resolveTab(searchParams.get("tab"));

  const [keywords, setKeywords] = useState<string[]>([]);
  const [keywordInput, setKeywordInput] = useState("");
  const [boardPollMs, setBoardPollMs] = useState(20_000);
  const [persistedBoardPollMs, setPersistedBoardPollMs] = useState(20_000);

  const [loadingConfig, setLoadingConfig] = useState(true);
  const [refreshingConfig, setRefreshingConfig] = useState(false);
  const [savingKeywords, setSavingKeywords] = useState(false);
  const [savingBoard, setSavingBoard] = useState(false);
  const [sliderDirty, setSliderDirty] = useState(false);

  const [bufferSnapshot, setBufferSnapshot] = useState<Zone0BufferSnapshot | null>(null);
  const [healthSnapshot, setHealthSnapshot] = useState<Zone0HealthResponse | null>(null);
  const [loadingRealtime, setLoadingRealtime] = useState(true);
  const [refreshingRealtime, setRefreshingRealtime] = useState(false);
  const [realtimeError, setRealtimeError] = useState<string | null>(null);
  const [realtimeFetchedAt, setRealtimeFetchedAt] = useState<string | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const boardPollSeconds = useMemo(() => Math.floor(boardPollMs / 1_000), [boardPollMs]);
  const nearMinBoundary = boardPollMs <= 15_000;

  const liveNewsItems = useMemo(() => sliceLatest(bufferSnapshot?.newsItems ?? []), [bufferSnapshot?.newsItems]);
  const liveBoardPosts = useMemo(() => sliceLatest(bufferSnapshot?.boardPosts ?? []), [bufferSnapshot?.boardPosts]);
  const liveDartDisclosures = useMemo(
    () => sliceLatest(bufferSnapshot?.dartDisclosures ?? []),
    [bufferSnapshot?.dartDisclosures]
  );
  const liveTelegramMessages = useMemo(
    () => sliceLatest(bufferSnapshot?.telegramMessages ?? []),
    [bufferSnapshot?.telegramMessages]
  );

  const zone0Health = healthSnapshot?.zone0;
  const newsBufferedCount =
    toCountOrNull(zone0Health?.newsBuffered) ?? (bufferSnapshot ? bufferSnapshot.newsItems.length : 0);
  const boardBufferedCount =
    toCountOrNull(zone0Health?.boardBuffered) ?? (bufferSnapshot ? bufferSnapshot.boardPosts.length : 0);
  const dartBufferedCount =
    toCountOrNull(zone0Health?.dartBuffered) ?? (bufferSnapshot ? bufferSnapshot.dartDisclosures.length : 0);
  const telegramBufferedCount =
    toCountOrNull(zone0Health?.telegramBuffered) ?? (bufferSnapshot ? bufferSnapshot.telegramMessages.length : 0);

  const latestTelegramAt = liveTelegramMessages[0]?.timestamp ?? null;
  const telegramCollectionState = resolveTelegramCollectionState(latestTelegramAt);

  useEffect(() => {
    void loadConfig();
    void loadRealtime();

    const timer = setInterval(() => {
      void loadRealtime(true);
    }, REALTIME_POLL_MS);

    return () => {
      clearInterval(timer);
    };
  }, []);

  async function loadConfig(refresh = false): Promise<void> {
    if (refresh) {
      setRefreshingConfig(true);
    } else {
      setLoadingConfig(true);
    }
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(`${ORCHESTRATOR_URL}/api/zone0/config`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json"
        },
        cache: "no-store"
      });

      const payload = (await response.json().catch(() => ({}))) as Zone0ConfigResponse;
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error ?? `설정 조회 실패 (${response.status})`);
      }

      const nextKeywords = normalizeKeywords(payload.keywords);
      const nextBoardPollMs = normalizeBoardPollMs(payload.boardPollMs, boardPollMs);
      setKeywords(nextKeywords);
      setBoardPollMs(nextBoardPollMs);
      setPersistedBoardPollMs(nextBoardPollMs);
    } catch (fetchError) {
      const message = fetchError instanceof Error ? fetchError.message : "설정 조회 실패";
      setError(message);
    } finally {
      setLoadingConfig(false);
      setRefreshingConfig(false);
    }
  }

  async function loadRealtime(refresh = false): Promise<void> {
    if (refresh) {
      setRefreshingRealtime(true);
    } else {
      setLoadingRealtime(true);
    }

    try {
      const [bufferResponse, healthResponse] = await Promise.all([
        fetch(`${ORCHESTRATOR_URL}/api/zone0/buffer`, {
          method: "GET",
          headers: {
            "Content-Type": "application/json"
          },
          cache: "no-store"
        }),
        fetch(`${ORCHESTRATOR_URL}/health`, {
          method: "GET",
          headers: {
            "Content-Type": "application/json"
          },
          cache: "no-store"
        })
      ]);

      const bufferPayload = await bufferResponse.json().catch(() => ({}));
      const healthPayload = (await healthResponse.json().catch(() => ({}))) as Zone0HealthResponse;

      if (!bufferResponse.ok) {
        throw new Error(`실시간 버퍼 조회 실패 (${bufferResponse.status})`);
      }
      if (!healthResponse.ok || healthPayload.ok === false) {
        throw new Error(healthPayload.error ?? `헬스 체크 실패 (${healthResponse.status})`);
      }

      setBufferSnapshot(normalizeBufferSnapshot(bufferPayload));
      setHealthSnapshot(healthPayload);
      setRealtimeFetchedAt(typeof healthPayload.now === "string" ? healthPayload.now : new Date().toISOString());
      setRealtimeError(null);
    } catch (fetchError) {
      const message = fetchError instanceof Error ? fetchError.message : "실시간 조회 실패";
      setRealtimeError(message);
    } finally {
      setLoadingRealtime(false);
      setRefreshingRealtime(false);
    }
  }

  async function putConfig(
    nextKeywords: string[],
    nextBoardPollMs: number,
    mode: SaveMode,
    successMessage: string
  ): Promise<void> {
    if (mode === "keywords") {
      setSavingKeywords(true);
    } else {
      setSavingBoard(true);
    }
    setError(null);
    setNotice(null);

    try {
      const response = await fetch(`${ORCHESTRATOR_URL}/api/zone0/config`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          keywords: nextKeywords,
          boardPollMs: nextBoardPollMs
        })
      });

      const payload = (await response.json().catch(() => ({}))) as Zone0ConfigResponse;
      if (!response.ok || payload.ok === false) {
        throw new Error(payload.error ?? `설정 저장 실패 (${response.status})`);
      }

      const savedKeywords = normalizeKeywords(payload.keywords ?? nextKeywords);
      const savedBoardPollMs = normalizeBoardPollMs(payload.boardPollMs, nextBoardPollMs);
      setKeywords(savedKeywords);
      setBoardPollMs(savedBoardPollMs);
      setPersistedBoardPollMs(savedBoardPollMs);
      setSliderDirty(false);
      setNotice(successMessage);
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : "설정 저장 실패";
      setError(message);
      if (mode === "board") {
        setBoardPollMs(persistedBoardPollMs);
        setSliderDirty(false);
      }
    } finally {
      if (mode === "keywords") {
        setSavingKeywords(false);
      } else {
        setSavingBoard(false);
      }
    }
  }

  function addKeyword(raw: string): void {
    const tokens = parseKeywordTokens(raw);
    if (tokens.length === 0) {
      return;
    }

    setKeywords((prev) => {
      const seen = new Set(prev);
      const merged = [...prev];
      for (const token of tokens) {
        if (seen.has(token)) {
          continue;
        }
        seen.add(token);
        merged.push(token);
      }
      return merged;
    });
  }

  function removeKeyword(target: string): void {
    setKeywords((prev) => prev.filter((keyword) => keyword !== target));
  }

  function commitKeywordInput(): void {
    const raw = keywordInput.trim();
    if (!raw) {
      return;
    }
    addKeyword(raw);
    setKeywordInput("");
  }

  async function saveKeywords(): Promise<void> {
    await putConfig(keywords, boardPollMs, "keywords", "키워드 설정이 저장되었습니다.");
  }

  async function commitBoardPollMs(nextMs: number): Promise<void> {
    if (nextMs === persistedBoardPollMs) {
      setSliderDirty(false);
      return;
    }
    await putConfig(keywords, nextMs, "board", "종토방 폴링 주기가 업데이트되었습니다.");
  }

  function handleSliderChange(nextValue: string): void {
    const normalized = normalizeBoardPollMs(Number(nextValue), boardPollMs);
    setBoardPollMs(normalized);
    setSliderDirty(true);
  }

  function handleSliderCommit(): void {
    if (!sliderDirty || savingBoard) {
      return;
    }
    void commitBoardPollMs(boardPollMs);
  }

  function renderSettingsPanel(): JSX.Element {
    if (activeTab === "telegram") {
      return (
        <section className="rounded-md border border-slate-800 bg-slate-900/60 p-4">
          <TelegramChannelManager />
        </section>
      );
    }

    if (loadingConfig) {
      return (
        <section className="rounded-md border border-slate-800 bg-slate-900/60 p-4">
          <p className="text-sm text-slate-300">Loading Zone 0 config...</p>
        </section>
      );
    }

    if (activeTab === "keywords") {
      return (
        <section className="rounded-md border border-slate-800 bg-slate-900/60 p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-lg font-semibold text-cyan-400">뉴스/공시 키워드 감시</h2>
              <p className="text-sm text-slate-400">Enter로 키워드를 추가하고 태그의 X로 삭제한 뒤 저장하세요.</p>
            </div>
            <button
              type="button"
              onClick={() => void loadConfig(true)}
              disabled={refreshingConfig}
              className={CONTROL_BUTTON_CLASS}
            >
              {refreshingConfig ? "Loading..." : "다시 불러오기"}
            </button>
          </div>

          <div className="rounded-md border border-slate-700 bg-slate-900 p-2">
            <div className="mb-2 flex flex-wrap gap-2">
              {keywords.length === 0 ? (
                <span className="text-sm text-slate-500">등록된 키워드가 없습니다.</span>
              ) : (
                keywords.map((keyword) => (
                  <span
                    key={keyword}
                    className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-sm text-cyan-200"
                  >
                    {keyword}
                    <button
                      type="button"
                      onClick={() => removeKeyword(keyword)}
                      className="inline-flex h-4 w-4 items-center justify-center rounded text-slate-400 transition-colors hover:text-rose-300 focus:border-cyan-400 focus:outline-none"
                      aria-label={`${keyword} 삭제`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))
              )}
            </div>

            <input
              type="text"
              value={keywordInput}
              onChange={(event) => setKeywordInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commitKeywordInput();
                }
              }}
              onBlur={commitKeywordInput}
              className={CONTROL_INPUT_CLASS}
              placeholder="키워드를 입력하고 Enter"
            />
          </div>

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void saveKeywords()}
              disabled={savingKeywords}
              className={`${CONTROL_BUTTON_CLASS} text-cyan-400`}
            >
              {savingKeywords ? "Saving..." : "저장"}
            </button>
            <span className="text-sm text-slate-400">
              현재 <span className="text-emerald-400">{keywords.length}개</span>
            </span>
          </div>
        </section>
      );
    }

    return (
      <section className="rounded-md border border-slate-800 bg-slate-900/60 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-semibold text-cyan-400">종토방 크롤링 제어</h2>
            <p className="text-sm text-slate-400">슬라이더를 조절하고 마우스를 떼면 즉시 저장됩니다.</p>
          </div>
          <button
            type="button"
            onClick={() => void loadConfig(true)}
            disabled={refreshingConfig}
            className={CONTROL_BUTTON_CLASS}
          >
            {refreshingConfig ? "Loading..." : "다시 불러오기"}
          </button>
        </div>

        <div className="rounded-md border border-slate-700 bg-slate-900 p-3">
          <input
            type="range"
            min={MIN_BOARD_POLL_MS}
            max={MAX_BOARD_POLL_MS}
            step={BOARD_POLL_STEP_MS}
            value={boardPollMs}
            onChange={(event) => handleSliderChange(event.target.value)}
            onMouseUp={handleSliderCommit}
            onTouchEnd={handleSliderCommit}
            onBlur={handleSliderCommit}
            className="w-full accent-cyan-400"
          />

          <p className="mt-3 text-sm text-slate-200">
            현재 폴링 주기: <span className="text-cyan-400">{boardPollSeconds}초</span>
          </p>
          <p className="mt-1 text-xs text-slate-500">범위: 10초 ~ 60초</p>
          {nearMinBoundary ? <p className="mt-2 text-sm text-yellow-500">트래픽 주의: 폴링 주기가 매우 짧습니다.</p> : null}

          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void commitBoardPollMs(boardPollMs)}
              disabled={savingBoard || !sliderDirty}
              className={`${CONTROL_BUTTON_CLASS} text-cyan-400`}
            >
              {savingBoard ? "Saving..." : "지금 저장"}
            </button>
            {savingBoard ? <span className="text-sm text-slate-400">타이머 갱신 중...</span> : null}
          </div>
        </div>
      </section>
    );
  }

  function renderTelegramRealtime(): JSX.Element {
    return (
      <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <article className={LIVE_SECTION_CLASS}>
            <p className="text-xs uppercase tracking-[0.14em] text-slate-400">수집 상태</p>
            <p className={`mt-1 text-base font-semibold ${telegramCollectionState.tone}`}>{telegramCollectionState.label}</p>
            <p className="mt-1 text-xs text-slate-500">
              최근 메시지 시각: <span className="text-slate-300">{formatTimestamp(latestTelegramAt)}</span>
            </p>
          </article>
          <article className={LIVE_SECTION_CLASS}>
            <p className="text-xs uppercase tracking-[0.14em] text-slate-400">버퍼 카운트</p>
            <p className="mt-1 text-base font-semibold text-cyan-300">{telegramBufferedCount.toLocaleString("ko-KR")}건</p>
            <p className="mt-1 text-xs text-slate-500">
              최근 폴링 시각: <span className="text-slate-300">{formatTimestamp(realtimeFetchedAt)}</span>
            </p>
          </article>
        </div>

        <section className={LIVE_SECTION_CLASS}>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-cyan-300">최근 텔레그램 메시지</h3>
            <span className="text-xs text-slate-500">최대 {LIVE_PREVIEW_LIMIT}건</span>
          </div>
          {liveTelegramMessages.length === 0 ? (
            <p className="text-sm text-slate-500">아직 수집된 텔레그램 메시지가 없습니다.</p>
          ) : (
            <div className="space-y-2">
              {liveTelegramMessages.map((item) => (
                <article key={item.id ?? `${item.symbol ?? "UNK"}-${item.timestamp ?? "NA"}`} className="rounded border border-slate-800 bg-slate-900 p-2">
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-mono text-cyan-200">{item.symbol ?? "-"}</span>
                    <span className="rounded border border-slate-700 px-1.5 py-0.5 text-slate-300">{item.priority ?? "-"}</span>
                    <span className="text-slate-500">{formatTimestamp(item.timestamp)}</span>
                  </div>
                  <p className="text-sm text-slate-200">{truncateText(item.message, 160)}</p>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    );
  }

  function renderKeywordRealtime(): JSX.Element {
    return (
      <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-3">
          <article className={LIVE_SECTION_CLASS}>
            <p className="text-xs uppercase tracking-[0.14em] text-slate-400">뉴스 버퍼</p>
            <p className="mt-1 text-base font-semibold text-cyan-300">{newsBufferedCount.toLocaleString("ko-KR")}건</p>
          </article>
          <article className={LIVE_SECTION_CLASS}>
            <p className="text-xs uppercase tracking-[0.14em] text-slate-400">공시 버퍼</p>
            <p className="mt-1 text-base font-semibold text-emerald-400">{dartBufferedCount.toLocaleString("ko-KR")}건</p>
          </article>
          <article className={LIVE_SECTION_CLASS}>
            <p className="text-xs uppercase tracking-[0.14em] text-slate-400">활성 키워드</p>
            <p className="mt-1 text-base font-semibold text-cyan-200">{keywords.length.toLocaleString("ko-KR")}개</p>
          </article>
        </div>

        <section className={LIVE_SECTION_CLASS}>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-cyan-300">최근 뉴스 원문</h3>
            <span className="text-xs text-slate-500">최대 {LIVE_PREVIEW_LIMIT}건</span>
          </div>
          {liveNewsItems.length === 0 ? (
            <p className="text-sm text-slate-500">수집된 뉴스가 없습니다.</p>
          ) : (
            <div className="space-y-2">
              {liveNewsItems.map((item) => (
                <article key={item.id ?? `${item.symbol ?? "UNK"}-${item.timestamp ?? "NA"}`} className="rounded border border-slate-800 bg-slate-900 p-2">
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-mono text-cyan-200">{item.symbol ?? "-"}</span>
                    <span className="text-slate-500">{formatTimestamp(item.timestamp)}</span>
                  </div>
                  <p className="text-sm text-slate-200">{truncateText(item.headline, 140)}</p>
                </article>
              ))}
            </div>
          )}
        </section>

        <section className={LIVE_SECTION_CLASS}>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-emerald-400">최근 공시 원문</h3>
            <span className="text-xs text-slate-500">최대 {LIVE_PREVIEW_LIMIT}건</span>
          </div>
          {liveDartDisclosures.length === 0 ? (
            <p className="text-sm text-slate-500">수집된 공시가 없습니다.</p>
          ) : (
            <div className="space-y-2">
              {liveDartDisclosures.map((item) => (
                <article key={item.id ?? `${item.symbol ?? "UNK"}-${item.timestamp ?? "NA"}`} className="rounded border border-slate-800 bg-slate-900 p-2">
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-mono text-cyan-200">{item.symbol ?? "-"}</span>
                    <span className="text-slate-500">{formatTimestamp(item.timestamp)}</span>
                  </div>
                  <p className="text-sm text-slate-200">{truncateText(item.reportName, 140)}</p>
                  <p className="mt-1 text-xs text-slate-500">{truncateText(item.corpName, 120)}</p>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    );
  }

  function renderBoardRealtime(): JSX.Element {
    return (
      <div className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-2">
          <article className={LIVE_SECTION_CLASS}>
            <p className="text-xs uppercase tracking-[0.14em] text-slate-400">종토방 버퍼</p>
            <p className="mt-1 text-base font-semibold text-cyan-300">{boardBufferedCount.toLocaleString("ko-KR")}건</p>
          </article>
          <article className={LIVE_SECTION_CLASS}>
            <p className="text-xs uppercase tracking-[0.14em] text-slate-400">현재 폴링 주기</p>
            <p className="mt-1 text-base font-semibold text-cyan-200">{Math.floor(boardPollMs / 1_000)}초</p>
            {boardPollMs <= 15_000 ? <p className="mt-1 text-xs text-yellow-500">트래픽 주의 구간</p> : null}
          </article>
        </div>

        <section className={LIVE_SECTION_CLASS}>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-cyan-300">최근 종토방 게시글</h3>
            <span className="text-xs text-slate-500">최대 {LIVE_PREVIEW_LIMIT}건</span>
          </div>
          {liveBoardPosts.length === 0 ? (
            <p className="text-sm text-slate-500">수집된 종토방 게시글이 없습니다.</p>
          ) : (
            <div className="space-y-2">
              {liveBoardPosts.map((item) => (
                <article key={item.id ?? `${item.symbol ?? "UNK"}-${item.timestamp ?? "NA"}`} className="rounded border border-slate-800 bg-slate-900 p-2">
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-mono text-cyan-200">{item.symbol ?? "-"}</span>
                    <span className="text-slate-500">{formatTimestamp(item.timestamp)}</span>
                  </div>
                  <p className="text-sm text-slate-200">{truncateText(item.title, 140)}</p>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[1.05fr_0.95fr]">
      <section className="space-y-3">
        <article className="rounded-md border border-slate-800 bg-slate-950/50 px-3 py-2">
          <p className="text-xs uppercase tracking-[0.14em] text-slate-400">Zone 0 Control</p>
          <p className="text-sm text-slate-200">설정은 좌측에서 변경하고, 우측에서 실시간 수집 데이터를 확인하세요.</p>
        </article>

        {activeTab !== "telegram" && error ? (
          <p className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">Error: {error}</p>
        ) : null}
        {activeTab !== "telegram" && notice ? (
          <p className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-400">{notice}</p>
        ) : null}

        {renderSettingsPanel()}
      </section>

      <section className={LIVE_PANEL_CLASS}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <p className="text-xs uppercase tracking-[0.14em] text-slate-400">Live Ingestion</p>
            <h2 className="text-lg font-semibold text-cyan-400">{resolveTabTitle(activeTab)} 실시간 데이터</h2>
            <p className="text-xs text-slate-500">갱신 시각: {formatTimestamp(realtimeFetchedAt ?? bufferSnapshot?.lastFrameAt)}</p>
          </div>
          <button
            type="button"
            onClick={() => void loadRealtime(true)}
            disabled={refreshingRealtime}
            className={CONTROL_BUTTON_CLASS}
          >
            {refreshingRealtime ? "갱신 중..." : "실시간 새로고침"}
          </button>
        </div>

        {realtimeError ? (
          <p className="mb-3 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">Error: {realtimeError}</p>
        ) : null}

        {loadingRealtime && !bufferSnapshot ? (
          <div className={LIVE_SECTION_CLASS}>
            <p className="text-sm text-slate-300">Loading realtime Zone 0 data...</p>
          </div>
        ) : null}

        {!loadingRealtime || bufferSnapshot ? (
          <div>
            {activeTab === "telegram" ? renderTelegramRealtime() : null}
            {activeTab === "keywords" ? renderKeywordRealtime() : null}
            {activeTab === "board" ? renderBoardRealtime() : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
