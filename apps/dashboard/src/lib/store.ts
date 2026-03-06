"use client";

import { createEmptyDashboardSnapshot, type DashboardSnapshot } from "@stock/contracts";
import { create } from "zustand";

import { formatKrw, formatTs } from "./format";
import { decisionActionKo, narrativeKo } from "./korean";
import type { OrchestratorHealth } from "./orchestrator-health";

const MAX_PRICE_POINTS = 150;
const MAX_TICK_LOGS = 36;
const MAX_BRAIN_LOGS = 24;

export interface UiLogLine {
  id: string;
  text: string;
}

interface DashboardStore {
  connected: boolean;
  health: OrchestratorHealth | null;
  healthError: string | null;
  snapshot: DashboardSnapshot;
  priceSeries: number[];
  tickLogs: UiLogLine[];
  brainLogs: UiLogLine[];
  setConnected: (connected: boolean) => void;
  setHealth: (health: OrchestratorHealth) => void;
  setHealthError: (error: string | null) => void;
  setSnapshot: (snapshot: DashboardSnapshot) => void;
}

export const useDashboardStore = create<DashboardStore>((set) => ({
  connected: false,
  health: null,
  healthError: null,
  snapshot: createEmptyDashboardSnapshot(),
  priceSeries: [],
  tickLogs: [],
  brainLogs: [],
  setConnected: (connected) => {
    set({ connected });
  },
  setHealth: (health) => {
    set({ health });
  },
  setHealthError: (healthError) => {
    set({ healthError });
  },
  setSnapshot: (snapshot) => {
    set((state) => {
      // 동일 payload의 반복 렌더링을 피한다.
      if (state.snapshot.lastUpdatedAt === snapshot.lastUpdatedAt) {
        return state;
      }

      const tickLine = `[${formatTs(snapshot.tick.timestamp)}] ${snapshot.tick.symbol} ${formatKrw(snapshot.tick.price)}원 거래량:${formatKrw(snapshot.tick.volume)}`;
      const brainLine = `[${formatTs(snapshot.decision.generatedAt)}] [존5_${decisionActionKo(snapshot.decision.action)}] ${narrativeKo(
        snapshot.decision.reasoning
      )}`;
      const tickId = `${snapshot.tick.timestamp}:${snapshot.tick.symbol}:${snapshot.tick.price}:${snapshot.tick.volume}`;
      const brainId = `${snapshot.decision.generatedAt}:${snapshot.decision.decisionId}:${snapshot.decision.action}`;

      return {
        snapshot,
        priceSeries: [...state.priceSeries, snapshot.tick.price].slice(-MAX_PRICE_POINTS),
        tickLogs: [{ id: tickId, text: tickLine }, ...state.tickLogs].slice(0, MAX_TICK_LOGS),
        brainLogs: [{ id: brainId, text: brainLine }, ...state.brainLogs].slice(0, MAX_BRAIN_LOGS)
      };
    });
  }
}));
