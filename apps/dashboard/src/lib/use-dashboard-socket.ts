"use client";

import type { DashboardUpdateEvent } from "@stock/contracts";
import { SOCKET_EVENTS } from "@stock/contracts";
import { useEffect } from "react";
import { io } from "socket.io-client";

import { useDashboardStore, type Zone0RawFrame } from "./store";

const ORCHESTRATOR_URL = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ?? "http://localhost:5001";
const DASHBOARD_MAX_FPS = Math.max(1, Number(process.env.NEXT_PUBLIC_DASHBOARD_MAX_FPS ?? 5));
const SNAPSHOT_FLUSH_MS = Math.max(120, Math.round(1000 / DASHBOARD_MAX_FPS));

export function useDashboardSocket(): void {
  const setConnected = useDashboardStore((state) => state.setConnected);
  const setSnapshot = useDashboardStore((state) => state.setSnapshot);
  const setZone0RawFrame = useDashboardStore((state) => state.setZone0RawFrame);

  useEffect(() => {
    let pendingSnapshot: DashboardUpdateEvent["payload"] | null = null;
    let pendingZone0Raw: Zone0RawFrame | null = null;

    const flush = () => {
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

    const socket = io(ORCHESTRATOR_URL, {
      transports: ["websocket"]
    });
    const flushTimer = setInterval(flush, SNAPSHOT_FLUSH_MS);

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
      }
    });

    socket.on(SOCKET_EVENTS.ZONE0_RAW, (frame: Zone0RawFrame) => {
      if (frame?.tick && frame?.orderBook) {
        pendingZone0Raw = frame;
      }
    });

    return () => {
      clearInterval(flushTimer);
      pendingSnapshot = null;
      pendingZone0Raw = null;
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [setConnected, setSnapshot, setZone0RawFrame]);
}
