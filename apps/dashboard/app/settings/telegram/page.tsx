"use client";

import { Pencil, Plus, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

const ORCHESTRATOR_URL = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ?? "http://localhost:5001";

interface TelegramChannel {
  channelId: string;
  channelUsername: string;
  channelName: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

interface ChannelListResponse {
  ok: boolean;
  provider: string;
  items: TelegramChannel[];
}

interface UpsertResponse {
  ok: boolean;
  item: TelegramChannel;
}

type ModalMode = "create" | "edit";

interface FormState {
  channelName: string;
  channelUsername: string;
  isActive: boolean;
}

const EMPTY_FORM: FormState = {
  channelName: "",
  channelUsername: "",
  isActive: true
};

export default function TelegramSettingsPage() {
  const [items, setItems] = useState<TelegramChannel[]>([]);
  const [provider, setProvider] = useState<string>("UNKNOWN");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalMode, setModalMode] = useState<ModalMode>("create");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const activeCount = useMemo(() => items.filter((item) => item.isActive).length, [items]);

  useEffect(() => {
    void fetchChannels();
  }, []);

  async function fetchChannels(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${ORCHESTRATOR_URL}/api/zone0/telegram-channels`, {
        method: "GET",
        headers: {
          "Content-Type": "application/json"
        },
        cache: "no-store"
      });

      if (!response.ok) {
        throw new Error(`목록 조회 실패 (${response.status})`);
      }

      const json = (await response.json()) as ChannelListResponse;
      setItems(Array.isArray(json.items) ? json.items : []);
      setProvider(json.provider ?? "UNKNOWN");
    } catch (loadError) {
      const message = loadError instanceof Error ? loadError.message : "목록 조회 실패";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  function openCreateModal(): void {
    setModalMode("create");
    setEditingId(null);
    setForm(EMPTY_FORM);
    setModalOpen(true);
  }

  function openEditModal(item: TelegramChannel): void {
    setModalMode("edit");
    setEditingId(item.channelId);
    setForm({
      channelName: item.channelName,
      channelUsername: item.channelUsername,
      isActive: item.isActive
    });
    setModalOpen(true);
  }

  function closeModal(): void {
    if (saving) {
      return;
    }
    setModalOpen(false);
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  async function saveChannel(): Promise<void> {
    const channelName = form.channelName.trim();
    const channelUsername = normalizeUsername(form.channelUsername);

    if (!channelName || !channelUsername) {
      setError("채널명/유저네임을 입력해 주세요.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      if (modalMode === "create") {
        const response = await fetch(`${ORCHESTRATOR_URL}/api/zone0/telegram-channels`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            channelName,
            channelUsername,
            isActive: form.isActive
          })
        });

        if (!response.ok) {
          const message = await extractError(response, "채널 추가 실패");
          throw new Error(message);
        }

        const json = (await response.json()) as UpsertResponse;
        setItems((prev) => [json.item, ...prev]);
      } else {
        if (!editingId) {
          throw new Error("수정 대상이 없습니다.");
        }

        const response = await fetch(`${ORCHESTRATOR_URL}/api/zone0/telegram-channels/${encodeURIComponent(editingId)}`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            channelName,
            channelUsername,
            isActive: form.isActive
          })
        });

        if (!response.ok) {
          const message = await extractError(response, "채널 수정 실패");
          throw new Error(message);
        }

        const json = (await response.json()) as UpsertResponse;
        setItems((prev) => prev.map((item) => (item.channelId === json.item.channelId ? json.item : item)));
      }

      closeModal();
    } catch (saveError) {
      const message = saveError instanceof Error ? saveError.message : "저장 실패";
      setError(message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(item: TelegramChannel): Promise<void> {
    setError(null);
    const nextActive = !item.isActive;
    const rollback = item.isActive;

    setItems((prev) => prev.map((channel) => (channel.channelId === item.channelId ? { ...channel, isActive: nextActive } : channel)));
    try {
      const response = await fetch(`${ORCHESTRATOR_URL}/api/zone0/telegram-channels/${encodeURIComponent(item.channelId)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          isActive: nextActive
        })
      });

      if (!response.ok) {
        const message = await extractError(response, "수집 상태 변경 실패");
        throw new Error(message);
      }

      const json = (await response.json()) as UpsertResponse;
      setItems((prev) => prev.map((channel) => (channel.channelId === json.item.channelId ? json.item : channel)));
    } catch (toggleError) {
      const message = toggleError instanceof Error ? toggleError.message : "수집 상태 변경 실패";
      setError(message);
      setItems((prev) => prev.map((channel) => (channel.channelId === item.channelId ? { ...channel, isActive: rollback } : channel)));
    }
  }

  async function deleteChannel(channelId: string): Promise<void> {
    setError(null);

    const previous = items;
    setItems((prev) => prev.filter((item) => item.channelId !== channelId));
    try {
      const response = await fetch(`${ORCHESTRATOR_URL}/api/zone0/telegram-channels/${encodeURIComponent(channelId)}`, {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json"
        }
      });

      if (!response.ok) {
        const message = await extractError(response, "채널 삭제 실패");
        throw new Error(message);
      }
    } catch (deleteError) {
      const message = deleteError instanceof Error ? deleteError.message : "채널 삭제 실패";
      setError(message);
      setItems(previous);
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-4 text-slate-100 sm:px-6">
      <div className="mx-auto max-w-6xl">
        <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-slate-400">Zone 0 Settings</p>
            <h1 className="text-2xl font-semibold text-cyan-100">Telegram Channel Manager</h1>
            <p className="text-sm text-slate-400">
              전체 {items.length}개 / 활성 {activeCount}개 / Provider {provider}
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Link
              href="/"
              className="rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 hover:border-cyan-400/60"
            >
              대시보드 복귀
            </Link>
            <button
              type="button"
              onClick={openCreateModal}
              className="inline-flex items-center gap-1 rounded-md border border-cyan-500/60 bg-cyan-500/10 px-3 py-2 text-sm font-semibold text-cyan-200 hover:bg-cyan-500/20"
            >
              <Plus className="h-4 w-4" />
              신규 채널 추가
            </button>
          </div>
        </header>

        {error ? <p className="mb-3 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">{error}</p> : null}

        <section className="overflow-hidden rounded-md border border-slate-800 bg-slate-900/60">
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="border-b border-slate-800 bg-slate-950/60 text-xs uppercase tracking-[0.14em] text-slate-400">
                <tr>
                  <th className="px-3 py-2 text-left">채널명</th>
                  <th className="px-3 py-2 text-left">유저네임(@id)</th>
                  <th className="px-3 py-2 text-center">수집 상태</th>
                  <th className="px-3 py-2 text-center">관리</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-8 text-center text-slate-400">
                      로딩 중...
                    </td>
                  </tr>
                ) : items.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-3 py-8 text-center text-slate-400">
                      등록된 채널이 없습니다.
                    </td>
                  </tr>
                ) : (
                  items.map((item) => (
                    <tr key={item.channelId} className="border-b border-slate-800/80 last:border-0">
                      <td className="px-3 py-2 text-slate-100">{item.channelName}</td>
                      <td className="px-3 py-2 font-mono text-cyan-200">{item.channelUsername}</td>
                      <td className="px-3 py-2 text-center">
                        <button
                          type="button"
                          onClick={() => void toggleActive(item)}
                          className={`relative inline-flex h-7 w-14 items-center rounded-full border transition-all ${
                            item.isActive
                              ? "border-emerald-500/70 bg-emerald-500/20"
                              : "border-slate-600 bg-slate-800/80"
                          }`}
                        >
                          <span
                            className={`inline-block h-5 w-5 transform rounded-full transition-transform ${
                              item.isActive ? "translate-x-8 bg-emerald-300" : "translate-x-1 bg-slate-300"
                            }`}
                          />
                        </button>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-center gap-2">
                          <button
                            type="button"
                            onClick={() => openEditModal(item)}
                            className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200 hover:border-cyan-400/60"
                          >
                            <Pencil className="h-3.5 w-3.5" />
                            수정
                          </button>
                          <button
                            type="button"
                            onClick={() => void deleteChannel(item.channelId)}
                            className="inline-flex items-center gap-1 rounded border border-rose-500/50 bg-rose-500/10 px-2 py-1 text-xs text-rose-200 hover:bg-rose-500/20"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            삭제
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {modalOpen ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-md border border-slate-700 bg-slate-950 p-4 shadow-[0_18px_42px_rgba(2,8,23,0.6)]">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-slate-100">{modalMode === "create" ? "신규 채널 추가" : "채널 수정"}</h2>
              <button type="button" onClick={closeModal} className="rounded border border-slate-700 bg-slate-900 p-1 text-slate-300">
                <X className="h-4 w-4" />
              </button>
            </div>

            <label className="mb-2 block text-xs uppercase tracking-[0.14em] text-slate-400">채널명</label>
            <input
              type="text"
              value={form.channelName}
              onChange={(event) => setForm((prev) => ({ ...prev, channelName: event.target.value }))}
              className="mb-3 w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-cyan-400/70 focus:outline-none"
              placeholder="예: 여의도정보통"
            />

            <label className="mb-2 block text-xs uppercase tracking-[0.14em] text-slate-400">유저네임</label>
            <input
              type="text"
              value={form.channelUsername}
              onChange={(event) => setForm((prev) => ({ ...prev, channelUsername: event.target.value }))}
              className="mb-3 w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 focus:border-cyan-400/70 focus:outline-none"
              placeholder="@yeo2do"
            />

            <label className="mb-4 flex items-center gap-2 text-sm text-slate-300">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(event) => setForm((prev) => ({ ...prev, isActive: event.target.checked }))}
                className="h-4 w-4 rounded border-slate-600 bg-slate-900"
              />
              등록 직후 수집 활성화
            </label>

            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={closeModal}
                className="rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-200 hover:bg-slate-800"
              >
                취소
              </button>
              <button
                type="button"
                onClick={() => void saveChannel()}
                disabled={saving}
                className="rounded border border-cyan-500/70 bg-cyan-500/15 px-3 py-2 text-sm font-semibold text-cyan-200 hover:bg-cyan-500/25 disabled:opacity-50"
              >
                {saving ? "저장 중..." : modalMode === "create" ? "추가" : "수정"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function normalizeUsername(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

async function extractError(response: Response, fallback: string): Promise<string> {
  try {
    const data = (await response.json()) as { error?: string };
    if (data?.error) {
      return data.error;
    }
  } catch {
    // noop
  }
  return fallback;
}

