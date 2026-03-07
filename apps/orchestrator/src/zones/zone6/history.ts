import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import type { Zone3PatternMatch, Zone4Madness, Zone6HistoryFeedback } from "@stock/contracts";
import oracledb from "oracledb";

import { clamp, nowIso, shortId } from "../../utils.js";

type Zone6Provider = "AUTO" | "PYTHON" | "LOCAL_VECTOR";
type Zone6Source = "PYTHON" | "LOCAL_VECTOR";
type Zone6DbProvider = "ORACLE" | "DISABLED";
type Zone6ReviewProvider = "AUTO" | "LLM" | "RULE";
type Zone6ReviewSource = "LLM" | "RULE";

interface Zone6WorkerResult {
  similar_trade_id: string;
  win_rate: number;
  summary: string;
  updated_at?: string;
}

interface Zone6MemoryRecord {
  tradeId: string;
  symbol: string;
  vector: number[];
  realizedPnlPct: number;
  isWin: boolean;
  summary: string;
  createdAt: string;
}

interface Zone6EngineResult {
  output: Zone6HistoryFeedback;
  source: Zone6Source;
}

interface Zone6ArchiveRecord {
  decision_id?: string;
  timestamp?: string;
  target_symbol?: string;
  action?: string;
  integrated_event_id?: string | number;
  similarity_context?: {
    top_match?: {
      event_id?: string | number;
      symbol?: string;
      event_ts?: string;
      weighted_similarity?: number;
    };
  };
  snapshot_state?: {
    account_balance?: number;
    total_assets?: number;
    zone_metrics?: {
      z1_volume_power?: number;
      z2_risk_flag?: string;
      z3_similarity?: number;
      z4_stage?: string;
      z6_win_rate?: number;
    };
  };
}

export interface Zone6StateSnapshot {
  provider: Zone6Provider;
  source: Zone6Source | "NONE";
  dbProvider: Zone6DbProvider;
  reviewProvider: Zone6ReviewProvider;
  vectorDim: number;
  maxRecords: number;
  minSimilarity: number;
  recordCount: number;
  pendingSyncCount: number;
  lastSimilarTradeId: string | null;
  lastWinRate: number | null;
  lastSummary: string | null;
  lastUpdatedAt: string | null;
  lastIngestedTradeId: string | null;
  lastIngestedPnlPct: number | null;
  lastMappedEventId: number | null;
  lastPatternId: string | null;
  lastReviewSummary: string | null;
  lastReviewSource: Zone6ReviewSource | "NONE";
  lastSyncAt: string | null;
  lastSyncError: string | null;
  lastError: string | null;
}

export interface Zone6Engine {
  evaluate: (input: { symbol: string; pattern: Zone3PatternMatch; madness: Zone4Madness }) => Zone6HistoryFeedback;
  recordTradeOutcome: (input: { symbol: string; archiveJson: string; realizedPnlPct: number }) => void;
  getStateSnapshot: () => Zone6StateSnapshot;
}

