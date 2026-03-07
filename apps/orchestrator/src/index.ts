import http from "node:http";

import type { ManualOrderCommand } from "@stock/contracts";
import { SOCKET_EVENTS } from "@stock/contracts";
import cors from "cors";
import express, { type Request, type Response } from "express";
import { Server } from "socket.io";

import { createOraclePersistence } from "./db/oracle-persistence.js";
import { applyKillSwitch, applyManualOrder, initRuntime, stepRuntime } from "./pipeline.js";
import { attachZone3MineRoutes } from "./routes/zone3-mine.js";
import { resolveSymbolNames } from "./symbol-name-resolver.js";
import type { RuntimeState } from "./state/store.js";
import { createTelegramChannelManager } from "./zones/zone0/telegram-manager.js";
import { createZone3MinerManager } from "./zones/zone3/miner-manager.js";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

let runtime = initRuntime();
const telegramChannelManager = createTelegramChannelManager();
const oraclePersistence = createOraclePersistence();
const zone3MinerManager = createZone3MinerManager((event) => {
  io.emit(SOCKET_EVENTS.ZONE3_MINING, event);
});
const port = Number(process.env.ORCHESTRATOR_PORT ?? 5001);
const LLM_HEARTBEAT_MS = Math.max(3_000, Number(process.env.ZONE5_LLM_HEARTBEAT_MS ?? 10_000));
const HEARTBEAT_TIMEOUT_MS = Math.max(500, Number(process.env.NETWORK_HEARTBEAT_TIMEOUT_MS ?? 1_500));
let stepping = false;
let rerunRequested = false;
let llmConnected = false;
let llmHeartbeatAt: string | null = null;
let llmHeartbeatTimer: NodeJS.Timeout | null = null;

app.use(cors());
app.use(express.text({ type: "text/plain" }));
app.use(
  express.json({
    type: ["application/json", "application/*+json"]
  })
);
app.use(express.urlencoded({ extended: true }));

app.get("/health", (_req, res) => {
  runtime = withNetworkHeartbeat(runtime);
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
      dartBuffered: zone0Buffer.dartDisclosures.length,
      fundamentalBuffered: zone0Buffer.fundamentalData.length,
      macroBuffered: zone0Buffer.globalContexts.length,
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
    network: runtime.snapshot.network,
    llmHeartbeatAt,
    now: new Date().toISOString()
  });
});

app.get("/api/snapshot", (_req, res) => {
  res.json(runtime.snapshot);
});

app.get("/api/symbol-names", async (req, res) => {
  try {
    const symbols = parseSymbolsQuery(req.query?.symbols);
    if (symbols.length === 0) {
      res.json({
        ok: true,
        items: []
      });
      return;
    }

    const namesBySymbol = await resolveSymbolNames(symbols);
    res.json({
      ok: true,
      items: symbols.map((symbol) => ({
        symbol,
        name: namesBySymbol[symbol] ?? symbol
      }))
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      ok: false,
      error: message
    });
  }
});

app.get("/api/zone0/buffer", (_req, res) => {
  res.json(runtime.zone0.getBufferSnapshot());
});

app.get("/api/zone0/config", (_req, res) => {
  try {
    const config = runtime.zone0.getConfig();
    res.json({
      ok: true,
      keywords: config.keywords,
      boardPollMs: config.boardPollMs
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      ok: false,
      error: message
    });
  }
});

