"use client";

import { useEffect } from "react";

import { fetchOrchestratorHealth } from "./orchestrator-health";
import { useDashboardStore } from "./store";

const HEALTH_POLL_MS = 3_000;

export function useDashboardHealth(): void {
  const setHealth = useDashboardStore((state) => state.setHealth);
  const setHealthError = useDashboardStore((state) => state.setHealthError);

  useEffect(() => {
    let alive = true;
    let pending: AbortController | null = null;

    const run = async () => {
      pending?.abort();
      const controller = new AbortController();
      pending = controller;

      try {
        const health = await fetchOrchestratorHealth(controller.signal);
        if (!alive) {
          return;
        }
        setHealth(health);
        setHealthError(null);
      } catch (error) {
        if (!alive) {
          return;
        }
        const message = error instanceof Error ? error.message : "health poll failed";
        setHealthError(message);
      }
    };

    run();
    const timer = setInterval(run, HEALTH_POLL_MS);

    return () => {
      alive = false;
      pending?.abort();
      clearInterval(timer);
    };
  }, [setHealth, setHealthError]);
}
