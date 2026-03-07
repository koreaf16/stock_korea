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

type Zone4SourceClass = "DISCLOSURE" | "ECONOMIC_PRESS" | "RUMOR";

interface Zone4NewsCandidate {
  newsTs: Date;
  symbol: string;
  source: string;
  sourceClass: Zone4SourceClass;
  sourceScore: number;
  headline: string;
  bodyText: string;
  newsUrl: string | null;
  langCode: string;
  sentimentScore: number | null;
  payload: Record<string, unknown>;
}

interface Zone4NewsInsertRow {
  newsTs: Date;
  newsTsMs: number;
  symbol: string;
  source: string;
  sourceClass: Zone4SourceClass;
  sourceScore: number;
  headline: string;
  bodyText: string;
  newsUrl: string | null;
  langCode: string;
  sentimentScore: number | null;
  keywordsJson: string;
  keywordStrength: number;
  spikeTs: Date | null;
  reactionLatencyMs: number | null;
  tempoLabel: string;
  shockScore: number;
  sectorCouplingIdx: number;
  llmPotentialScore: number;
  payloadJson: string;
}

interface Zone4KeywordConfig {
  llmEnabled: boolean;
  llmBaseUrl: string;
  llmModel: string;
  llmTimeoutMs: number;
  maxKeywords: number;
}

interface Zone4LatencyConfig {
  baselineSec: number;
  spikeWindowSec: number;
  minSpikeVolume: number;
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
  const zone4KeywordConfig = createZone4KeywordConfig();
  const zone4LatencyConfig = createZone4LatencyConfig();

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

      const zone4Candidates = buildZone4NewsCandidates(frame);

