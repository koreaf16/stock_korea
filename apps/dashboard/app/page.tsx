"use client";

import type { OrderSide } from "@stock/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CenterPanel } from "@/components/center-panel";
import { LeftPanel } from "@/components/left-panel";
import { RightPanel } from "@/components/right-panel";
import { TopBar } from "@/components/top-bar";
import { useDashboardHealth } from "@/lib/use-dashboard-health";
import { useDashboardSocket } from "@/lib/use-dashboard-socket";
import { useDashboardStore } from "@/lib/store";
import { toSymbolCode } from "@/lib/symbol-label";

const ORCHESTRATOR_URL = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ?? "http://localhost:5001";

async function postJson(path: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${ORCHESTRATOR_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (response.ok) {
    return;
  }

  let message = `request failed (${response.status})`;
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload?.error === "string" && payload.error.trim().length > 0) {
      message = payload.error;
    }
  } catch {
    // noop
  }

  throw new Error(message);
}

export default function DashboardPage() {
  useDashboardSocket();
  useDashboardHealth();

  const connected = useDashboardStore((state) => state.connected);
  const health = useDashboardStore((state) => state.health);
  const healthError = useDashboardStore((state) => state.healthError);
  const snapshot = useDashboardStore((state) => state.snapshot);
  const priceSeries = useDashboardStore((state) => state.priceSeries);
  const tickLogs = useDashboardStore((state) => state.tickLogs);
  const brainLogs = useDashboardStore((state) => state.brainLogs);
  const targetLogs = useDashboardStore((state) => state.targetLogs);
  const newsBoardFeed = useDashboardStore((state) => state.newsBoardFeed);
  const symbolNames = useDashboardStore((state) => state.symbolNames);
  const mergeSymbolNames = useDashboardStore((state) => state.mergeSymbolNames);
  const pendingSymbolsRef = useRef<Set<string>>(new Set());

  const [busy, setBusy] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);

  const handleToggleKillSwitch = useCallback(async (enabled: boolean) => {
    setBusy(true);
    setCommandError(null);
    try {
      await postJson("/api/kill-switch", { enabled });
    } catch (error) {
      const message = error instanceof Error ? error.message : "킬스위치 요청 실패";
      setCommandError(message);
    } finally {
      setBusy(false);
    }
  }, []);

  const handleManualOrder = useCallback(
    async (side: OrderSide, qty: number) => {
      setBusy(true);
      setCommandError(null);
      try {
        await postJson("/api/manual-order", {
          symbol: snapshot.targetSymbol,
          side,
          qty: Math.max(1, Math.floor(qty))
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "수동 주문 요청 실패";
        setCommandError(message);
      } finally {
        setBusy(false);
      }
    },
    [snapshot.targetSymbol]
  );

  const symbolCandidates = useMemo(() => {
    const values: string[] = [
      snapshot.targetSymbol,
      snapshot.tick.symbol,
      snapshot.fundamental.symbol,
      ...snapshot.watchPool.map((item) => item.symbol),
      ...snapshot.positions.map((position) => position.symbol),
      ...snapshot.orderLog.slice(0, 40).map((log) => log.symbol),
      ...newsBoardFeed.slice(0, 40).map((item) => item.symbol)
    ];

    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      const code = toSymbolCode(value);
      if (!/^\d{6}$/.test(code) || seen.has(code)) {
        continue;
      }
      seen.add(code);
      deduped.push(code);
    }
    return deduped;
  }, [newsBoardFeed, snapshot.fundamental.symbol, snapshot.orderLog, snapshot.positions, snapshot.targetSymbol, snapshot.tick.symbol, snapshot.watchPool]);

  useEffect(() => {
    const missing = symbolCandidates.filter((code) => !symbolNames[code] && !pendingSymbolsRef.current.has(code));
    if (missing.length === 0) {
      return;
    }

    for (const code of missing) {
      pendingSymbolsRef.current.add(code);
    }

    let cancelled = false;

    const fetchNames = async () => {
      try {
        const response = await fetch(`${ORCHESTRATOR_URL}/api/symbol-names?symbols=${missing.join(",")}`, {
          method: "GET",
          headers: {
            "Content-Type": "application/json"
          },
          cache: "no-store"
        });

        if (!response.ok) {
          return;
        }

        const payload = (await response.json()) as {
          ok?: boolean;
          items?: Array<{ symbol?: string; name?: string }>;
        };
        if (cancelled || !Array.isArray(payload.items)) {
          return;
        }

        const entries: Record<string, string> = {};
        for (const item of payload.items) {
          const code = toSymbolCode(item?.symbol);
          const name = String(item?.name ?? "").trim();
          if (!/^\d{6}$/.test(code) || !name) {
            continue;
          }
          entries[code] = name;
        }

        mergeSymbolNames(entries);
      } finally {
        for (const code of missing) {
          pendingSymbolsRef.current.delete(code);
        }
      }
    };

    void fetchNames();

    return () => {
      cancelled = true;
    };
  }, [mergeSymbolNames, symbolCandidates, symbolNames]);

  return (
    <main className="flex min-h-screen flex-col overflow-y-auto overflow-x-hidden bg-slate-950 p-2 text-slate-100">
      <TopBar
        connected={connected}
        health={health}
        healthError={healthError}
        commandError={commandError}
        snapshot={snapshot}
        busy={busy}
        newsFeed={newsBoardFeed}
        symbolNames={symbolNames}
        onToggleKillSwitch={handleToggleKillSwitch}
      />

      <section className="grid grid-cols-1 items-start gap-3 xl:grid-cols-[minmax(300px,340px)_minmax(0,1fr)_minmax(330px,390px)] 2xl:grid-cols-[360px_minmax(0,1fr)_420px]">
        <div className="min-w-0">
          <LeftPanel snapshot={snapshot} health={health} tickLogs={tickLogs} targetLogs={targetLogs} symbolNames={symbolNames} />
        </div>
        <div className="min-w-0">
          <CenterPanel snapshot={snapshot} health={health} priceSeries={priceSeries} brainLogs={brainLogs} />
        </div>
        <div className="min-w-0">
          <RightPanel snapshot={snapshot} health={health} busy={busy} onManualOrder={handleManualOrder} symbolNames={symbolNames} />
        </div>
      </section>
    </main>
  );
}
