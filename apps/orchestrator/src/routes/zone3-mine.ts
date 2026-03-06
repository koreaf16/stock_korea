import type express from "express";

import type { Zone3MinerManager } from "../zones/zone3/miner-manager.js";

export function attachZone3MineRoutes(app: express.Express, deps: { zone3MinerManager: Zone3MinerManager }): void {
  const { zone3MinerManager } = deps;

  app.get("/api/zone3/mine/status", (_req, res) => {
    res.json({
      ok: true,
      status: zone3MinerManager.getStatus()
    });
  });

  app.get("/api/zone3/mine/stats", async (_req, res) => {
    try {
      const stats = await zone3MinerManager.getStats();
      res.json({
        ok: true,
        stats
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(500).json({
        ok: false,
        error: message
      });
    }
  });

  app.post("/api/zone3/mine", async (req, res) => {
    try {
      const params = parseZone3MineParams(req.body ?? {});
      const status = await zone3MinerManager.startMining(params);
      res.status(202).json({
        ok: true,
        status
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.status(400).json({
        ok: false,
        error: message
      });
    }
  });
}

function parseZone3MineParams(raw: unknown): { startDate: string; endDate: string; symbols: string[] } {
  const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const today = new Date();
  const startDefault = new Date(today.getTime() - 1000 * 60 * 60 * 24 * 365 * 2);
  const startDate = normalizeYmd(String(body.startDate ?? ""), toYmd(startDefault));
  const endDate = normalizeYmd(String(body.endDate ?? ""), toYmd(today));

  const rawSymbols = Array.isArray(body.symbols)
    ? body.symbols
    : String(body.symbols ?? "")
        .split(",")
        .map((token) => token.trim());

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const item of rawSymbols) {
    const symbol = normalizeSymbol(String(item ?? ""));
    if (!symbol || seen.has(symbol)) {
      continue;
    }
    seen.add(symbol);
    deduped.push(symbol);
  }

  const symbols = deduped.length > 0 ? deduped.slice(0, 30) : ["005930", "000660", "035420"];
  return { startDate, endDate, symbols };
}

function normalizeYmd(raw: string, fallback: string): string {
  const token = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(token)) {
    return fallback;
  }
  return token;
}

function toYmd(date: Date): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function normalizeSymbol(raw: string): string | null {
  const digits = String(raw ?? "").trim().replace(/[^\d]/g, "");
  if (digits.length < 6) {
    return null;
  }
  return digits.slice(0, 6);
}