export function createZone6Engine(): Zone6Engine {
  const provider = normalizeProvider(process.env.ZONE6_PROVIDER);
  const vectorDim = Math.max(64, Number(process.env.ZONE6_VECTOR_DIM ?? 1_024));
  const maxRecords = Math.max(100, Number(process.env.ZONE6_MAX_RECORDS ?? 2_000));
  const minSimilarity = clamp(Number(process.env.ZONE6_MIN_SIMILARITY ?? 0.2), 0, 0.99);
  const oracleEnv = readOracleEnv();
  const dbMatchWindowSec = Math.max(30, Number(process.env.ZONE6_EVENT_MATCH_WINDOW_SEC ?? 900));
  const reviewConfig = readReviewConfig();

  const records: Zone6MemoryRecord[] = [];

  let dbProvider: Zone6DbProvider = oracleEnv ? "ORACLE" : "DISABLED";
  let dbPool: oracledb.Pool | null = null;
  let syncTail: Promise<void> = Promise.resolve();
  let pendingSyncCount = 0;

  let lastSource: Zone6Source | "NONE" = "NONE";
  let lastSimilarTradeId: string | null = null;
  let lastWinRate: number | null = null;
  let lastSummary: string | null = null;
  let lastUpdatedAt: string | null = null;
  let lastIngestedTradeId: string | null = null;
  let lastIngestedPnlPct: number | null = null;
  let lastMappedEventId: number | null = null;
  let lastPatternId: string | null = null;
  let lastReviewSummary: string | null = null;
  let lastReviewSource: Zone6ReviewSource | "NONE" = "NONE";
  let lastSyncAt: string | null = null;
  let lastSyncError: string | null = null;
  let lastError: string | null = null;

  function evaluate(input: { symbol: string; pattern: Zone3PatternMatch; madness: Zone4Madness }): Zone6HistoryFeedback {
    const queryVector = vectorizeQuery(input.symbol, input.pattern, input.madness, vectorDim);
    const localResult = evaluateWithLocalVector(input.symbol, input.pattern, input.madness, queryVector, records, minSimilarity);

    let finalResult: Zone6EngineResult = localResult;
    if (provider === "PYTHON" || provider === "AUTO") {
      const pythonResult = evaluateWithPython(input.pattern, input.madness);
      if (pythonResult) {
        finalResult = pythonResult;
        lastError = null;
      } else {
        lastError = "zone6 python worker unavailable";
      }
    } else {
      lastError = null;
    }

    lastSource = finalResult.source;
    lastSimilarTradeId = finalResult.output.similarTradeId;
    lastWinRate = finalResult.output.winRate;
    lastSummary = finalResult.output.summary;
    lastUpdatedAt = finalResult.output.updatedAt;

    return finalResult.output;
  }

  function recordTradeOutcome(input: { symbol: string; archiveJson: string; realizedPnlPct: number }): void {
    const archive = parseArchive(input.archiveJson);
    const createdAt = nowIso();
    const tradeId =
      archive?.decision_id && archive.decision_id.trim().length > 0 ? archive.decision_id.trim() : shortId("HIST");
    const normalizedPnl = Number(input.realizedPnlPct.toFixed(2));
    const isWin = normalizedPnl > 0;
    const tokens = buildRecordTokens(input.symbol, archive, normalizedPnl, isWin);
    const summary = buildRecordSummary(archive, normalizedPnl);

    records.push({
      tradeId,
      symbol: input.symbol,
      vector: embedTokens(tokens, vectorDim),
      realizedPnlPct: normalizedPnl,
      isWin,
      summary,
      createdAt
    });

    while (records.length > maxRecords) {
      records.shift();
    }

    lastIngestedTradeId = tradeId;
    lastIngestedPnlPct = normalizedPnl;
    lastError = null;

    enqueueOutcomeSync({
      tradeId,
      symbol: normalizeSymbol(archive?.target_symbol ?? input.symbol),
      action: normalizeAction(archive?.action),
      realizedPnlPct: normalizedPnl,
      summary,
      archive,
      archiveJson: input.archiveJson,
      anchorTs: resolveAnchorTimestamp(archive, createdAt),
      closedAt: createdAt,
      outcomeLabel: classifyOutcome(normalizedPnl)
    });
  }

  function enqueueOutcomeSync(input: {
    tradeId: string;
    symbol: string;
    action: "BUY" | "SELL" | "PASS";
    realizedPnlPct: number;
    summary: string;
    archive: Zone6ArchiveRecord | null;
    archiveJson: string;
    anchorTs: string;
    closedAt: string;
    outcomeLabel: "SUCCESS" | "FAILURE" | "BREAKEVEN";
  }): void {
    if (!oracleEnv) {
      dbProvider = "DISABLED";
      return;
    }

    pendingSyncCount += 1;
    syncTail = syncTail
      .then(async () => {
        await runOutcomeKnowledgeSync(input);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        lastSyncError = `zone6 sync failed: ${message}`;
      })
      .finally(() => {
        pendingSyncCount = Math.max(0, pendingSyncCount - 1);
        lastSyncAt = nowIso();
      });
  }

  async function runOutcomeKnowledgeSync(input: {
    tradeId: string;
    symbol: string;
    action: "BUY" | "SELL" | "PASS";
    realizedPnlPct: number;
    summary: string;
    archive: Zone6ArchiveRecord | null;
    archiveJson: string;
    anchorTs: string;
    closedAt: string;
    outcomeLabel: "SUCCESS" | "FAILURE" | "BREAKEVEN";
  }): Promise<void> {
    const pool = await ensureDbPool();
    if (!pool) {
      lastSyncError = "zone6 oracle pool unavailable";
      return;
    }

    let connection: oracledb.Connection | null = null;
    try {
      connection = await pool.getConnection();
      connection.callTimeout = reviewConfig.dbCallTimeoutMs;

      const mapped = await resolveIntegratedEvent(connection, input.symbol, input.anchorTs, dbMatchWindowSec, input.archive);
      if (!mapped) {
        lastSyncError = `integrated event not found for ${input.symbol}`;
        return;
      }

      await connection.execute(
        `
          update TB_INTEGRATED_VECTOR_STATION
             set profit_rate = :profitRate,
                 updated_at = systimestamp
           where event_id = :eventId
        `,
        {
          eventId: mapped.eventId,
          profitRate: input.realizedPnlPct
        }
      );

      let vectors: Zone6VectorBundle = { z1: [], z2: [], z3: [], z4: [] };
      try {
        vectors = await fetchIntegratedVectors(connection, mapped.eventId);
      } catch {
        vectors = { z1: [], z2: [], z3: [], z4: [] };
      }
      const review = await buildTradeReviewDiary({
        tradeId: input.tradeId,
        symbol: input.symbol,
        action: input.action,
        realizedPnlPct: input.realizedPnlPct,
        summary: input.summary,
        outcomeLabel: input.outcomeLabel,
        mappedEventId: mapped.eventId,
        mappedEventTs: mapped.eventTs,
        mapReason: mapped.reason,
        closedAt: input.closedAt,
        archive: input.archive,
        vectors,
        reviewConfig
      });

      const patternId = await upsertPatternLibrary(connection, {
        patternId: shortId("PAT"),
        sourceEventId: mapped.eventId,
        symbol: input.symbol,
        learnedAt: input.closedAt,
        profitRate: input.realizedPnlPct,
        outcomeLabel: input.outcomeLabel,
        archiveJson: input.archiveJson,
        reviewDiary: review.diary
      });

      await connection.commit();

      lastMappedEventId = mapped.eventId;
      lastPatternId = patternId;
      lastReviewSummary = truncateText(review.diary, 240);
      lastReviewSource = review.source;
      lastSyncError = null;
    } catch (error) {
      if (connection) {
        try {
          await connection.rollback();
        } catch {
          // noop
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      lastSyncError = `zone6 sync failed: ${message}`;
    } finally {
      if (connection) {
        await connection.close();
      }
    }
  }

  async function ensureDbPool(): Promise<oracledb.Pool | null> {
    if (!oracleEnv) {
      dbProvider = "DISABLED";
      return null;
    }

    if (dbPool) {
      return dbPool;
    }

    try {
      dbPool = await oracledb.createPool({
        user: oracleEnv.user,
        password: oracleEnv.password,
        connectString: oracleEnv.connectString,
        poolMin: 0,
        poolMax: 2,
        poolIncrement: 1,
        queueTimeout: 800
      });
      dbProvider = "ORACLE";
      return dbPool;
    } catch (error) {
      dbProvider = "DISABLED";
      const message = error instanceof Error ? error.message : String(error);
      lastSyncError = `zone6 oracle pool init failed: ${message}`;
      return null;
    }
  }

  return {
    evaluate,
    recordTradeOutcome,
    getStateSnapshot: () => ({
      provider,
      source: lastSource,
      dbProvider,
      reviewProvider: reviewConfig.provider,
      vectorDim,
      maxRecords,
      minSimilarity,
      recordCount: records.length,
      pendingSyncCount,
      lastSimilarTradeId,
      lastWinRate,
      lastSummary,
      lastUpdatedAt,
      lastIngestedTradeId,
      lastIngestedPnlPct,
      lastMappedEventId,
      lastPatternId,
      lastReviewSummary,
      lastReviewSource,
      lastSyncAt,
      lastSyncError,
      lastError
    })
  };
}

function evaluateWithLocalVector(
  symbol: string,
  pattern: Zone3PatternMatch,
  madness: Zone4Madness,
  queryVector: number[],
  records: Zone6MemoryRecord[],
  minSimilarity: number
): Zone6EngineResult {
  if (records.length === 0) {
    return {
      source: "LOCAL_VECTOR",
      output: buildNoHistoryFeedback("실거래 이력 없음")
    };
  }

  const topCandidates = records
    .map((record) => ({
      record,
      similarity: cosineSimilarity(queryVector, record.vector)
    }))
    .filter((candidate) => candidate.similarity >= minSimilarity)
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, 5);

  if (topCandidates.length === 0) {
    return {
      source: "LOCAL_VECTOR",
      output: buildNoHistoryFeedbackFromRecords(records, "유사 이력 임계치 미달")
    };
  }

  const weightSum = topCandidates.reduce((acc, candidate) => acc + Math.max(0, candidate.similarity), 0);
  if (weightSum <= 0) {
    return {
      source: "LOCAL_VECTOR",
      output: buildNoHistoryFeedbackFromRecords(records, "유사 이력 가중치 부족")
    };
  }

  const weightedWins = topCandidates.reduce((acc, candidate) => {
    const weight = Math.max(0, candidate.similarity);
    return acc + (candidate.record.isWin ? weight : 0);
  }, 0);
  const weightedWinRate = weightedWins / weightSum;
  const avgPnl =
    topCandidates.reduce((acc, candidate) => acc + candidate.record.realizedPnlPct, 0) / Math.max(1, topCandidates.length);
  const winRate = clamp(weightedWinRate, 0, 1);

  const best = topCandidates[0];
  if (!best) {
    return {
      source: "LOCAL_VECTOR",
      output: buildNoHistoryFeedbackFromRecords(records, "유사 이력 없음")
    };
  }

  return {
    source: "LOCAL_VECTOR",
    output: {
      similarTradeId: best.record.tradeId,
      winRate: Number(winRate.toFixed(2)),
      summary: `유사 이력 ${topCandidates.length}건 탐지. 중심 이력 ${best.record.tradeId}, 평균 실현손익 ${avgPnl.toFixed(2)}%.`,
      updatedAt: nowIso()
    }
  };
}

function evaluateWithPython(pattern: Zone3PatternMatch, madness: Zone4Madness): Zone6EngineResult | null {
  const scriptPath = resolveZone6WorkerPath();
  if (!scriptPath) {
    return null;
  }

  const rawCmd = (process.env.ZONE6_PYTHON_CMD ?? "python").trim();
  const [pythonCmd, ...prefixArgs] = rawCmd.split(/\s+/);
  if (!pythonCmd) {
    return null;
  }

  const proc = spawnSync(pythonCmd, [...prefixArgs, scriptPath, "--klass", pattern.klass, "--stage", madness.stage], {
    encoding: "utf8",
    timeout: 1_500
  });

  if (proc.error || proc.status !== 0 || !proc.stdout) {
    return null;
  }

  let parsed: Zone6WorkerResult;
  try {
    parsed = JSON.parse(proc.stdout) as Zone6WorkerResult;
  } catch {
    return null;
  }

  return {
    source: "PYTHON",
    output: {
      similarTradeId: parsed.similar_trade_id,
      winRate: Number(clamp(parsed.win_rate, 0.1, 0.9).toFixed(2)),
      summary: truncateText(parsed.summary, 220),
      updatedAt: parsed.updated_at ?? nowIso()
    }
  };
}

function buildNoHistoryFeedback(summary: string): Zone6HistoryFeedback {
  return {
    similarTradeId: "HIST_NONE",
    winRate: 0,
    summary,
    updatedAt: nowIso()
  };
}

function buildNoHistoryFeedbackFromRecords(records: Zone6MemoryRecord[], reason: string): Zone6HistoryFeedback {
  if (records.length === 0) {
    return buildNoHistoryFeedback(reason);
  }

  const wins = records.reduce((acc, record) => acc + (record.isWin ? 1 : 0), 0);
  const winRate = wins / records.length;
  return {
    similarTradeId: "HIST_NONE",
    winRate: Number(clamp(winRate, 0, 1).toFixed(2)),
    summary: `${reason}. 누적 이력 ${records.length}건 기준 승률 ${Number((winRate * 100).toFixed(1))}%.`,
    updatedAt: nowIso()
  };
}

function vectorizeQuery(symbol: string, pattern: Zone3PatternMatch, madness: Zone4Madness, vectorDim: number): number[] {
  const tokens = [
    `sym:${symbol}`,
    `klass:${pattern.klass}`,
    `stage:${madness.stage}`,
    `sim:${bucket(pattern.similarity, 10)}`,
    `score:${bucket(madness.score / 100, 10)}`,
    `sent:${bucket((madness.sentiment + 1) / 2, 10)}`,
    `vel:${bucket(madness.newsVelocity / 100, 10)}`
  ];

  return embedTokens(tokens, vectorDim);
}

function buildRecordTokens(
  symbol: string,
  archive: Zone6ArchiveRecord | null,
  realizedPnlPct: number,
  isWin: boolean
): string[] {
  const z3Similarity = archive?.snapshot_state?.zone_metrics?.z3_similarity ?? 0.5;
  const z1VolumePower = archive?.snapshot_state?.zone_metrics?.z1_volume_power ?? 100;
  const z2RiskFlag = archive?.snapshot_state?.zone_metrics?.z2_risk_flag ?? "CLEAR";
  const z4Stage = archive?.snapshot_state?.zone_metrics?.z4_stage ?? "STAGE_1";
  const z6WinRate = archive?.snapshot_state?.zone_metrics?.z6_win_rate ?? 0.5;

  return [
    `sym:${archive?.target_symbol ?? symbol}`,
    `action:${archive?.action ?? "PASS"}`,
    `stage:${z4Stage}`,
    `risk:${z2RiskFlag}`,
    `sim:${bucket(z3Similarity, 10)}`,
    `vp:${bucket(z1VolumePower / 200, 10)}`,
    `hist:${bucket(z6WinRate, 10)}`,
    `pnl:${bucket((realizedPnlPct + 20) / 40, 12)}`,
    `win:${isWin ? "Y" : "N"}`
  ];
}

function buildRecordSummary(archive: Zone6ArchiveRecord | null, realizedPnlPct: number): string {
  const symbol = archive?.target_symbol ?? "UNKNOWN";
  const action = archive?.action ?? "PASS";
  const stage = archive?.snapshot_state?.zone_metrics?.z4_stage ?? "STAGE_1";
  const sign = realizedPnlPct >= 0 ? "+" : "";
  return `[${symbol}] ${action} -> 청산 ${sign}${realizedPnlPct.toFixed(2)}% (${stage})`;
}

function parseArchive(raw: string): Zone6ArchiveRecord | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  try {
    return JSON.parse(trimmed) as Zone6ArchiveRecord;
  } catch {
    return null;
  }
}

