import http from "node:http";

import type { ManualOrderCommand } from "@stock/contracts";
import { SOCKET_EVENTS } from "@stock/contracts";
import cors from "cors";
import express from "express";
import { Server } from "socket.io";

import { applyKillSwitch, applyManualOrder, initRuntime, stepRuntime } from "./pipeline.js";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

let runtime = initRuntime();
const port = Number(process.env.ORCHESTRATOR_PORT ?? 5001);
const tickIntervalMs = Number(process.env.TICK_INTERVAL_MS ?? 1_000);
let stepping = false;

app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => {
  const zone0Buffer = runtime.zone0.getBufferSnapshot();
  const zone1State = runtime.zone1.getStateSnapshot();
  const zone2State = runtime.zone2.getStateSnapshot();
  const zone3State = runtime.zone3.getStateSnapshot();
  const zone4State = runtime.zone4.getStateSnapshot();
  const zone5State = runtime.zone5.getStateSnapshot();
  const zone6State = runtime.zone6.getStateSnapshot();
  res.json({
    ok: true,
    tickCount: runtime.tickCount,
    zone0: {
      ticksBuffered: zone0Buffer.ticks.length,
      newsBuffered: zone0Buffer.newsItems.length,
      boardBuffered: zone0Buffer.boardPosts.length,
      telegramBuffered: zone0Buffer.telegramMessages.length,
      lastFrameAt: zone0Buffer.lastFrameAt
    },
    zone1: {
      sessionDate: zone1State.sessionDate,
      high: zone1State.high,
      low: zone1State.low,
      ma3: zone1State.ma3,
      ma5: zone1State.ma5
    },
    zone2: {
      provider: zone2State.provider,
      source: zone2State.source,
      cacheSize: zone2State.cacheSize,
      lastCheckedAt: zone2State.lastCheckedAt
    },
    zone3: {
      provider: zone3State.provider,
      source: zone3State.source,
      candleCount: zone3State.candleCount,
      vectorDim: zone3State.vectorDim,
      lastClass: zone3State.lastClass,
      lastSimilarity: zone3State.lastSimilarity
    },
    zone4: {
      provider: zone4State.provider,
      source: zone4State.source,
      signalRate1m: zone4State.signalRate1m,
      lastScore: zone4State.lastScore,
      lastStage: zone4State.lastStage
    },
    zone5: {
      provider: zone5State.provider,
      source: zone5State.source,
      llmModel: zone5State.llmModel,
      lastDecisionId: zone5State.lastDecisionId,
      lastAction: zone5State.lastAction,
      lastConfidence: zone5State.lastConfidence,
      lastError: zone5State.lastError
    },
    zone6: {
      provider: zone6State.provider,
      source: zone6State.source,
      recordCount: zone6State.recordCount,
      lastSimilarTradeId: zone6State.lastSimilarTradeId,
      lastWinRate: zone6State.lastWinRate,
      lastIngestedTradeId: zone6State.lastIngestedTradeId,
      lastIngestedPnlPct: zone6State.lastIngestedPnlPct,
      lastError: zone6State.lastError
    },
    now: new Date().toISOString()
  });
});

app.get("/api/snapshot", (_req, res) => {
  res.json(runtime.snapshot);
});

app.get("/api/zone0/buffer", (_req, res) => {
  res.json(runtime.zone0.getBufferSnapshot());
});

app.get("/api/zone1/state", (_req, res) => {
  res.json(runtime.zone1.getStateSnapshot());
});

app.get("/api/zone2/state", (_req, res) => {
  res.json(runtime.zone2.getStateSnapshot());
});

app.get("/api/zone3/state", (_req, res) => {
  res.json(runtime.zone3.getStateSnapshot());
});

app.get("/api/zone4/state", (_req, res) => {
  res.json(runtime.zone4.getStateSnapshot());
});

app.get("/api/zone5/state", (_req, res) => {
  res.json(runtime.zone5.getStateSnapshot());
});

app.get("/api/zone6/state", (_req, res) => {
  res.json(runtime.zone6.getStateSnapshot());
});

app.post("/api/kill-switch", (req, res) => {
  const enabled = Boolean(req.body?.enabled);
  runtime = applyKillSwitch(runtime, enabled);
  broadcastSnapshot();
  res.json({
    ok: true,
    enabled
  });
});

app.post("/api/manual-order", (req, res) => {
  const body = req.body as Partial<ManualOrderCommand>;
  if (!body.symbol || !body.side || !body.qty) {
    res.status(400).json({
      ok: false,
      error: "symbol, side, qty are required"
    });
    return;
  }

  runtime = applyManualOrder(runtime, {
    symbol: body.symbol,
    side: body.side,
    qty: body.qty
  });
  broadcastSnapshot();

  res.json({
    ok: true
  });
});

io.on("connection", (socket) => {
  socket.emit(SOCKET_EVENTS.INIT, {
    type: "SNAPSHOT",
    payload: runtime.snapshot
  });

  socket.on(SOCKET_EVENTS.COMMAND_KILL_SWITCH, (payload: { enabled: boolean }) => {
    runtime = applyKillSwitch(runtime, Boolean(payload?.enabled));
    broadcastSnapshot();
  });

  socket.on(SOCKET_EVENTS.COMMAND_MANUAL_ORDER, (command: ManualOrderCommand) => {
    if (!command?.symbol || !command.side || !command.qty) {
      return;
    }

    runtime = applyManualOrder(runtime, command);
    broadcastSnapshot();
  });
});

function broadcastSnapshot(): void {
  io.emit(SOCKET_EVENTS.UPDATE, {
    type: "SNAPSHOT",
    payload: runtime.snapshot
  });
}

setInterval(async () => {
  if (stepping) {
    return;
  }
  stepping = true;
  const baseRuntime = runtime;
  try {
    const nextRuntime = await stepRuntime(baseRuntime);
    if (runtime !== baseRuntime) {
      return;
    }
    runtime = nextRuntime;
    broadcastSnapshot();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[orchestrator] tick failed: ${message}`);
  } finally {
    stepping = false;
  }
}, tickIntervalMs);

server.listen(port, () => {
  console.log(`[orchestrator] listening on http://localhost:${port}`);
});
