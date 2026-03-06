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

  app.post("/api/zone3/mine", async (_req, res) => {
    try {
      const status = await zone3MinerManager.startMining();
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
