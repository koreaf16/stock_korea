"use client";

import type { OrderSide } from "@stock/contracts";
import { useState } from "react";

import { CenterPanel } from "@/components/center-panel";
import { LeftPanel } from "@/components/left-panel";
import { RightPanel } from "@/components/right-panel";
import { TopBar } from "@/components/top-bar";
import { ZoneManagementMenu } from "@/components/zone-management-menu";
import { sendManualOrder, toggleKillSwitch } from "@/lib/commands";
import { useDashboardStore } from "@/lib/store";
import { useDashboardHealth } from "@/lib/use-dashboard-health";
import { useDashboardSocket } from "@/lib/use-dashboard-socket";

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

  const handleKillSwitch = async (enabled: boolean) => {
    try {
      setBusy(true);
      await toggleKillSwitch(enabled);
      setCommandError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "킬스위치 요청 실패";
      setCommandError(message);
    } finally {
      setBusy(false);
    }
  };

  const handleManualOrder = async (side: OrderSide, qty: number) => {
    try {
      setBusy(true);
      await sendManualOrder({
        symbol: snapshot.targetSymbol,
        side,
        qty
      });
      setCommandError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "수동 주문 요청 실패";
      setCommandError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="min-h-screen w-full px-3 py-3 sm:px-4">
      <TopBar
        connected={connected}
        health={health}
        healthError={healthError}
        commandError={commandError}
        snapshot={snapshot}
        busy={busy}
        onToggleKillSwitch={handleKillSwitch}
      />

      <ZoneManagementMenu health={health} />

      <section className="grid min-h-[calc(100vh-120px)] grid-cols-1 gap-3 xl:grid-cols-[340px_minmax(620px,1fr)_390px]">
        <LeftPanel snapshot={snapshot} health={health} tickLogs={tickLogs} />
        <CenterPanel snapshot={snapshot} health={health} priceSeries={priceSeries} brainLogs={brainLogs} />
        <RightPanel snapshot={snapshot} health={health} busy={busy} onManualOrder={handleManualOrder} />
      </section>
    </main>
  );
}