function embedTokens(tokens: string[], vectorDim: number): number[] {
  const vector = new Array<number>(vectorDim).fill(0);

  for (const token of tokens) {
    const h1 = hashToken(token);
    const h2 = hashToken(`${token}:salt`);
    const idx = Math.abs(h1) % vectorDim;
    const sign = h2 % 2 === 0 ? 1 : -1;
    const prev = vector[idx] ?? 0;
    vector[idx] = prev + sign;
  }

  return normalizeVector(vector);
}

function normalizeVector(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((acc, value) => acc + value * value, 0));
  if (norm === 0) {
    return vec.map(() => 0);
  }
  return vec.map((value) => value / norm);
}

function cosineSimilarity(a: number[], b: number[]): number {
  const size = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < size; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dot / Math.sqrt(normA * normB);
}

function hashToken(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return hash;
}

function bucket(value: number, steps: number): number {
  const clipped = clamp(value, 0, 0.999_999);
  return Math.floor(clipped * steps);
}

function truncateText(text: string, maxLength: number): string {
  const normalized = text.trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function resolveZone6WorkerPath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "services/python/zone6_worker.py"),
    path.resolve(process.cwd(), "../../services/python/zone6_worker.py")
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function normalizeProvider(raw?: string): Zone6Provider {
  const normalized = String(raw ?? "AUTO")
    .trim()
    .toUpperCase();

  if (normalized === "PYTHON" || normalized === "LOCAL_VECTOR") {
    return normalized;
  }

  return "AUTO";
}

