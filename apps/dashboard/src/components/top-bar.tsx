"use client";

import Link from "next/link";
import type { DashboardSnapshot } from "@stock/contracts";
import { formatKrw } from "@/lib/format";
import type { OrchestratorHealth } from "@/lib/orchestrator-health";

interface TopBarProps {
  connected: boolean;
  health: OrchestratorHealth | null;
  snapshot: DashboardSnapshot;
  busy: boolean;
  onToggleKillSwitch: (enabled: boolean) => Promise<void>;
  emergencyAlerts?: string[];
}

export function TopBar({ connected, health, snapshot, busy, onToggleKillSwitch, emergencyAlerts = [] }: TopBarProps) {
  // 3-Dots Status Calculation
  const kisOk = connected && (health?.zone0?.ticksBuffered ?? 0) >= 0;
  const dbOk = connected; // DB is assumed OK if orchestrator sends socket
  const llmOk = !health?.zone5?.lastError;

  const StatusDot = ({ ok, label }: { ok: boolean; label: string }) => (
    <div className="flex items-center gap-1.5">
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? "bg-cyan-500 shadow-[0_0_5px_rgba(6,182,212,0.8)]" : "bg-rose-500 animate-pulse"}`} />
      <span className={`text-[9px] tracking-[0.2em] ${ok ? "text-zinc-400" : "text-rose-500"}`}>{label}</span>
    </div>
  );

  return (
    <div className="flex h-10 shrink-0 items-center justify-between border-b border-zinc-800/80 bg-black px-4 font-mono">
      {/* LEFT: System Core Status & Zone Nav */}
      <div className="flex items-center gap-4">
        <span className="text-[10px] tracking-[0.3em] text-zinc-600 font-bold hidden sm:inline">SYS_CORE</span>
        <div className="flex items-center gap-3">
          <StatusDot ok={kisOk} label="KIS" />
          <StatusDot ok={dbOk} label="ORA" />
          <StatusDot ok={llmOk} label="LLM" />
        </div>

        {/* ZONE NAVIGATION BUTTONS */}
        <div className="ml-2 flex items-center gap-1 border-l border-zinc-800/80 pl-4">
          {[0, 1, 2, 3, 4, 5, 6].map((z) => (
            <Link
              key={z}
              href={`/zone/${z}`}
              className="rounded border border-transparent px-1.5 py-0.5 text-[9px] font-bold text-zinc-500 transition-all hover:border-zinc-700 hover:bg-zinc-900 hover:text-cyan-400"
            >
              Z{z}
            </Link>
          ))}
        </div>

        {emergencyAlerts.length > 0 && (
          <span className="ml-4 text-[9px] font-bold text-rose-500 animate-pulse tracking-widest hidden md:inline">
            ! WARN: {emergencyAlerts[0]}
          </span>
        )}
      </div>

      {/* RIGHT: Portfolio & Master Kill Switch */}
      <div className="flex items-center gap-5">
        <div className="flex items-center gap-3 text-[10px] tracking-wider hidden sm:flex">
          <span className="text-zinc-600">
            ASSET: <span className="text-zinc-200 font-bold">{formatKrw(snapshot.account.totalAsset)}</span>
          </span>
          <span className="text-zinc-600">
            PNL: <span className={`font-bold ${snapshot.account.realizedPnl >= 0 ? "text-cyan-400" : "text-rose-500"}`}>
              {formatKrw(snapshot.account.realizedPnl)}
            </span>
          </span>
        </div>

        <button
          onClick={() => onToggleKillSwitch(!snapshot.killSwitchOn)}
          disabled={busy}
          className={`flex h-6 items-center justify-center px-4 text-[9px] font-bold tracking-[0.2em] transition-colors ${
            snapshot.killSwitchOn 
              ? "bg-rose-600 text-white animate-pulse" 
              : "border border-rose-900/50 text-rose-500 hover:bg-rose-950/30"
          }`}
        >
          {snapshot.killSwitchOn ? "SYS_HALTED" : "KILL_SWITCH"}
        </button>
      </div>
    </div>
  );
}