      await withConnection(async (connection) => {
        if (rows.length > 0) {
          await connection.executeMany(
            `
              insert into TB_ZONE0_EVENT_RAW
                (event_ts, zone_no, symbol, source, payload_json)
              values
                (:eventTs, :zoneNo, :symbol, :source, :payloadJson)
            `,
            rows,
            { autoCommit: false }
          );
        }

        await persistTickRaw(connection, frame);

        if (zone4Candidates.length > 0) {
          const zone4Rows = await materializeZone4Rows(connection, zone4Candidates, zone4KeywordConfig, zone4LatencyConfig);
          if (zone4Rows.length > 0) {
            const zone4Binds = zone4Rows as unknown as oracledb.BindParameters[];
            await connection.executeMany(
              `
                insert into TB_ZONE4_NEWS_RAW
                  (
                    news_ts,
                    news_ts_ms,
                    symbol,
                    source,
                    source_class,
                    source_score,
                    headline,
                    body_text,
                    news_url,
                    lang_code,
                    sentiment_score,
                    keywords_json,
                    keyword_strength,
                    spike_ts,
                    reaction_latency_ms,
                    tempo_label,
                    shock_score,
                    sector_coupling_idx,
                    llm_potential_score,
                    payload_json
                  )
                values
                  (
                    :newsTs,
                    :newsTsMs,
                    :symbol,
                    :source,
                    :sourceClass,
                    :sourceScore,
                    :headline,
                    :bodyText,
                    :newsUrl,
                    :langCode,
                    :sentimentScore,
                    :keywordsJson,
                    :keywordStrength,
                    :spikeTs,
                    :reactionLatencyMs,
                    :tempoLabel,
                    :shockScore,
                    :sectorCouplingIdx,
                    :llmPotentialScore,
                    :payloadJson
                  )
              `,
              zone4Binds,
              { autoCommit: false }
            );
          }
        }

        await connection.commit();
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
            merge into TB_ZONE2_FUNDAMENTAL tgt
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

const Z4_IMPACT_KEYWORDS = [
  "공급계약",
  "임상3상",
  "최대주주변경",
  "MOU",
  "수주",
  "합병",
  "인수",
  "특허",
  "신약",
  "유상증자",
  "무상증자",
  "자사주",
  "실적",
  "가이던스",
  "수출",
  "규제완화",
  "정부정책",
  "AI",
  "반도체",
  "2차전지",
  "바이오"
] as const;

const Z4_SECTOR_KEYWORDS: Array<{ sector: string; keywords: string[] }> = [
  { sector: "SEMICONDUCTOR", keywords: ["반도체", "HBM", "파운드리", "메모리", "AI칩"] },
  { sector: "BIO", keywords: ["임상", "신약", "바이오", "FDA", "치료제"] },
  { sector: "BATTERY", keywords: ["2차전지", "배터리", "양극재", "음극재", "전해질"] },
  { sector: "DEFENSE", keywords: ["방산", "수주", "방위산업", "무기체계"] },
  { sector: "AUTO", keywords: ["전기차", "자동차", "완성차", "모빌리티"] },
  { sector: "SHIP", keywords: ["조선", "선박", "LNG선", "해양플랜트"] }
];

async function persistTickRaw(connection: oracledb.Connection, frame: Zone0Frame): Promise<void> {
  const bid1 = frame.orderBook.bids[0]?.price ?? null;
  const ask1 = frame.orderBook.asks[0]?.price ?? null;
  const tickTs = toDate(frame.tick.timestamp, frame.receivedAt);
  const accTradeValue = Math.max(0, frame.tick.price * frame.tick.volume);

  await connection.execute(
    `
      insert into TB_ZONE1_TICK_RAW
        (event_ts, symbol, last_price, trade_volume, acc_trade_value, bid_price_1, ask_price_1, source, payload_json)
      values
        (:eventTs, :symbol, :lastPrice, :tradeVolume, :accTradeValue, :bidPrice1, :askPrice1, :source, :payloadJson)
    `,
    {
      eventTs: tickTs,
      symbol: truncate(String(frame.tick.symbol || "").trim() || "UNKNOWN", 12),
      lastPrice: frame.tick.price,
      tradeVolume: frame.tick.volume,
      accTradeValue,
      bidPrice1: bid1,
      askPrice1: ask1,
      source: "KIS",
      payloadJson: safeJson({
        tick: frame.tick,
        orderBookTop: {
          bid1,
          ask1,
          totalBidDepth: frame.orderBook.totalBidDepth,
          totalAskDepth: frame.orderBook.totalAskDepth
        }
      })
    },
    { autoCommit: false }
  );
}

function buildZone4NewsCandidates(frame: Zone0Frame): Zone4NewsCandidate[] {
  const candidates: Zone4NewsCandidate[] = [];
  const fallbackTs = frame.receivedAt;

  for (const item of frame.newsItems) {
    candidates.push({
      newsTs: toDate(item.timestamp, fallbackTs),
      symbol: normalizeSymbol(item.symbol, frame.tick.symbol),
      source: item.source,
      sourceClass: item.sourceClass ?? "ECONOMIC_PRESS",
      sourceScore: resolveSourceScore(item.sourceClass ?? "ECONOMIC_PRESS"),
      headline: truncate(String(item.headline ?? "").trim() || "NO_HEADLINE", 1000),
      bodyText: String(item.body ?? "").trim(),
      newsUrl: normalizeOptionalText(item.newsUrl),
      langCode: "ko",
      sentimentScore: clampNumber(item.sentimentHint, -1, 1),
      payload: {
        kind: "news",
        item
      }
    });
  }

  for (const item of frame.dartDisclosures) {
    candidates.push({
      newsTs: toDate(item.timestamp, fallbackTs),
      symbol: normalizeSymbol(item.symbol, frame.tick.symbol),
      source: item.source,
      sourceClass: "DISCLOSURE",
      sourceScore: resolveSourceScore("DISCLOSURE"),
      headline: truncate(`${item.corpName} ${item.reportName}`.trim() || "DART_DISCLOSURE", 1000),
      bodyText: `receiptNo=${item.receiptNo} keywords=${item.impactKeywords.join(",")} impact=${item.impactScore}`,
      newsUrl: normalizeOptionalText(item.link),
      langCode: "ko",
      sentimentScore: clampNumber(item.sentimentHint, -1, 1),
      payload: {
        kind: "dart_disclosure",
        item
      }
    });
  }

  for (const item of frame.boardPosts) {
    candidates.push({
      newsTs: toDate(item.timestamp, fallbackTs),
      symbol: normalizeSymbol(item.symbol, frame.tick.symbol),
      source: item.source,
      sourceClass: "RUMOR",
      sourceScore: resolveSourceScore("RUMOR"),
      headline: truncate(String(item.title ?? "").trim() || "BOARD_POST", 1000),
      bodyText: String(item.content ?? "").trim(),
      newsUrl: null,
      langCode: "ko",
      sentimentScore: clampNumber(item.sentimentHint, -1, 1),
      payload: {
        kind: "board_post",
        item
      }
    });
  }

  for (const item of frame.telegramMessages) {
    candidates.push({
      newsTs: toDate(item.timestamp, fallbackTs),
      symbol: normalizeSymbol(item.symbol, frame.tick.symbol),
      source: item.source,
      sourceClass: "RUMOR",
      sourceScore: resolveSourceScore("RUMOR"),
      headline: truncate(String(item.message ?? "").slice(0, 180).trim() || "TELEGRAM", 1000),
      bodyText: String(item.message ?? "").trim(),
      newsUrl: null,
      langCode: "ko",
      sentimentScore: clampNumber(item.sentimentHint, -1, 1),
      payload: {
        kind: "telegram",
        item
      }
    });
  }

  return candidates.slice(0, 80);
}

async function materializeZone4Rows(
  connection: oracledb.Connection,
  candidates: Zone4NewsCandidate[],
  keywordConfig: Zone4KeywordConfig,
  latencyConfig: Zone4LatencyConfig
): Promise<Zone4NewsInsertRow[]> {
  const out: Zone4NewsInsertRow[] = [];

  for (const candidate of candidates) {
    const keywordSource = `${candidate.headline}\n${candidate.bodyText}`.trim();
    const keywords = await extractKeywords(keywordSource, candidate.sourceClass, keywordConfig);
    const keywordStrength = computeKeywordStrength(keywords, candidate.sourceScore);
    const sectorCouplingIdx = computeSectorCouplingIndex(keywords);
    const latency = await findReactionLatency(connection, candidate.symbol, candidate.newsTs, latencyConfig);
    const tempoLabel = classifyTempo(latency.latencyMs);
    const shockScore = computeShockScore({
      sourceScore: candidate.sourceScore,
      keywordStrength,
      sectorCouplingIdx,
      sentimentScore: candidate.sentimentScore,
      tempoLabel
    });
    const llmPotentialScore = await estimatePotentialScore(keywordSource, shockScore, keywordConfig, candidate.sourceClass);

    const payload = {
      ...candidate.payload,
      source_class: candidate.sourceClass,
      source_score: candidate.sourceScore,
      keywords,
      keyword_strength: keywordStrength,
      sector_coupling_idx: sectorCouplingIdx,
      reaction_latency_ms: latency.latencyMs,
      tempo_label: tempoLabel,
      shock_score: shockScore,
      llm_potential_score: llmPotentialScore,
      spike_ts: latency.spikeTs ? latency.spikeTs.toISOString() : null
    };

    out.push({
      newsTs: candidate.newsTs,
      newsTsMs: candidate.newsTs.getTime(),
      symbol: truncate(candidate.symbol, 12),
      source: truncate(candidate.source, 40),
      sourceClass: candidate.sourceClass,
      sourceScore: Number(candidate.sourceScore.toFixed(3)),
      headline: truncate(candidate.headline || "NO_HEADLINE", 1000),
      bodyText: candidate.bodyText,
      newsUrl: candidate.newsUrl,
      langCode: truncate(candidate.langCode || "ko", 8),
      sentimentScore: candidate.sentimentScore,
      keywordsJson: safeJson(keywords),
      keywordStrength: Number(keywordStrength.toFixed(4)),
      spikeTs: latency.spikeTs,
      reactionLatencyMs: latency.latencyMs,
      tempoLabel,
      shockScore: Number(shockScore.toFixed(2)),
      sectorCouplingIdx: Number(sectorCouplingIdx.toFixed(4)),
      llmPotentialScore: Number(llmPotentialScore.toFixed(2)),
      payloadJson: safeJson(payload)
    });
  }

  return out;
}

async function findReactionLatency(
  connection: oracledb.Connection,
  symbol: string,
  newsTs: Date,
  config: Zone4LatencyConfig
): Promise<{ spikeTs: Date | null; latencyMs: number | null }> {
  const result = await connection.execute(
    `
      select min(event_ts) as spike_ts
      from TB_ZONE1_TICK_RAW
      where symbol = :symbol
        and event_ts >= :newsTs
        and event_ts <= (:newsTs + numtodsinterval(:windowSec, 'SECOND'))
        and trade_volume >= (
          select greatest(:minSpikeVolume, nvl(avg(trade_volume), 0) * 3)
          from TB_ZONE1_TICK_RAW
          where symbol = :symbol
            and event_ts < :newsTs
            and event_ts >= (:newsTs - numtodsinterval(:baselineSec, 'SECOND'))
        )
    `,
    {
      symbol,
      newsTs,
      windowSec: config.spikeWindowSec,
      baselineSec: config.baselineSec,
      minSpikeVolume: config.minSpikeVolume
    },
    { outFormat: oracledb.OUT_FORMAT_OBJECT }
  );

  const rows = Array.isArray(result.rows) ? (result.rows as Array<Record<string, unknown>>) : [];
  const spikeRaw = rows[0]?.SPIKE_TS;
  if (!spikeRaw) {
    return { spikeTs: null, latencyMs: null };
  }

  const spikeTs = toDateObject(spikeRaw);
  if (!spikeTs) {
    return { spikeTs: null, latencyMs: null };
  }

  return {
    spikeTs,
    latencyMs: Math.max(0, spikeTs.getTime() - newsTs.getTime())
  };
}

function classifyTempo(latencyMs: number | null): string {
  if (latencyMs === null) {
    return "NO_SPIKE";
  }
  if (latencyMs <= 1_000) {
    return "HIGH_QUALITY";
  }
  if (latencyMs >= 60_000) {
    return "LOW_QUALITY";
  }
  return "MID_QUALITY";
}

function computeShockScore(input: {
  sourceScore: number;
  keywordStrength: number;
  sectorCouplingIdx: number;
  sentimentScore: number | null;
  tempoLabel: string;
}): number {
  const sentimentAbs = Math.abs(input.sentimentScore ?? 0);
  const tempoBonus = input.tempoLabel === "HIGH_QUALITY" ? 0.22 : input.tempoLabel === "LOW_QUALITY" ? -0.14 : 0.05;
  const raw =
    input.sourceScore * 0.34
    + input.keywordStrength * 0.33
    + input.sectorCouplingIdx * 0.19
    + sentimentAbs * 0.14
    + tempoBonus;

  return clampNumber(raw * 10, 1, 10);
}

function computeKeywordStrength(keywords: string[], sourceScore: number): number {
  if (keywords.length === 0) {
    return clampNumber(sourceScore * 0.25, 0, 1);
  }

  const impactHits = keywords.filter((keyword) => isImpactKeyword(keyword)).length;
  const normalizedCount = clampNumber(keywords.length / 8, 0, 1);
  const normalizedImpact = clampNumber(impactHits / 5, 0, 1);
  return clampNumber(sourceScore * 0.2 + normalizedCount * 0.35 + normalizedImpact * 0.45, 0, 1);
}

function computeSectorCouplingIndex(keywords: string[]): number {
  if (keywords.length === 0) {
    return 0.1;
  }

  const hitSectors = new Set<string>();
  for (const keyword of keywords) {
    const lower = keyword.toLowerCase();
    for (const sectorMap of Z4_SECTOR_KEYWORDS) {
      if (sectorMap.keywords.some((token) => lower.includes(token.toLowerCase()))) {
        hitSectors.add(sectorMap.sector);
      }
    }
  }

  const impactBoost = keywords.filter((keyword) => isImpactKeyword(keyword)).length * 0.05;
  return clampNumber(hitSectors.size * 0.22 + impactBoost, 0, 1);
}

async function extractKeywords(text: string, sourceClass: Zone4SourceClass, config: Zone4KeywordConfig): Promise<string[]> {
  const llmKeywords = await extractKeywordsWithLlm(text, sourceClass, config);
  if (llmKeywords.length > 0) {
    return llmKeywords.slice(0, config.maxKeywords);
  }
  return extractKeywordsHeuristic(text, config.maxKeywords);
}

async function extractKeywordsWithLlm(
  text: string,
  sourceClass: Zone4SourceClass,
  config: Zone4KeywordConfig
): Promise<string[]> {
  if (!config.llmEnabled || !config.llmBaseUrl) {
    return [];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.llmTimeoutMs);
  try {
    const response = await fetch(`${config.llmBaseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.llmModel,
        temperature: 0.1,
        max_tokens: 120,
        messages: [
          {
            role: "system",
            content:
              "Extract Korean stock catalyst keywords from text. "
              + "Return strict JSON only: {\"keywords\":[\"...\"]}. Keep 1~8 concise domain keywords."
          },
          {
            role: "user",
            content: JSON.stringify({
              source_class: sourceClass,
              text: truncate(text, 1800),
              examples: ["공급계약", "임상3상", "최대주주변경", "유상증자", "실적서프라이즈"]
            })
          }
        ]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      return [];
    }

    const raw = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
    };
    const content = extractLlmContent(raw);
    if (!content) {
      return [];
    }
    const parsed = parseJsonObject(content);
    if (!parsed || !Array.isArray(parsed.keywords)) {
      return [];
    }

    return normalizeKeywords(parsed.keywords.map((item) => String(item ?? "")));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function extractKeywordsHeuristic(text: string, maxKeywords: number): string[] {
  const normalized = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!normalized) {
    return [];
  }

  const found: string[] = [];
  const lower = normalized.toLowerCase();

  for (const token of Z4_IMPACT_KEYWORDS) {
    if (lower.includes(token.toLowerCase())) {
      found.push(token);
      if (found.length >= maxKeywords) {
        return found;
      }
    }
  }

  const candidateTokens = normalized
    .split(/[^\p{L}\p{N}_]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);

  for (const token of candidateTokens) {
    if (found.includes(token)) {
      continue;
    }
    found.push(token);
    if (found.length >= maxKeywords) {
      break;
    }
  }

  return normalizeKeywords(found).slice(0, maxKeywords);
}

async function estimatePotentialScore(
  text: string,
  fallbackScore: number,
  config: Zone4KeywordConfig,
  sourceClass: Zone4SourceClass
): Promise<number> {
  if (!config.llmEnabled || !config.llmBaseUrl) {
    return fallbackScore;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.llmTimeoutMs);
  try {
    const response = await fetch(`${config.llmBaseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.llmModel,
        temperature: 0.1,
        max_tokens: 80,
        messages: [
          {
            role: "system",
            content:
              "You score stock-news disruptive potential in cold-start mode. "
              + "Return strict JSON: {\"potential_score\": number(1~10)}."
          },
          {
            role: "user",
            content: JSON.stringify({
              source_class: sourceClass,
              text: truncate(text, 1200)
            })
          }
        ]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      return fallbackScore;
    }

    const raw = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
    };
    const content = extractLlmContent(raw);
    if (!content) {
      return fallbackScore;
    }
    const parsed = parseJsonObject(content);
    const score = asNumber(parsed?.potential_score);
    if (score === null) {
      return fallbackScore;
    }
    return clampNumber(score, 1, 10);
  } catch {
    return fallbackScore;
  } finally {
    clearTimeout(timer);
  }
}

function resolveSourceScore(sourceClass: Zone4SourceClass): number {
  if (sourceClass === "DISCLOSURE") {
    return clampNumber(Number(process.env.ZONE4_SOURCE_SCORE_DISCLOSURE ?? 1.0), 0, 1);
  }
  if (sourceClass === "RUMOR") {
    return clampNumber(Number(process.env.ZONE4_SOURCE_SCORE_RUMOR ?? 0.3), 0, 1);
  }
  return clampNumber(Number(process.env.ZONE4_SOURCE_SCORE_ECONOMIC ?? 0.7), 0, 1);
}

function normalizeKeywords(raw: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of raw) {
    const trimmed = token.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function normalizeOptionalText(raw: unknown): string | null {
  const text = String(raw ?? "").trim();
  return text.length > 0 ? text : null;
}

function isImpactKeyword(keyword: string): boolean {
  const lower = keyword.toLowerCase();
  return Z4_IMPACT_KEYWORDS.some((token) => lower.includes(token.toLowerCase()));
}

function normalizeSymbol(raw: string | undefined, fallback: string): string {
  const digits = String(raw ?? "").trim().replace(/[^\d]/g, "");
  if (digits.length >= 6) {
    return digits.slice(0, 6);
  }
  const fallbackDigits = String(fallback ?? "").trim().replace(/[^\d]/g, "");
  if (fallbackDigits.length >= 6) {
    return fallbackDigits.slice(0, 6);
  }
  return "UNKNOWN";
}

function createZone4KeywordConfig(): Zone4KeywordConfig {
  const llmBaseUrl = String(
    process.env.ZONE4_META_LLM_BASE_URL
    ?? process.env.ZONE6_LLM_BASE_URL
    ?? process.env.ZONE5_LLM_BASE_URL
    ?? process.env.LLM_BASE_URL
    ?? ""
  ).trim();
  const llmModel = String(
    process.env.ZONE4_META_LLM_MODEL
    ?? process.env.ZONE6_LLM_MODEL
    ?? process.env.ZONE5_LLM_MODEL
    ?? process.env.LLM_MODEL
    ?? "openai/gpt-oss-20b"
  ).trim();
  return {
    llmEnabled: parseBool(process.env.ZONE4_META_KEYWORD_LLM_ENABLED, true),
    llmBaseUrl,
    llmModel,
    llmTimeoutMs: Math.max(250, Number(process.env.ZONE4_META_LLM_TIMEOUT_MS ?? 900)),
    maxKeywords: Math.max(1, Math.min(12, Number(process.env.ZONE4_META_MAX_KEYWORDS ?? 6)))
  };
}

function createZone4LatencyConfig(): Zone4LatencyConfig {
  return {
    baselineSec: Math.max(10, Number(process.env.ZONE4_LATENCY_BASELINE_SEC ?? 60)),
    spikeWindowSec: Math.max(10, Number(process.env.ZONE4_LATENCY_SPIKE_WINDOW_SEC ?? 300)),
    minSpikeVolume: Math.max(1, Number(process.env.ZONE4_LATENCY_MIN_SPIKE_VOLUME ?? 1))
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

function toDateObject(value: unknown): Date | null {
  if (value instanceof Date) {
    return value;
  }
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return null;
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

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function extractLlmContent(raw: { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> }): string | null {
  const content = raw.choices?.[0]?.message?.content;
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const text = content
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("")
      .trim();
    return text || null;
  }
  return null;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // noop
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    const candidate = trimmed.slice(start, end + 1);
    try {
      return JSON.parse(candidate) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}
