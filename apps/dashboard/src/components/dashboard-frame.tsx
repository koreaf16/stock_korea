"use client";

import { useCallback, useMemo, useState } from "react";

import { useDashboardHealth } from "@/lib/use-dashboard-health";
import { useDashboardSocket } from "@/lib/use-dashboard-socket";
import { useDashboardStore } from "@/lib/store";

import { TopBar } from "./top-bar";

const ORCHESTRATOR_URL = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ?? "http://localhost:5001";

async function postJson(path: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${ORCHESTRATOR_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (response.ok) {
    return;
  }
  throw new Error("Command failed");
}

export function DashboardFrame({ children }: { children: React.ReactNode }) {
  useDashboardSocket();
  useDashboardHealth();

  const connected = useDashboardStore((state) => state.connected);
  const health = useDashboardStore((state) => state.health);
  const healthError = useDashboardStore((state) => state.healthError);
  const snapshot = useDashboardStore((state) => state.snapshot);
  const newsBoardFeed = useDashboardStore((state) => state.newsBoardFeed);
  const symbolNames = useDashboardStore((state) => state.symbolNames);

  const [busy, setBusy] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);

  const handleToggleKillSwitch = useCallback(async (enabled: boolean) => {
    setBusy(true);
    setCommandError(null);
    try {
      await postJson("/api/kill-switch", { enabled });
    } catch {
      setCommandError("킬스위치 실패");
    } finally {
      setBusy(false);
    }
  }, []);

  const emergencyAlerts = useMemo(() => {
    const alerts: string[] = [];
    if (!connected) alerts.push("SYS_OFFLINE");
    if (snapshot.killSwitchOn) alerts.push("KILL_SWITCH_ACTIVE");
    if (snapshot.technical.spikeRatio >= 300) alerts.push(`VOLUME_SPIKE_${snapshot.technical.spikeRatio.toFixed(0)}%`);
    return alerts;
  }, [connected, snapshot.killSwitchOn, snapshot.technical.spikeRatio]);

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-black p-2 text-zinc-300 font-sans selection:bg-cyan-900">
      <TopBar
        connected={connected}
        health={health}
        healthError={healthError}
        commandError={commandError}
        snapshot={snapshot}
        busy={busy}
        newsFeed={newsBoardFeed}
        symbolNames={symbolNames}
        emergencyAlerts={emergencyAlerts}
        onToggleKillSwitch={handleToggleKillSwitch}
      />

      <section className="mt-2 flex flex-1 gap-4 overflow-hidden">{children}</section>
    </main>
  );
}
