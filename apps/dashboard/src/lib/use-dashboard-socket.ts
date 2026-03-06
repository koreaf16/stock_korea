"use client";

import type { DashboardUpdateEvent, Zone3MiningSocketEvent } from "@stock/contracts";
import { SOCKET_EVENTS } from "@stock/contracts";
import { useEffect } from "react";
import { io } from "socket.io-client";

import { useDashboardStore, type Zone0RawFrame } from "./store";

const ORCHESTRATOR_URL = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ?? "http://localhost:5001";
const DASHBOARD_MAX_FPS = Math.min(60, Math.max(1, Number(process.env.NEXT_PUBLIC_DASHBOARD_MAX_FPS ?? 30)));
const SNAPSHOT_FLUSH_MS = Math.max(16, Math.round(1000 / DASHBOARD_MAX_FPS));

export function useDashboardSocket(): void {
  const setConnected = useDashboardStore((state) => state.setConnected);
  const setSnapshot = useDashboardStore((state) => state.setSnapshot);
  const setZone0RawFrame = useDashboardStore((state) => state.setZone0RawFrame);
  const setZone3MiningEvent = useDashboardStore((state) => state.setZone3MiningEvent);

  useEffect(() => {
    let pendingSnapshot: DashboardUpdateEvent["payload"] | null = null;
    let pendingZone0Raw: Zone0RawFrame | null = null;
    let rafId: number | null = null;
    let lastFlushAt = 0;

    const flush = (force = false) => {
      const now = performance.now();
      if (!force && now - lastFlushAt < SNAPSHOT_FLUSH_MS) {
        return false;
      }
      lastFlushAt = now;

      if (!pendingSnapshot) {
        if (pendingZone0Raw) {
          setZone0RawFrame(pendingZone0Raw);
          pendingZone0Raw = null;
        }
      } else {
        setSnapshot(pendingSnapshot);
        pendingSnapshot = null;
      }

      if (pendingZone0Raw) {
        setZone0RawFrame(pendingZone0Raw);
        pendingZone0Raw = null;
      }
      return true;
    };

    const scheduleFlush = () => {
      if (rafId !== null) {
        return;
      }

      const tick = () => {
        rafId = null;
        if (flush()) {
          return;
        }
        if (pendingSnapshot || pendingZone0Raw) {
          scheduleFlush();
        }
      };

      rafId = requestAnimationFrame(tick);
    };

    const socket = io(ORCHESTRATOR_URL, {
      transports: ["websocket"]
    });

    socket.on("connect", () => {
      setConnected(true);
    });

    socket.on("disconnect", () => {
      setConnected(false);
    });

    socket.on("connect_error", () => {
      setConnected(false);
    });

    socket.on(SOCKET_EVENTS.INIT, (event: DashboardUpdateEvent) => {
      if (event?.payload) {
        pendingSnapshot = event.payload;
        flush(true);
      }
    });

    socket.on(SOCKET_EVENTS.UPDATE, (event: DashboardUpdateEvent) => {
      if (event?.payload) {
        pendingSnapshot = event.payload;
        scheduleFlush();
      }
    });

    socket.on(SOCKET_EVENTS.ZONE0_RAW, (frame: Zone0RawFrame) => {
      if (frame?.tick && frame?.orderBook) {
        pendingZone0Raw = frame;
        scheduleFlush();
      }
    });

    socket.on(SOCKET_EVENTS.ZONE3_MINING, (event: Zone3MiningSocketEvent) => {
      if (event?.type) {
        setZone3MiningEvent(event);
      }
    });

    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      pendingSnapshot = null;
      pendingZone0Raw = null;
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [setConnected, setSnapshot, setZone0RawFrame, setZone3MiningEvent]);
}
