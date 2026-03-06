"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CenterPanel } from "@/components/center-panel";
import { RightPanel } from "@/components/right-panel";
import { TopBar } from "@/components/top-bar";
import { useDashboardHealth } from "@/lib/use-dashboard-health";
import { useDashboardSocket } from "@/lib/use-dashboard-socket";
import { useDashboardStore } from "@/lib/store";
import { toSymbolCode } from "@/lib/symbol-label";

const ORCHESTRATOR_URL = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ?? "http://localhost:5001";

async function postJson(path: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${ORCHESTRATOR_URL}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
  });
  if (response.ok) return;
  throw new Error("Command failed");
}

export default function DashboardPage() {
  useDashboardSocket();
  useDashboardHealth();

  const connected = useDashboardStore((state) => state.connected);
  const health = useDashboardStore((state) => state.health);
  const healthError = useDashboardStore((state) => state.healthError);
  const snapshot = useDashboardStore((state) => state.snapshot);
  const priceSeries = useDashboardStore((state) => state.priceSeries);
  const newsBoardFeed = useDashboardStore((state) => state.newsBoardFeed);
  const symbolNames = useDashboardStore((state) => state.symbolNames);
  const mergeSymbolNames = useDashboardStore((state) => state.mergeSymbolNames);
  const pendingSymbolsRef = useRef<Set<string>>(new Set());

  const [busy, setBusy] = useState(false);
  const [commandError, setCommandError] = useState<string | null>(null);

  const handleToggleKillSwitch = useCallback(async (enabled: boolean) => {
    setBusy(true); setCommandError(null);
    try { await postJson("/api/kill-switch", { enabled }); } 
    catch (error) { setCommandError("킬스위치 실패"); } 
    finally { setBusy(false); }
  }, []);

  const symbolCandidates = useMemo(() => {
    const values: string[] = [
      snapshot.targetSymbol, snapshot.tick.symbol, snapshot.fundamental.symbol,
      ...snapshot.watchPool.map((item) => item.symbol),
      ...snapshot.positions.map((position) => position.symbol)
    ];
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const value of values) {
      const code = toSymbolCode(value);
      if (!/^\d{6}$/.test(code) || seen.has(code)) continue;
      seen.add(code); deduped.push(code);
    }
    return deduped;
  }, [snapshot.fundamental.symbol, snapshot.positions, snapshot.targetSymbol, snapshot.tick.symbol, snapshot.watchPool]);

  const emergencyAlerts = useMemo(() => {
    const alerts: string[] = [];
    if (!connected) alerts.push("SYS_OFFLINE");
    if (snapshot.killSwitchOn) alerts.push("KILL_SWITCH_ACTIVE");
    if (snapshot.technical.spikeRatio >= 300) alerts.push(`VOLUME_SPIKE_${snapshot.technical.spikeRatio.toFixed(0)}%`);
    return alerts;
  }, [connected, snapshot.killSwitchOn, snapshot.technical.spikeRatio]);

  useEffect(() => {
    const missing = symbolCandidates.filter((code) => !symbolNames[code] && !pendingSymbolsRef.current.has(code));
    if (missing.length === 0) return;
    for (const code of missing) pendingSymbolsRef.current.add(code);
    
    let cancelled = false;
    const fetchNames = async () => {
      try {
        const response = await fetch(`${ORCHESTRATOR_URL}/api/symbol-names?symbols=${missing.join(",")}`, { method: "GET" });
        if (!response.ok) return;
        const payload = (await response.json()) as { items?: Array<{ symbol?: string; name?: string }> };
        if (cancelled || !Array.isArray(payload.items)) return;
        
        const entries: Record<string, string> = {};
        for (const item of payload.items) {
          const code = toSymbolCode(item?.symbol);
          const name = String(item?.name ?? "").trim();
          if (/^\d{6}$/.test(code) && name) entries[code] = name;
        }
        mergeSymbolNames(entries);
      } finally {
        for (const code of missing) pendingSymbolsRef.current.delete(code);
      }
    };
    void fetchNames();
    return () => { cancelled = true; };
  }, [mergeSymbolNames, symbolCandidates, symbolNames]);

  return (
    <main className="flex h-screen flex-col overflow-hidden bg-black p-2 text-zinc-300 font-sans selection:bg-cyan-900">
      <TopBar
        connected={connected} health={health} healthError={healthError}
        commandError={commandError} snapshot={snapshot} busy={busy}
        newsFeed={newsBoardFeed} symbolNames={symbolNames}
        emergencyAlerts={emergencyAlerts} onToggleKillSwitch={handleToggleKillSwitch}
      />

      <section className="mt-2 flex flex-1 gap-4 overflow-hidden">
        {/* Left: Minimalist Chart */}
        <div className="relative flex-[3] min-w-0 border border-zinc-800/50 bg-black overflow-hidden">
          <CenterPanel snapshot={snapshot} health={health} priceSeries={priceSeries} symbolNames={symbolNames} />
        </div>

        {/* Right: Tactical Control (No Manual Orders) */}
        <div className="flex-[1] min-w-[360px] max-w-[420px] overflow-y-auto pr-1">
          <RightPanel 
            snapshot={snapshot} 
            health={health} 
            symbolNames={symbolNames}
            newsFeed={newsBoardFeed}
          />
        </div>
      </section>
    </main>
  );
}