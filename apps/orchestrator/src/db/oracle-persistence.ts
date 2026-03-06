import type { DashboardSnapshot, Zone1Technical, Zone2Fundamental, Zone4Madness } from "@stock/contracts";
import oracledb from "oracledb";

import type { Zone0Frame } from "../zones/zone0/ingest.js";

oracledb.outFormat = oracledb.OUT_FORMAT_OBJECT;
oracledb.fetchAsString = [oracledb.CLOB];

interface OracleEnv {
  user: string;
  password: string;
  connectString: string;
}

interface QueueTask {
  context: string;
  run: () => Promise<void>;
}

interface Zone5PersistInput {
  snapshot: DashboardSnapshot;
  source: string | null;
  archiveJson: string | null;
}

interface Zone6PersistInput {
  tradeId: string;
  symbol: string;
  action: "BUY" | "SELL" | "PASS";
  realizedPnlPct: number;
  archiveJson: string;
  closedAt: string;
}

export interface OraclePersistence {
  readonly enabled: boolean;
  readonly provider: "ORACLE" | "DISABLED";
  start: () => Promise<void>;
  shutdown: () => Promise<void>;
  persistZone0Frame: (frame: Zone0Frame) => void;
  persistZone1Technical: (symbol: string, technical: Zone1Technical) => void;
  persistZone2Fundamental: (fundamental: Zone2Fundamental, source: string | null) => void;
  persistZone4Madness: (symbol: string, madness: Zone4Madness, source: string | null) => void;
  persistZone5Decision: (input: Zone5PersistInput) => void;
  persistZone6TradeOutcome: (input: Zone6PersistInput) => void;
}