interface OracleEnv {
  user: string;
  password: string;
  connectString: string;
}

interface Zone6ReviewConfig {
  provider: Zone6ReviewProvider;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxChars: number;
  vectorHead: number;
  dbCallTimeoutMs: number;
}

interface Zone6MappedEvent {
  eventId: number;
  eventTs: string;
  reason: string;
}

interface Zone6VectorBundle {
  z1: number[];
  z2: number[];
  z3: number[];
  z4: number[];
}

interface Zone6ReviewInput {
  tradeId: string;
  symbol: string;
  action: "BUY" | "SELL" | "PASS";
  realizedPnlPct: number;
  summary: string;
  outcomeLabel: "SUCCESS" | "FAILURE" | "BREAKEVEN";
  mappedEventId: number;
  mappedEventTs: string;
  mapReason: string;
  closedAt: string;
  archive: Zone6ArchiveRecord | null;
  vectors: Zone6VectorBundle;
  reviewConfig: Zone6ReviewConfig;
}

async function resolveIntegratedEvent(
  connection: oracledb.Connection,
  symbol: string,
  anchorTs: string,
  windowSec: number,
  archive: Zone6ArchiveRecord | null
): Promise<Zone6MappedEvent | null> {
  const explicitEventId = toInt(archive?.integrated_event_id);
  if (explicitEventId !== null) {
    const explicit = await findEventById(connection, explicitEventId);
    if (explicit) {
      return {
        ...explicit,
        reason: "archive_integrated_event_id"
      };
    }
  }

  const nearestUnlabeled = await findNearestEvent(connection, {
    symbol,
    anchorTs,
    windowSec,
    onlyUnlabeled: true
  });
  if (nearestUnlabeled) {
    return {
      ...nearestUnlabeled,
      reason: "nearest_unlabeled"
    };
  }

  const latestUnlabeled = await findLatestEvent(connection, symbol, true);
  if (latestUnlabeled) {
    return {
      ...latestUnlabeled,
      reason: "latest_unlabeled"
    };
  }

  const nearestAny = await findNearestEvent(connection, {
    symbol,
    anchorTs,
    windowSec,
    onlyUnlabeled: false
  });
  if (nearestAny) {
    return {
      ...nearestAny,
      reason: "nearest_any"
    };
  }

  const latestAny = await findLatestEvent(connection, symbol, false);
  if (latestAny) {
    return {
      ...latestAny,
      reason: "latest_any"
    };
  }

  return null;
}