app.put("/api/zone0/config", (req, res) => {
  try {
    const { keywords, boardPollMs } = parseZone0ConfigPayload(req.body);
    const nextConfig = runtime.zone0.updateConfig(keywords, boardPollMs);
    res.json({
      ok: true,
      keywords: nextConfig.keywords,
      boardPollMs: nextConfig.boardPollMs
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({
      ok: false,
      error: message
    });
  }
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
attachZone3MineRoutes(app, { zone3MinerManager });

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

app.post("/api/zone0/telegram-webhook", handleTelegramWebhook);
app.post("/api/zone0/webhook/telegram", handleTelegramWebhook);

app.get("/api/zone0/telegram-channels", async (_req, res) => {
  try {
    const channels = await telegramChannelManager.listChannels();
    res.json({
      ok: true,
      provider: telegramChannelManager.provider,
      items: channels
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      ok: false,
      error: message
    });
  }
});

app.get("/api/zone0/telegram-channels/active", async (_req, res) => {
  try {
    const usernames = await telegramChannelManager.listActiveUsernames();
    res.json(usernames);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      ok: false,
      error: message
    });
  }
});

app.post("/api/zone0/telegram-channels", async (req, res) => {
  try {
    const channel = await telegramChannelManager.createChannel({
      channelUsername: String(req.body?.channelUsername ?? ""),
      channelName: String(req.body?.channelName ?? ""),
      isActive: req.body?.isActive === undefined ? true : Boolean(req.body.isActive)
    });
    res.status(201).json({
      ok: true,
      item: channel
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({
      ok: false,
      error: message
    });
  }
});

app.put("/api/zone0/telegram-channels/:id", async (req, res) => {
  try {
    const id = String(req.params.id ?? "").trim();
    if (!id) {
      res.status(400).json({
        ok: false,
        error: "id가 필요합니다."
      });
      return;
    }

    const next = await telegramChannelManager.updateChannel(id, {
      channelUsername: req.body?.channelUsername === undefined ? undefined : String(req.body.channelUsername),
      channelName: req.body?.channelName === undefined ? undefined : String(req.body.channelName),
      isActive: req.body?.isActive === undefined ? undefined : Boolean(req.body.isActive)
    });

    if (!next) {
      res.status(404).json({
        ok: false,
        error: "채널을 찾을 수 없습니다."
      });
      return;
    }

    res.json({
      ok: true,
      item: next
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(400).json({
      ok: false,
      error: message
    });
  }
});

app.delete("/api/zone0/telegram-channels/:id", async (req, res) => {
  try {
    const id = String(req.params.id ?? "").trim();
    if (!id) {
      res.status(400).json({
        ok: false,
        error: "id가 필요합니다."
      });
      return;
    }

    const deleted = await telegramChannelManager.deleteChannel(id);
    if (!deleted) {
      res.status(404).json({
        ok: false,
        error: "채널을 찾을 수 없습니다."
      });
      return;
    }

    res.json({
      ok: true
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      ok: false,
      error: message
    });
  }
});

io.on("connection", (socket) => {
  runtime = withNetworkHeartbeat(runtime);
  socket.emit(SOCKET_EVENTS.INIT, {
    type: "SNAPSHOT",
    payload: runtime.snapshot
  });
  socket.emit(SOCKET_EVENTS.ZONE3_MINING, {
    type: "status",
    timestamp: new Date().toISOString(),
    running: zone3MinerManager.getStatus().running,
    progress: zone3MinerManager.getStatus().progress,
    message: zone3MinerManager.getStatus().lastMessage
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
  runtime = withNetworkHeartbeat(runtime);
  io.emit(SOCKET_EVENTS.UPDATE, {
    type: "SNAPSHOT",
    payload: runtime.snapshot
  });
}

function withNetworkHeartbeat(baseRuntime: RuntimeState): RuntimeState {
  const zone0Status = baseRuntime.zone0.getRealtimeStatus();
  const zone5State = baseRuntime.zone5.getStateSnapshot();
  const now = new Date().toISOString();

  const llmConfigured = zone5State.provider !== "RULE" && zone5State.llmBaseUrl.trim().length > 0;
  const nextNetwork = baseRuntime.snapshot.network.map((service) => {
    if (service.name === "KIS_API") {
      return {
        ...service,
        state: toConnectionState(zone0Status.kisConnected),
        updatedAt: now
      };
    }

    if (service.name === "ORACLE_26AI") {
      return {
        ...service,
        state: toConnectionState(oraclePersistence.provider === "ORACLE"),
        updatedAt: now
      };
    }

    return {
      ...service,
      state: toConnectionState(llmConfigured && llmConnected),
      updatedAt: now
    };
  });

  return {
    ...baseRuntime,
    snapshot: {
      ...baseRuntime.snapshot,
      network: nextNetwork
    }
  };
}

async function probeLlmHeartbeat(): Promise<void> {
  const zone5State = runtime.zone5.getStateSnapshot();
  const base = zone5State.llmBaseUrl.trim().replace(/\/+$/, "");
  const llmConfigured = zone5State.provider !== "RULE" && base.length > 0;
  if (!llmConfigured) {
    llmConnected = false;
    llmHeartbeatAt = new Date().toISOString();
    return;
  }

  const url = `${base}/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEARTBEAT_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal
    });
    llmConnected = response.ok;
  } catch {
    llmConnected = false;
  } finally {
    clearTimeout(timer);
    llmHeartbeatAt = new Date().toISOString();
  }
}

function toConnectionState(up: boolean): "UP" | "DOWN" {
  return up ? "UP" : "DOWN";
}

runtime.zone0.emitter.on("zone0:raw", () => {
  void scheduleRuntimeStep();
});

runtime.zone0.emitter.on("zone0:raw", (frame) => {
  io.emit(SOCKET_EVENTS.ZONE0_RAW, frame);
  oraclePersistence.persistZone0Frame(frame);
});

async function scheduleRuntimeStep(): Promise<void> {
  if (stepping) {
    rerunRequested = true;
    return;
  }

  stepping = true;
  try {
    do {
      rerunRequested = false;
      const baseRuntime = runtime;
      const nextRuntime = await stepRuntime(baseRuntime);
      if (runtime !== baseRuntime) {
        continue;
      }

      if (nextRuntime !== baseRuntime) {
        const nextSnapshot = nextRuntime.snapshot;
        const zone2State = nextRuntime.zone2.getStateSnapshot();
        const zone4State = nextRuntime.zone4.getStateSnapshot();
        const zone5State = nextRuntime.zone5.getStateSnapshot();
        const zone6Before = baseRuntime.zone6.getStateSnapshot();
        const zone6After = nextRuntime.zone6.getStateSnapshot();

        oraclePersistence.persistZone1Technical(nextSnapshot.targetSymbol, nextSnapshot.technical);
        oraclePersistence.persistZone2Fundamental(nextSnapshot.fundamental, zone2State.source);
        oraclePersistence.persistZone4Madness(nextSnapshot.targetSymbol, nextSnapshot.madness, zone4State.source);
        oraclePersistence.persistZone5Decision({
          snapshot: nextSnapshot,
          source: zone5State.source,
          archiveJson: zone5State.lastArchiveJson
        });

        if (
          zone6After.recordCount > zone6Before.recordCount &&
          zone6After.lastIngestedTradeId &&
          typeof zone6After.lastIngestedPnlPct === "number"
        ) {
          const tradeInfo = parseZone6TradeInfo(
            zone5State.lastArchiveJson,
            nextSnapshot.targetSymbol,
            zone5State.lastAction ?? "SELL"
          );

          oraclePersistence.persistZone6TradeOutcome({
            tradeId: zone6After.lastIngestedTradeId,
            symbol: tradeInfo.symbol,
            action: tradeInfo.action,
            realizedPnlPct: zone6After.lastIngestedPnlPct,
            archiveJson: zone5State.lastArchiveJson ?? "{}",
            closedAt: zone6After.lastUpdatedAt ?? nextSnapshot.lastUpdatedAt
          });
        }

        runtime = nextRuntime;
        broadcastSnapshot();
      }
    } while (rerunRequested || runtime.zone0.hasPendingFrame());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[orchestrator] tick failed: ${message}`);
  } finally {
    stepping = false;
  }
}

server.listen(port, () => {
  console.log(`[orchestrator] listening on http://localhost:${port}`);
  void oraclePersistence.start();
  llmHeartbeatTimer = setInterval(() => {
    void probeLlmHeartbeat().then(() => {
      broadcastSnapshot();
    });
  }, LLM_HEARTBEAT_MS);
  void probeLlmHeartbeat();
  void runtime.zone0
    .start({
      targetSymbol: runtime.snapshot.targetSymbol
    })
    .then(() => {
      console.log(`[orchestrator] zone0 started for ${runtime.snapshot.targetSymbol}`);
      broadcastSnapshot();
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[orchestrator] zone0 start failed: ${message}`);
      broadcastSnapshot();
    });
});

async function shutdown(): Promise<void> {
  if (llmHeartbeatTimer) {
    clearInterval(llmHeartbeatTimer);
    llmHeartbeatTimer = null;
  }

  try {
    await runtime.zone0.stop();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[orchestrator] zone0 stop failed: ${message}`);
  }

  try {
    await oraclePersistence.shutdown();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[orchestrator] oracle persistence stop failed: ${message}`);
  }

  zone3MinerManager.stopMining();

  server.close(() => {
    process.exit(0);
  });

  setTimeout(() => {
    process.exit(1);
  }, 3_000).unref();
}

process.on("SIGINT", () => {
  void shutdown();
});

process.on("SIGTERM", () => {
  void shutdown();
});

function parseZone6TradeInfo(
  archiveJson: string | null,
  fallbackSymbol: string,
  fallbackAction: string
): { symbol: string; action: "BUY" | "SELL" | "PASS" } {
  let symbol = fallbackSymbol;
  let action: "BUY" | "SELL" | "PASS" = toDecisionAction(fallbackAction);

  if (!archiveJson) {
    return { symbol, action };
  }

  try {
    const parsed = JSON.parse(archiveJson) as {
      target_symbol?: unknown;
      action?: unknown;
    };

    if (typeof parsed.target_symbol === "string" && parsed.target_symbol.trim().length > 0) {
      symbol = parsed.target_symbol.trim();
    }

    if (typeof parsed.action === "string") {
      action = toDecisionAction(parsed.action);
    }
  } catch {
    return { symbol, action };
  }

  return { symbol, action };
}

function toDecisionAction(raw: string): "BUY" | "SELL" | "PASS" {
  const value = raw.trim().toUpperCase();
  if (value === "BUY" || value === "SELL" || value === "PASS") {
    return value;
  }
  return "SELL";
}

function handleTelegramWebhook(req: Request, res: Response): void {
  try {
    const entries = normalizeTelegramWebhookEntries(req.body);
    const ids: string[] = [];
    let accepted = 0;
    let rejected = 0;

    for (const entry of entries) {
      const item = runtime.zone0.ingestTelegramWebhook(entry);
      if (!item) {
        rejected += 1;
        continue;
      }
      accepted += 1;
      ids.push(item.id);
    }

    if (accepted === 0) {
      res.status(400).json({
        ok: false,
        accepted,
        rejected,
        error: "유효한 텔레그램 메시지를 찾지 못했습니다. message/text/content/caption 필드가 필요합니다."
      });
      return;
    }

    res.json({
      ok: true,
      accepted,
      rejected,
      id: ids[0],
      ids
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({
      ok: false,
      error: message
    });
  }
}

function normalizeTelegramWebhookEntries(raw: unknown): Array<Record<string, unknown>> {
  const parsed = parseWebhookBody(raw);

  if (Array.isArray(parsed)) {
    return parsed
      .map((item) => toObject(item) ?? (typeof item === "string" ? { message: item } : null))
      .filter((item): item is Record<string, unknown> => item !== null);
  }

  const obj = toObject(parsed);
  if (!obj) {
    return [];
  }

  const batch = pickBatchArray(obj);
  if (batch) {
    return batch
      .map((item) => toObject(item))
      .filter((item): item is Record<string, unknown> => item !== null);
  }

  return [obj];
}

function parseWebhookBody(raw: unknown): unknown {
  if (typeof raw !== "string") {
    return raw;
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return {
      message: trimmed
    };
  }
}

function pickBatchArray(payload: Record<string, unknown>): unknown[] | null {
  const keys = ["messages", "items", "updates", "records", "events", "data"];
  for (const key of keys) {
    const value = payload[key];
    if (Array.isArray(value)) {
      return value;
    }
  }
  return null;
}

function toObject(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return raw as Record<string, unknown>;
}

function parseSymbolsQuery(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw.join(",") : String(raw ?? "");
  if (!list.trim()) {
    return [];
  }

  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const token of list.split(",")) {
    const symbol = normalizeSymbol(token);
    if (!symbol || seen.has(symbol)) {
      continue;
    }
    seen.add(symbol);
    deduped.push(symbol);
  }

  return deduped.slice(0, 40);
}

function parseZone0ConfigPayload(raw: unknown): { keywords: string[]; boardPollMs: number } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("요청 본문은 JSON 객체여야 합니다.");
  }

  const body = raw as Record<string, unknown>;
  const rawKeywords = body.keywords ?? body.newKeywords ?? body.newsKeywords;
  if (!Array.isArray(rawKeywords)) {
    throw new Error("keywords 배열이 필요합니다.");
  }

  const dedupedKeywords: string[] = [];
  const seenKeywords = new Set<string>();
  for (const rawKeyword of rawKeywords) {
    const token = String(rawKeyword ?? "").trim();
    if (!token || seenKeywords.has(token)) {
      continue;
    }
    seenKeywords.add(token);
    dedupedKeywords.push(token);
  }

  const rawBoardPollMs = body.boardPollMs ?? body.newBoardPollMs ?? body.boardPollIntervalMs;
  if (rawBoardPollMs === undefined || rawBoardPollMs === null || rawBoardPollMs === "") {
    throw new Error("boardPollMs 값이 필요합니다.");
  }

  const boardPollMs = Number(rawBoardPollMs);
  if (!Number.isFinite(boardPollMs) || boardPollMs <= 0) {
    throw new Error("boardPollMs는 0보다 큰 숫자여야 합니다.");
  }

  return {
    keywords: dedupedKeywords,
    boardPollMs: Math.floor(boardPollMs)
  };
}

function normalizeSymbol(raw: string): string | null {
  const digits = String(raw ?? "").trim().replace(/[^\d]/g, "");
  if (digits.length < 6) {
    return null;
  }
  return digits.slice(0, 6);
}