export function createOraclePersistence(): OraclePersistence {
  const oracleEnv = readOracleEnv();
  const maxQueueSize = Math.max(200, Number(process.env.ORACLE_PERSIST_MAX_QUEUE_SIZE ?? 5_000));
  const maxReasoningLength = 1000;

  let pool: oracledb.Pool | null = null;
  let provider: "ORACLE" | "DISABLED" = oracleEnv ? "ORACLE" : "DISABLED";
  let queue: QueueTask[] = [];
  let draining = false;
  let dropCount = 0;

  async function ensurePool(): Promise<oracledb.Pool | null> {
    if (!oracleEnv) {
      provider = "DISABLED";
      return null;
    }

    if (pool) {
      return pool;
    }

    try {
      pool = await oracledb.createPool({
        user: oracleEnv.user,
        password: oracleEnv.password,
        connectString: oracleEnv.connectString,
        poolMin: 0,
        poolMax: 8,
        poolIncrement: 1,
        queueTimeout: 4_000
      });
      provider = "ORACLE";
      return pool;
    } catch (error) {
      provider = "DISABLED";
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[db] oracle pool init failed: ${message}`);
      return null;
    }
  }

  async function withConnection<T>(work: (connection: oracledb.Connection) => Promise<T>): Promise<T | null> {
    const activePool = await ensurePool();
    if (!activePool) {
      return null;
    }

    let connection: oracledb.Connection | null = null;
    try {
      connection = await activePool.getConnection();
      return await work(connection);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[db] connection/work failed: ${message}`);
      return null;
    } finally {
      if (connection) {
        await connection.close();
      }
    }
  }

  function pushTask(context: string, run: () => Promise<void>): void {
    if (!oracleEnv) {
      return;
    }

    if (queue.length >= maxQueueSize) {
      queue.shift();
      dropCount += 1;
      if (dropCount % 100 === 0) {
        console.warn(`[db] persist queue dropped ${dropCount.toLocaleString("ko-KR")} tasks`);
      }
    }

    queue.push({ context, run });
    if (!draining) {
      void drainQueue();
    }
  }

  async function drainQueue(): Promise<void> {
    if (draining) {
      return;
    }
    draining = true;

    try {
      while (queue.length > 0) {
        const task = queue.shift();
        if (!task) {
          continue;
        }

        try {
          await task.run();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`[db] ${task.context} failed: ${message}`);
        }
      }
    } finally {
      draining = false;
    }
  }

  function persistZone0Frame(frame: Zone0Frame): void {
    pushTask("zone0:raw", async () => {
      const rows: Array<{
        eventTs: Date;
        zoneNo: number;
        symbol: string;
        source: string;
        payloadJson: string;
      }> = [];

      rows.push({
        eventTs: toDate(frame.tick.timestamp, frame.receivedAt),
        zoneNo: 0,
        symbol: frame.tick.symbol,
        source: "KIS_H0STCNT0",
        payloadJson: safeJson(frame.tick)
      });

      rows.push({
        eventTs: toDate(frame.orderBook.timestamp, frame.receivedAt),
        zoneNo: 0,
        symbol: frame.orderBook.symbol,
        source: "KIS_H0STASP0",
        payloadJson: safeJson(frame.orderBook)
      });

      for (const item of frame.newsItems) {
        rows.push({
          eventTs: toDate(item.timestamp, frame.receivedAt),
          zoneNo: 0,
          symbol: item.symbol,
          source: item.source,
          payloadJson: safeJson(item)
        });
      }

      for (const item of frame.boardPosts) {
        rows.push({
          eventTs: toDate(item.timestamp, frame.receivedAt),
          zoneNo: 0,
          symbol: item.symbol,
          source: item.source,
          payloadJson: safeJson(item)
        });
      }

      for (const item of frame.dartDisclosures) {
        rows.push({
          eventTs: toDate(item.timestamp, frame.receivedAt),
          zoneNo: 0,
          symbol: item.symbol,
          source: item.source,
          payloadJson: safeJson(item)
        });
      }

      for (const item of frame.fundamentalData) {
        rows.push({
          eventTs: toDate(item.timestamp, frame.receivedAt),
          zoneNo: 0,
          symbol: item.symbol,
          source: "MARKET_FUNDAMENTAL",
          payloadJson: safeJson(item)
        });
      }

      if (frame.globalContext) {
        rows.push({
          eventTs: toDate(frame.globalContext.updatedAt, frame.receivedAt),
          zoneNo: 0,
          symbol: frame.tick.symbol,
          source: "GLOBAL_MACRO",
          payloadJson: safeJson(frame.globalContext)
        });
      }

      for (const item of frame.telegramMessages) {
        rows.push({
          eventTs: toDate(item.timestamp, frame.receivedAt),
          zoneNo: 0,
          symbol: item.symbol,
          source: item.source,
          payloadJson: safeJson(item)
        });
      }

      rows.push({
        eventTs: toDate(frame.receivedAt, frame.receivedAt),
        zoneNo: 0,
        symbol: frame.tick.symbol,
        source: "SENTIMENT_PULSE",
        payloadJson: safeJson(frame.sentimentPulse)
      });

      if (rows.length === 0) {
        return;
      }

      await withConnection(async (connection) => {
        await connection.executeMany(
          `
            insert into TB_ZONE0_EVENT_RAW
              (event_ts, zone_no, symbol, source, payload_json)
            values
              (:eventTs, :zoneNo, :symbol, :source, :payloadJson)
          `,
          rows,
          { autoCommit: true }
        );
      });
    });
  }

  function persistZone1Technical(symbol: string, technical: Zone1Technical): void {
    pushTask("zone1:technical", async () => {
      await withConnection(async (connection) => {
        await connection.execute(
          `
            insert into TB_ZONE1_TECHNICAL_LOG
              (event_ts, symbol, volume_power, spike_ratio, ma_divergence, order_imbalance, support_price, resistance_price)
            values
              (:eventTs, :symbol, :volumePower, :spikeRatio, :maDivergence, :orderImbalance, :supportPrice, :resistancePrice)
          `,
          {
            eventTs: toDate(technical.updatedAt, nowIso()),
            symbol: truncate(String(symbol || "").trim() || "UNKNOWN", 12),
            volumePower: technical.volumePower,
            spikeRatio: technical.spikeRatio,
            maDivergence: technical.maDivergence,
            orderImbalance: technical.orderImbalance,
            supportPrice: technical.support,
            resistancePrice: technical.resistance
          },
          { autoCommit: true }
        );
      });
    });
  }

  function persistZone2Fundamental(fundamental: Zone2Fundamental, source: string | null): void {
    pushTask("zone2:fundamental", async () => {
      const issues = Array.isArray(fundamental.issues) ? fundamental.issues : [];
      const hasCbBwIssue = issues.some((issue) => {
        const text = issue.toLowerCase();
        return text.includes("cb") || text.includes("bw") || text.includes("rights") || text.includes("유상증자");
      });
      const hasKrxWarning = issues.some((issue) => {
        const text = issue.toLowerCase();
        return text.includes("krx") || text.includes("경고") || text.includes("위험") || text.includes("관리종목");
      });
      const hasCapitalImpairment = issues.some((issue) => {
        const text = issue.toLowerCase();
        return text.includes("capital") || text.includes("자본잠식");
      });

      await withConnection(async (connection) => {
        await connection.execute(
          `
            merge into TB_STOCK_FUNDAMENTAL tgt
            using (
              select
                :symbol as symbol,
                :riskFlag as riskFlag,
                :issuesJson as issuesJson,
                :hasCbBwIssue as hasCbBwIssue,
                :hasKrxWarning as hasKrxWarning,
                :hasCapitalImpairment as hasCapitalImpairment,
                :checkedAt as checkedAt,
                :source as source
              from dual
            ) src
            on (tgt.symbol = src.symbol)
            when matched then
              update set
                tgt.risk_flag = src.riskFlag,
                tgt.issues_json = src.issuesJson,
                tgt.has_cb_bw_issue = src.hasCbBwIssue,
                tgt.has_krx_warning = src.hasKrxWarning,
                tgt.has_capital_impairment = src.hasCapitalImpairment,
                tgt.checked_at = src.checkedAt,
                tgt.source = src.source
            when not matched then
              insert (
                symbol, risk_flag, issues_json, has_cb_bw_issue, has_krx_warning, has_capital_impairment, checked_at, source
              ) values (
                src.symbol, src.riskFlag, src.issuesJson, src.hasCbBwIssue, src.hasKrxWarning, src.hasCapitalImpairment, src.checkedAt, src.source
              )
          `,
          {
            symbol: truncate(String(fundamental.symbol || "").trim() || "UNKNOWN", 12),
            riskFlag: truncate(fundamental.riskFlag, 16),
            issuesJson: safeJson(issues),
            hasCbBwIssue: hasCbBwIssue ? 1 : 0,
            hasKrxWarning: hasKrxWarning ? 1 : 0,
            hasCapitalImpairment: hasCapitalImpairment ? 1 : 0,
            checkedAt: toDate(fundamental.checkedAt, nowIso()),
            source: truncate((source ?? "SYSTEM").toUpperCase(), 20)
          },
          { autoCommit: true }
        );
      });
    });
  }

  function persistZone4Madness(symbol: string, madness: Zone4Madness, source: string | null): void {
    pushTask("zone4:madness", async () => {
      await withConnection(async (connection) => {
        await connection.execute(
          `
            insert into TB_ZONE4_MADNESS_LOG
              (event_ts, symbol, score, stage, sentiment, news_velocity, source)
            values
              (:eventTs, :symbol, :score, :stage, :sentiment, :newsVelocity, :source)
          `,
          {
            eventTs: toDate(madness.updatedAt, nowIso()),
            symbol: truncate(String(symbol || "").trim() || "UNKNOWN", 12),
            score: madness.score,
            stage: truncate(madness.stage, 16),
            sentiment: madness.sentiment,
            newsVelocity: madness.newsVelocity,
            source: truncate((source ?? "LOCAL").toUpperCase(), 20)
          },
          { autoCommit: true }
        );
      });
    });
  }

  function persistZone5Decision(input: Zone5PersistInput): void {
    pushTask("zone5:decision", async () => {
      const decision = input.snapshot.decision;

      await withConnection(async (connection) => {
        await connection.execute(
          `
            insert into TB_ZONE5_DECISION_LOG
              (
                generated_at, decision_id, target_symbol, action, confidence_score, reasoning,
                suggested_weight_pct, target_price, stop_price, source, archive_json
              )
            values
              (
                :generatedAt, :decisionId, :targetSymbol, :action, :confidenceScore, :reasoning,
                :suggestedWeightPct, :targetPrice, :stopPrice, :source, :archiveJson
              )
          `,
          {
            generatedAt: toDate(decision.generatedAt, nowIso()),
            decisionId: truncate(decision.decisionId, 64),
            targetSymbol: truncate(input.snapshot.targetSymbol, 12),
            action: truncate(decision.action, 8),
            confidenceScore: decision.confidenceScore,
            reasoning: truncate(decision.reasoning, maxReasoningLength),
            suggestedWeightPct: decision.suggestedWeightPct,
            targetPrice: decision.targetPrice ?? null,
            stopPrice: decision.stopPrice ?? null,
            source: truncate((input.source ?? "RULE").toUpperCase(), 16),
            archiveJson: input.archiveJson ?? null
          },
          { autoCommit: true }
        );
      });
    });
  }

  function persistZone6TradeOutcome(input: Zone6PersistInput): void {
    pushTask("zone6:trade-history", async () => {
      await withConnection(async (connection) => {
        await connection.execute(
          `
            insert into TB_TRADE_HISTORY
              (closed_at, trade_id, symbol, action, realized_pnl_pct, win_flag, zone5_archive_json)
            values
              (:closedAt, :tradeId, :symbol, :action, :realizedPnlPct, :winFlag, :archiveJson)
          `,
          {
            closedAt: toDate(input.closedAt, nowIso()),
            tradeId: truncate(input.tradeId, 64),
            symbol: truncate(input.symbol, 12),
            action: truncate(input.action, 8),
            realizedPnlPct: input.realizedPnlPct,
            winFlag: input.realizedPnlPct > 0 ? 1 : 0,
            archiveJson: input.archiveJson
          },
          { autoCommit: true }
        );
      });
    });
  }

  return {
    get enabled() {
      return Boolean(oracleEnv);
    },
    get provider() {
      return provider;
    },
    start: async () => {
      if (!oracleEnv) {
        console.warn("[db] oracle env not configured, persistence disabled");
        return;
      }

      const activePool = await ensurePool();
      if (activePool) {
        console.info("[db] oracle persistence enabled");
      }
    },
    shutdown: async () => {
      queue = [];
      if (pool) {
        await pool.close(5);
        pool = null;
      }
    },
    persistZone0Frame,
    persistZone1Technical,
    persistZone2Fundamental,
    persistZone4Madness,
    persistZone5Decision,
    persistZone6TradeOutcome
  };
}

function readOracleEnv(): OracleEnv | null {
  const user = process.env.ORACLE_USER?.trim();
  const password = process.env.ORACLE_PASSWORD?.trim();
  const connectString = process.env.ORACLE_CONNECTION_STRING?.trim();

  if (!user || !password || !connectString) {
    return null;
  }

  return { user, password, connectString };
}

function toDate(iso: string | null | undefined, fallbackIso: string): Date {
  const value = typeof iso === "string" && iso.trim().length > 0 ? iso : fallbackIso;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date(fallbackIso);
  }
  return parsed;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(0, maxLength);
}

function nowIso(): string {
  return new Date().toISOString();
}