async function findEventById(connection: oracledb.Connection, eventId: number): Promise<Omit<Zone6MappedEvent, "reason"> | null> {
  const result = await connection.execute(
    `
      select event_id, event_ts
        from TB_INTEGRATED_VECTOR_STATION
       where event_id = :eventId
    `,
    { eventId },
    { outFormat: oracledb.OUT_FORMAT_OBJECT }
  );
  const rows = Array.isArray(result.rows) ? (result.rows as Array<Record<string, unknown>>) : [];
  const row = rows[0];
  if (!row) {
    return null;
  }

  const mappedId = toInt(row.EVENT_ID);
  if (mappedId === null) {
    return null;
  }
  return {
    eventId: mappedId,
    eventTs: toIsoLike(row.EVENT_TS)
  };
}

async function findNearestEvent(
  connection: oracledb.Connection,
  input: { symbol: string; anchorTs: string; windowSec: number; onlyUnlabeled: boolean }
): Promise<Omit<Zone6MappedEvent, "reason"> | null> {
  const query = `
    select event_id, event_ts
      from (
        select
          event_id,
          event_ts,
          abs((cast(event_ts as date) - cast(:anchorTs as date)) * 86400) as diff_sec
        from TB_INTEGRATED_VECTOR_STATION
        where symbol = :symbol
          ${input.onlyUnlabeled ? "and profit_rate is null" : ""}
      )
    where diff_sec <= :windowSec
    order by diff_sec asc
    fetch first 1 rows only
  `;
  const result = await connection.execute(
    query,
    {
      symbol: input.symbol,
      anchorTs: new Date(input.anchorTs),
      windowSec: input.windowSec
    },
    { outFormat: oracledb.OUT_FORMAT_OBJECT }
  );
  const rows = Array.isArray(result.rows) ? (result.rows as Array<Record<string, unknown>>) : [];
  const row = rows[0];
  if (!row) {
    return null;
  }
  const mappedId = toInt(row.EVENT_ID);
  if (mappedId === null) {
    return null;
  }
  return {
    eventId: mappedId,
    eventTs: toIsoLike(row.EVENT_TS)
  };
}

