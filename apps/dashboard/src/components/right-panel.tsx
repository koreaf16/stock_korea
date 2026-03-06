"use client";

import type { DashboardSnapshot, OrderSide } from "@stock/contracts";
import { useMemo, useState } from "react";

import { formatKrw, formatPct, formatTs } from "@/lib/format";
import { decisionActionKo, narrativeKo, orderSideKo, orderSourceKo, orderStatusKo } from "@/lib/korean";
import type { OrchestratorHealth } from "@/lib/orchestrator-health";

import { Panel } from "./panel";

interface RightPanelProps {
  snapshot: DashboardSnapshot;
  health: OrchestratorHealth | null;
  busy: boolean;
  onManualOrder: (side: OrderSide, qty: number) => Promise<void>;
}

export function RightPanel({ snapshot, health, busy, onManualOrder }: RightPanelProps) {
  const [qty, setQty] = useState<number>(1);

  const active = useMemo(
    () => snapshot.positions.find((position) => position.symbol === snapshot.targetSymbol),
    [snapshot.positions, snapshot.targetSymbol]
  );

  const halfCloseQty = active ? Math.max(1, Math.floor(active.qty / 2)) : 0;

  const bidDepth = Math.max(0, snapshot.tick.bidDepth);
  const askDepth = Math.max(0, snapshot.tick.askDepth);
  const depthTotal = Math.max(1, bidDepth + askDepth);
  const bidPct = (bidDepth / depthTotal) * 100;
  const askPct = (askDepth / depthTotal) * 100;

  const presetQty = [1, 3, 5, 10];

  return (
    <Panel
      title="체결 실행 및 호가창"
      subtitle="실행 로그 / 보유종목 / 수동 오버라이드"
      className="h-full"
      rightSlot={
        <span className="rounded-full border border-slate-700/80 bg-slate-900/80 px-2 py-0.5 text-[11px] text-slate-300">
          존6 기록 {health?.zone6.recordCount ?? "-"}
        </span>
      }
    >
      <div className="grid h-full grid-rows-[auto_auto_1fr_auto] gap-3">
        <div className="rounded-xl border border-slate-700/60 bg-slate-900/65 p-3">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">존 5 최종 판단</p>
          <div className="mt-1 flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-100">
              {decisionActionKo(snapshot.decision.action)} ({(snapshot.decision.confidenceScore * 100).toFixed(1)}%)
            </p>
            <span className="rounded-md border border-slate-700/70 bg-slate-950/70 px-2 py-0.5 text-[11px] text-slate-300">
              비중 {snapshot.decision.suggestedWeightPct.toFixed(0)}%
            </span>
          </div>
          <p className="mt-1 max-h-10 overflow-hidden text-xs text-slate-300">{narrativeKo(snapshot.decision.reasoning)}</p>
          <p className="mt-2 text-[11px] text-slate-400">
            목표가 {snapshot.decision.targetPrice?.toLocaleString() ?? "-"} / 손절가 {snapshot.decision.stopPrice?.toLocaleString() ?? "-"}
          </p>
        </div>

        <div className="rounded-xl border border-slate-700/60 bg-slate-950/70 p-3">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">호가 잔량 압력</p>
          <div className="mt-2 h-3 overflow-hidden rounded-full bg-slate-800">
            <div className="flex h-full w-full">
              <div className="bg-blue-400" style={{ width: `${bidPct.toFixed(1)}%` }} />
              <div className="bg-rose-400" style={{ width: `${askPct.toFixed(1)}%` }} />
            </div>
          </div>
          <div className="mt-1 flex items-center justify-between text-[11px] text-slate-300">
            <span>매수 잔량 {formatKrw(bidDepth)}</span>
            <span>매도 잔량 {formatKrw(askDepth)}</span>
          </div>
        </div>

        <div className="grid grid-rows-[1fr_1fr] gap-3">
          <div className="rounded-xl border border-slate-700/60 bg-slate-900/60 p-3">
            <p className="mb-2 text-xs uppercase tracking-[0.2em] text-slate-400">보유 포지션</p>
            {snapshot.positions.length === 0 ? (
              <p className="text-sm text-slate-400">보유 종목 없음</p>
            ) : (
              <div className="space-y-2 text-sm">
                {snapshot.positions.map((position) => (
                  <div key={position.symbol} className="rounded-md border border-slate-700/70 bg-slate-950/60 p-2">
                    <div className="flex items-center justify-between">
                      <p className="font-semibold text-slate-100">
                        {position.symbol} / {position.qty}주
                      </p>
                      <span className={position.pnlPct >= 0 ? "text-rose-300" : "text-blue-300"}>{formatPct(position.pnlPct)}</span>
                    </div>
                    <p className="mt-1 text-xs text-slate-300">
                      진입 {formatKrw(position.entryPrice)} / 현재 {formatKrw(position.currentPrice)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-700/60 bg-slate-950/60 p-3">
            <p className="mb-2 text-xs uppercase tracking-[0.2em] text-slate-400">주문 로그</p>
            <div className="terminal-font h-[158px] overflow-auto text-xs">
              {snapshot.orderLog.length === 0 ? (
                <p className="text-slate-500">주문 로그 없음</p>
              ) : (
                snapshot.orderLog.slice(0, 30).map((log) => (
                  <p key={log.id} className="truncate text-slate-200">
                    [{formatTs(log.timestamp)}] {orderSourceKo(log.source)} {orderSideKo(log.side)} {log.symbol} {log.qty}주 /{" "}
                    {formatKrw(log.price)}원{" "}
                    <span className={log.status === "FILLED" ? "text-emerald-300" : "text-amber-300"}>
                      {orderStatusKo(log.status)}
                    </span>
                  </p>
                ))
              )}
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-slate-700/60 bg-slate-900/70 p-3">
          <p className="text-xs uppercase tracking-[0.2em] text-slate-400">수동 오버라이드</p>
          <div className="mt-2 flex items-center gap-2">
            <input
              type="number"
              min={1}
              value={qty}
              onChange={(e) => setQty(Math.max(1, Number(e.target.value || 1)))}
              className="w-24 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100"
            />
            <span className="text-xs text-slate-400">수량 ({snapshot.targetSymbol})</span>
          </div>

          <div className="mt-2 flex flex-wrap gap-1.5">
            {presetQty.map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setQty(value)}
                className="rounded-md border border-slate-700/80 bg-slate-950/70 px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-800"
              >
                {value}주
              </button>
            ))}
          </div>

          <div className="mt-3 grid grid-cols-3 gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => onManualOrder("BUY", qty)}
              className="rounded bg-rose-500/90 px-2 py-2 text-xs font-semibold text-rose-50 hover:bg-rose-400 disabled:opacity-50"
            >
              시장가 매수
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onManualOrder("SELL", qty)}
              className="rounded bg-blue-500/90 px-2 py-2 text-xs font-semibold text-blue-50 hover:bg-blue-400 disabled:opacity-50"
            >
              시장가 매도
            </button>
            <button
              type="button"
              disabled={busy || halfCloseQty <= 0}
              onClick={() => onManualOrder("SELL", halfCloseQty)}
              className="rounded bg-amber-500/90 px-2 py-2 text-xs font-semibold text-amber-50 hover:bg-amber-400 disabled:opacity-50"
            >
              절반 청산
            </button>
          </div>
        </div>
      </div>
    </Panel>
  );
}
