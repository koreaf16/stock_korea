"use client";

import type { OrderSide } from "@stock/contracts";
import { useCallback, useState } from "react";

import { CenterPanel } from "@/components/center-panel";
import { LeftPanel } from "@/components/left-panel";
import { RightPanel } from "@/components/right-panel";
import { TopBar } from "@/components/top-bar";
import { ZoneManagementMenu } from "@/components/zone-management-menu";
import { useDashboardHealth } from "@/lib/use-dashboard-health";
import { useDashboardSocket } from "@/lib/use-dashboard-socket";
import { useDashboardStore } from "@/lib/store";

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

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-slate-950 p-2 text-slate-100">
      <TopBar
        connected={connected}
        health={health}
        healthError={healthError}
        commandError={commandError}
        snapshot={snapshot}
        busy={busy}
        onToggleKillSwitch={handleToggleKillSwitch}
      />

      <ZoneManagementMenu health={health} />

      <section className="grid min-h-0 flex-1 grid-cols-1 gap-3 xl:grid-cols-[360px_minmax(0,1fr)_420px]">
        <LeftPanel snapshot={snapshot} health={health} tickLogs={tickLogs} />
        <CenterPanel snapshot={snapshot} health={health} priceSeries={priceSeries} brainLogs={brainLogs} />
        <RightPanel snapshot={snapshot} health={health} busy={busy} onManualOrder={handleManualOrder} />
      </section>
    </main>
  );
}