async function findLatestEvent(
  connection: oracledb.Connection,
  symbol: string,
  onlyUnlabeled: boolean
): Promise<Omit<Zone6MappedEvent, "reason"> | null> {
  const query = `
    select event_id, event_ts
      from TB_INTEGRATED_VECTOR_STATION
    where symbol = :symbol
      ${onlyUnlabeled ? "and profit_rate is null" : ""}
    order by event_ts desc
    fetch first 1 rows only
  `;

  const result = await connection.execute(
    query,
    { symbol },
    { outFormat: oracledb.OUT_FORMAT_OBJECT }
  );
  const rows = Array.isArray(result.rows) ? (result.rows as Array<Record<string, unknown>>) : [];
  const row = rows[0];
  if (!row) {
    return null;
  }

  const mappedId = toInt(row.EVENT_ID);
  if (mappedId === null) {
    return null;
  }
  return {
    eventId: mappedId,
    eventTs: toIsoLike(row.EVENT_TS)
  };
}

async function fetchIntegratedVectors(connection: oracledb.Connection, eventId: number): Promise<Zone6VectorBundle> {
  const result = await connection.execute(
    `
      select z1_tech_vec, z2_fund_vec, z3_chart_vec, z4_sent_vec
        from TB_INTEGRATED_VECTOR_STATION
       where event_id = :eventId
    `,
    { eventId },
    { outFormat: oracledb.OUT_FORMAT_OBJECT }
  );
  const rows = Array.isArray(result.rows) ? (result.rows as Array<Record<string, unknown>>) : [];
  const row = rows[0];
  if (!row) {
    return {
      z1: [],
      z2: [],
      z3: [],
      z4: []
    };
  }

  return {
    z1: toNumberArray(row.Z1_TECH_VEC),
    z2: toNumberArray(row.Z2_FUND_VEC),
    z3: toNumberArray(row.Z3_CHART_VEC),
    z4: toNumberArray(row.Z4_SENT_VEC)
  };
}

async function upsertPatternLibrary(
  connection: oracledb.Connection,
  input: {
    patternId: string;
    sourceEventId: number;
    symbol: string;
    learnedAt: string;
    profitRate: number;
    outcomeLabel: "SUCCESS" | "FAILURE" | "BREAKEVEN";
    archiveJson: string;
    reviewDiary: string;
  }
): Promise<string> {
  const updateResult = await connection.execute(
    `
      update TB_PATTERN_LIBRARY
         set profit_rate = :profitRate,
             outcome_label = :outcomeLabel,
             archive_json = :archiveJson,
             review_diary = :reviewDiary,
             updated_at = systimestamp
       where source_event_id = :sourceEventId
    `,
    {
      sourceEventId: input.sourceEventId,
      profitRate: input.profitRate,
      outcomeLabel: input.outcomeLabel,
      archiveJson: input.archiveJson,
      reviewDiary: input.reviewDiary
    }
  );

  if ((updateResult.rowsAffected ?? 0) > 0) {
    const existing = await connection.execute(
      `
        select pattern_id
          from TB_PATTERN_LIBRARY
         where source_event_id = :sourceEventId
         fetch first 1 rows only
      `,
      { sourceEventId: input.sourceEventId },
      { outFormat: oracledb.OUT_FORMAT_OBJECT }
    );
    const rows = Array.isArray(existing.rows) ? (existing.rows as Array<Record<string, unknown>>) : [];
    const patternId = String(rows[0]?.PATTERN_ID ?? input.patternId).trim();
    return patternId || input.patternId;
  }

  await connection.execute(
    `
      insert into TB_PATTERN_LIBRARY
        (
          learned_at,
          pattern_id,
          source_event_id,
          symbol,
          event_ts,
          profit_rate,
          outcome_label,
          z1_tech_vec,
          z2_fund_vec,
          z3_chart_vec,
          z4_sent_vec,
          archive_json,
          review_diary,
          created_at,
          updated_at
        )
      select
        :learnedAt,
        :patternId,
        ivs.event_id,
        ivs.symbol,
        ivs.event_ts,
        :profitRate,
        :outcomeLabel,
        ivs.z1_tech_vec,
        ivs.z2_fund_vec,
        ivs.z3_chart_vec,
        ivs.z4_sent_vec,
        :archiveJson,
        :reviewDiary,
        systimestamp,
        systimestamp
      from TB_INTEGRATED_VECTOR_STATION ivs
      where ivs.event_id = :sourceEventId
    `,
    {
      learnedAt: new Date(input.learnedAt),
      patternId: truncateText(input.patternId, 64),
      sourceEventId: input.sourceEventId,
      profitRate: input.profitRate,
      outcomeLabel: input.outcomeLabel,
      archiveJson: input.archiveJson,
      reviewDiary: input.reviewDiary
    }
  );

  return input.patternId;
}

