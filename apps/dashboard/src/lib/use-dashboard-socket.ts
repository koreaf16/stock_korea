"use client";

import type { DashboardUpdateEvent } from "@stock/contracts";
import { SOCKET_EVENTS } from "@stock/contracts";
import { useEffect } from "react";
import { io } from "socket.io-client";

import { useDashboardStore, type Zone0RawFrame } from "./store";

const ORCHESTRATOR_URL = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ?? "http://localhost:5001";
const DASHBOARD_MAX_FPS = Math.max(8, Number(process.env.NEXT_PUBLIC_DASHBOARD_MAX_FPS ?? 12));
const SNAPSHOT_FLUSH_MS = Math.max(120, Math.round(1000 / DASHBOARD_MAX_FPS));

export function useDashboardSocket(): void {
  const setConnected = useDashboardStore((state) => state.setConnected);
  const setSnapshot = useDashboardStore((state) => state.setSnapshot);
  const setZone0RawFrame = useDashboardStore((state) => state.setZone0RawFrame);

  useEffect(() => {
    let pendingSnapshot: DashboardUpdateEvent["payload"] | null = null;
    let pendingZone0Raw: Zone0RawFrame | null = null;
    let flushTimeout: ReturnType<typeof setTimeout> | null = null;
    let lastFlushAt = 0;

    const flush = () => {
      if (flushTimeout) {
        clearTimeout(flushTimeout);
        flushTimeout = null;
      }
      lastFlushAt = Date.now();

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
    };

    const scheduleFlush = () => {
      const now = Date.now();
      const wait = SNAPSHOT_FLUSH_MS - (now - lastFlushAt);
      if (wait <= 0) {
        flush();
        return;
      }
      if (!flushTimeout) {
        flushTimeout = setTimeout(flush, wait);
      }
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
        flush();
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

    return () => {
      if (flushTimeout) {
        clearTimeout(flushTimeout);
        flushTimeout = null;
      }
      pendingSnapshot = null;
      pendingZone0Raw = null;
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [setConnected, setSnapshot, setZone0RawFrame]);
}