async function buildTradeReviewDiary(input: Zone6ReviewInput): Promise<{ diary: string; source: Zone6ReviewSource }> {
  if (input.reviewConfig.provider === "RULE" || input.reviewConfig.baseUrl.length === 0) {
    return {
      diary: buildRuleReviewDiary(input),
      source: "RULE"
    };
  }

  try {
    const llmDiary = await requestReviewDiaryWithLlm(input);
    if (llmDiary) {
      return {
        diary: truncateText(llmDiary, input.reviewConfig.maxChars),
        source: "LLM"
      };
    }
  } catch {
    if (input.reviewConfig.provider === "LLM") {
      throw new Error("zone6 review llm failed");
    }
  }

  return {
    diary: buildRuleReviewDiary(input),
    source: "RULE"
  };
}

async function requestReviewDiaryWithLlm(input: Zone6ReviewInput): Promise<string | null> {
  const normalizedBase = input.reviewConfig.baseUrl.replace(/\/+$/, "");
  const url = `${normalizedBase}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.reviewConfig.timeoutMs);

  try {
    const payload = buildReviewPromptPayload(input);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: input.reviewConfig.model,
        temperature: 0.15,
        max_tokens: 420,
        messages: [
          {
            role: "system",
            content:
              "You are a scalp-trading reviewer. Analyze why this trade succeeded or failed. "
              + "Respond in strict JSON only: {\"diary\":\"...\"}. Keep it factual and actionable."
          },
          {
            role: "user",
            content: JSON.stringify(payload)
          }
        ]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`llm response ${response.status}`);
    }

    const raw = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
    };
    const content = extractLlmContent(raw);
    if (!content) {
      return null;
    }

    const parsed = parseJsonObject(content);
    if (parsed && typeof parsed.diary === "string" && parsed.diary.trim().length > 0) {
      return parsed.diary.trim();
    }

    const fallback = content.trim();
    return fallback.length > 0 ? fallback : null;
  } finally {
    clearTimeout(timer);
  }
}

function buildReviewPromptPayload(input: Zone6ReviewInput): Record<string, unknown> {
  const zoneMetrics = input.archive?.snapshot_state?.zone_metrics ?? {};
  return {
    objective: "매매 결과를 지식화하기 위한 복기",
    trade: {
      trade_id: input.tradeId,
      symbol: input.symbol,
      action: input.action,
      closed_at: input.closedAt,
      realized_pnl_pct: input.realizedPnlPct,
      outcome_label: input.outcomeLabel
    },
    integrated_event: {
      event_id: input.mappedEventId,
      event_ts: input.mappedEventTs,
      map_reason: input.mapReason
    },
    zone_metrics: {
      z1_volume_power: zoneMetrics.z1_volume_power ?? null,
      z2_risk_flag: zoneMetrics.z2_risk_flag ?? null,
      z3_similarity: zoneMetrics.z3_similarity ?? null,
      z4_stage: zoneMetrics.z4_stage ?? null,
      z6_win_rate: zoneMetrics.z6_win_rate ?? null
    },
    vectors: {
      z1: toVectorDigest(input.vectors.z1, input.reviewConfig.vectorHead),
      z2: toVectorDigest(input.vectors.z2, input.reviewConfig.vectorHead),
      z3: toVectorDigest(input.vectors.z3, input.reviewConfig.vectorHead),
      z4: toVectorDigest(input.vectors.z4, input.reviewConfig.vectorHead)
    },
    prior_summary: input.summary
  };
}

function buildRuleReviewDiary(input: Zone6ReviewInput): string {
  const z1 = input.archive?.snapshot_state?.zone_metrics?.z1_volume_power ?? 0;
  const z3 = input.archive?.snapshot_state?.zone_metrics?.z3_similarity ?? 0;
  const z4 = input.archive?.snapshot_state?.zone_metrics?.z4_stage ?? "UNKNOWN";
  const risk = input.archive?.snapshot_state?.zone_metrics?.z2_risk_flag ?? "UNKNOWN";

  const sign = input.realizedPnlPct >= 0 ? "+" : "";
  const outcomeSentence =
    input.outcomeLabel === "SUCCESS"
      ? "진입 타이밍과 수급 추세가 수익 방향과 정합적이었다."
      : input.outcomeLabel === "FAILURE"
        ? "진입 근거 대비 추세 지속성이 약했고 손실 관리가 우선되어야 했다."
        : "명확한 우위 없이 변동성만 소비한 거래였다.";

  return truncateText(
    `[${input.symbol}] ${input.action} 청산 ${sign}${input.realizedPnlPct.toFixed(2)}%. ${outcomeSentence} `
      + `Z1=${z1.toFixed(1)}, Z3=${z3.toFixed(3)}, Z4=${z4}, Risk=${risk}. `
      + `통합 이벤트 ${input.mappedEventId}에 라벨을 기록하고 패턴 라이브러리에 반영.`,
    input.reviewConfig.maxChars
  );
}

function classifyOutcome(pnlPct: number): "SUCCESS" | "FAILURE" | "BREAKEVEN" {
  if (pnlPct > 0) {
    return "SUCCESS";
  }
  if (pnlPct < 0) {
    return "FAILURE";
  }
  return "BREAKEVEN";
}

function resolveAnchorTimestamp(archive: Zone6ArchiveRecord | null, fallbackIso: string): string {
  const fromArchive = archive?.timestamp;
  if (typeof fromArchive === "string" && fromArchive.trim().length > 0) {
    const parsed = new Date(fromArchive);
    if (Number.isFinite(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return fallbackIso;
}

function normalizeAction(raw: string | undefined): "BUY" | "SELL" | "PASS" {
  const value = String(raw ?? "SELL")
    .trim()
    .toUpperCase();
  if (value === "BUY" || value === "SELL" || value === "PASS") {
    return value;
  }
  return "SELL";
}

function normalizeSymbol(raw: string | undefined): string {
  const digits = String(raw ?? "")
    .trim()
    .replace(/[^\d]/g, "");
  if (digits.length < 6) {
    return "UNKNOWN";
  }
  return digits.slice(0, 6);
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

function readReviewConfig(): Zone6ReviewConfig {
  const provider = normalizeReviewProvider(process.env.ZONE6_REVIEW_PROVIDER);
  const baseUrl = normalizeBaseUrl(
    process.env.ZONE6_LLM_BASE_URL ?? process.env.ZONE5_LLM_BASE_URL ?? process.env.LLM_BASE_URL ?? ""
  );
  return {
    provider,
    baseUrl,
    model: String(process.env.ZONE6_LLM_MODEL ?? process.env.ZONE5_LLM_MODEL ?? process.env.LLM_MODEL ?? "openai/gpt-oss-20b").trim(),
    timeoutMs: Math.max(300, Number(process.env.ZONE6_LLM_TIMEOUT_MS ?? 1500)),
    maxChars: Math.max(300, Number(process.env.ZONE6_REVIEW_MAX_CHARS ?? 1600)),
    vectorHead: Math.max(8, Number(process.env.ZONE6_REVIEW_VECTOR_HEAD ?? 64)),
    dbCallTimeoutMs: Math.max(50, Number(process.env.ZONE6_DB_CALL_TIMEOUT_MS ?? 900))
  };
}

function normalizeReviewProvider(raw?: string): Zone6ReviewProvider {
  const normalized = String(raw ?? "AUTO")
    .trim()
    .toUpperCase();
  if (normalized === "LLM" || normalized === "RULE") {
    return normalized;
  }
  return "AUTO";
}

function normalizeBaseUrl(raw?: string): string {
  const value = String(raw ?? "").trim();
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function toIsoLike(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const asText = String(value ?? "").trim();
  if (!asText) {
    return nowIso();
  }
  const parsed = new Date(asText);
  if (Number.isFinite(parsed.getTime())) {
    return parsed.toISOString();
  }
  return asText;
}

function toNumberArray(value: unknown): number[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => toFiniteNumber(item))
      .filter((item): item is number => item !== null);
  }

  if (isTypedArray(value)) {
    return Array.from(value as ArrayLike<number>)
      .map((item) => toFiniteNumber(item))
      .filter((item): item is number => item !== null);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }

    const normalized = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
    return normalized
      .split(",")
      .map((token) => toFiniteNumber(token))
      .filter((item): item is number => item !== null);
  }

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return toNumberArray(value.toString("utf8"));
  }

  if (value && typeof value === "object") {
    const holder = value as { values?: unknown; data?: unknown };
    if (holder.values !== undefined) {
      return toNumberArray(holder.values);
    }
    if (holder.data !== undefined) {
      return toNumberArray(holder.data);
    }
  }

  return [];
}

function isTypedArray(value: unknown): boolean {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function toInt(value: unknown): number | null {
  const num = toFiniteNumber(value);
  if (num === null) {
    return null;
  }
  return Math.trunc(num);
}

function toVectorDigest(values: number[], maxHead: number): { dim: number; l2_norm: number; head: number[] } {
  const head = values.slice(0, Math.max(1, maxHead)).map((value) => Number(value.toFixed(6)));
  const l2 = Math.sqrt(values.reduce((acc, value) => acc + value * value, 0));
  return {
    dim: values.length,
    l2_norm: Number(l2.toFixed(6)),
    head
  };
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
