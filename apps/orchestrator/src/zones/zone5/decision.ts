import type {
  DashboardSnapshot,
  DecisionAction,
  Zone3PatternMatch,
  Zone4Madness,
  Zone5Decision,
  Zone6HistoryFeedback
} from "@stock/contracts";
import oracledb from "oracledb";

import { clamp, nowIso, shortId } from "../../utils.js";

type Zone5Provider = "AUTO" | "LLM" | "RULE";
type Zone5Source = "LLM" | "RULE";
type Zone5VectorProvider = "ORACLE" | "DISABLED";

interface DecisionInput {
  snapshot: DashboardSnapshot;
  pattern: Zone3PatternMatch;
  madness: Zone4Madness;
  history: Zone6HistoryFeedback;
}

interface Zone5RuleConfig {
  minCash: number;
  maxWeightPct: number;
  minPatternSimilarity: number;
  requiredStage: Zone4Madness["stage"];
  z1SpikeThreshold: number;
  z1VolumePowerThreshold: number;
  z1OrderImbalanceMax: number;
  collectionWeightPct: number;
  collectionTargetLabeledRows: number;
}

interface Zone5VectorConfig {
  enabled: boolean;
  topK: number;
  minSimilarRows: number;
  minLabeledRows: number;
  minWeightedSimilarity: number;
  minWinRate: number;
  latencyBudgetMs: number;
  weightZ1: number;
  weightZ2: number;
  weightZ3: number;
  weightZ4: number;
}

interface OracleEnv {
  user: string;
  password: string;
  connectString: string;
}

interface LlmDecisionPayload {
  action?: unknown;
  confidence_score?: unknown;
  confidence?: unknown;
  reasoning?: unknown;
  suggested_weight_pct?: unknown;
  target_price?: unknown;
  stop_price?: unknown;
}

interface LlmZeroShotPayload {
  enter?: unknown;
  confidence_score?: unknown;
  confidence?: unknown;
  reasoning?: unknown;
}

interface SimilarityMatch {
  eventId: string;
  symbol: string;
  eventTs: string;
  profitRate: number | null;
  simZ1: number;
  simZ2: number;
  simZ3: number;
  simZ4: number;
  weightedSimilarity: number;
  newsWeightedScore: number;
}

interface SimilarityContext {
  coldStart: boolean;
  reason: string;
  provider: Zone5VectorProvider;
  querySymbol: string;
  totalRows: number;
  similarRows: number;
  labeledRows: number;
  avgWeightedSimilarity: number;
  winRate: number;
  expectedProfitRate: number;
  latencyMs: number;
  topMatch: SimilarityMatch | null;
  matches: SimilarityMatch[];
  z4ExpectedProfitRate: number;
  z4TopCases: SimilarityMatch[];
}

interface IntegratedQueryVectorBundle {
  z1: number[];
  z2: number[];
  z3: number[];
  z4: number[];
}

interface ColdStartLlmResult {
  enter: boolean;
  confidence: number;
  reasoning: string;
}

export interface Zone5ActionOrderTemplate {
  decisionId: string;
  targetSymbol: string;
  action: DecisionAction;
  orderType: "MARKET";
  suggestedWeightPct: number;
  targetPrice?: number;
  stopPrice?: number;
  confidenceScore: number;
}

export interface Zone5StateArchive {
  decision_id: string;
  timestamp: string;
  target_symbol: string;
  action: DecisionAction;
  confidence_score: number;
  reasoning: string;
  snapshot_state: {
    account_balance: number;
    total_assets: number;
    zone_metrics: {
      z1_volume_power: number;
      z2_risk_flag: string;
      z3_similarity: number;
      z4_stage: string;
      z6_win_rate: number;
    };
  };
  similarity_context?: {
    cold_start: boolean;
    reason: string;
    similar_rows: number;
    labeled_rows: number;
    avg_weighted_similarity: number;
    win_rate: number;
    expected_profit_rate: number;
    z4_expected_profit_rate: number;
  };
}

export interface Zone5StateSnapshot {
  provider: Zone5Provider;
  source: Zone5Source | "NONE";
  vectorProvider: Zone5VectorProvider;
  vectorSearchEnabled: boolean;
  llmBaseUrl: string;
  llmModel: string;
  lastDecisionId: string | null;
  lastAction: DecisionAction | null;
  lastConfidence: number | null;
  lastReasoning: string | null;
  lastError: string | null;
  lastSimilarityRows: number | null;
  lastLabeledRows: number | null;
  lastSimilarityLatencyMs: number | null;
  lastColdStartReason: string | null;
  lastActionOrder: Zone5ActionOrderTemplate | null;
  lastArchiveJson: string | null;
}

export interface Zone5Engine {
  evaluate: (input: DecisionInput) => Promise<Zone5Decision>;
  getStateSnapshot: () => Zone5StateSnapshot;
}

export function createZone5Engine(): Zone5Engine {
  const provider = normalizeProvider(process.env.ZONE5_PROVIDER);
  const llmBaseUrl = normalizeBaseUrl(process.env.ZONE5_LLM_BASE_URL ?? process.env.LLM_BASE_URL);
  const llmModel = String(process.env.ZONE5_LLM_MODEL ?? process.env.LLM_MODEL ?? "openai/gpt-oss-20b").trim();
  const llmTimeoutMs = Math.max(300, Number(process.env.ZONE5_LLM_TIMEOUT_MS ?? 1200));
  const ruleConfig: Zone5RuleConfig = {
    minCash: Math.max(0, Number(process.env.ZONE5_MIN_CASH ?? 1_000_000)),
    maxWeightPct: Math.max(1, Number(process.env.ZONE5_MAX_WEIGHT ?? 20)),
    minPatternSimilarity: clamp(Number(process.env.ZONE5_MIN_PATTERN_SIMILARITY ?? 0.9), 0, 1),
    requiredStage: normalizeStage(process.env.ZONE5_REQUIRED_MADNESS_STAGE),
    z1SpikeThreshold: Math.max(20, Number(process.env.ZONE5_COLD_Z1_SPIKE_THRESHOLD ?? 180)),
    z1VolumePowerThreshold: Math.max(20, Number(process.env.ZONE5_COLD_Z1_VOLUME_POWER_THRESHOLD ?? 130)),
    z1OrderImbalanceMax: Math.max(0.2, Number(process.env.ZONE5_COLD_Z1_IMBALANCE_MAX ?? 1.45)),
    collectionWeightPct: Math.max(1, Number(process.env.ZONE5_COLLECTION_WEIGHT_PCT ?? 5)),
    collectionTargetLabeledRows: Math.max(10, Number(process.env.ZONE5_COLLECTION_TARGET_LABELED_ROWS ?? 120))
  };
  const vectorConfig = createVectorConfig();
  const oracleEnv = readOracleEnv();
  let vectorProvider: Zone5VectorProvider = vectorConfig.enabled && oracleEnv ? "ORACLE" : "DISABLED";
  let vectorPool: oracledb.Pool | null = null;

  let lastSource: Zone5Source | "NONE" = "NONE";
  let lastDecision: Zone5Decision | null = null;
  let lastError: string | null = null;
  let lastSimilarityRows: number | null = null;
  let lastLabeledRows: number | null = null;
  let lastSimilarityLatencyMs: number | null = null;
  let lastColdStartReason: string | null = null;
  let lastActionOrder: Zone5ActionOrderTemplate | null = null;
  let lastArchiveJson: string | null = null;

  async function ensureVectorPool(): Promise<oracledb.Pool | null> {
    if (!vectorConfig.enabled || !oracleEnv) {
      vectorProvider = "DISABLED";
      return null;
    }

    if (vectorPool) {
      return vectorPool;
    }

    try {
      vectorPool = await oracledb.createPool({
        user: oracleEnv.user,
        password: oracleEnv.password,
        connectString: oracleEnv.connectString,
        poolMin: 0,
        poolMax: 4,
        poolIncrement: 1,
        queueTimeout: 400
      });
      vectorProvider = "ORACLE";
      return vectorPool;
    } catch (error) {
      vectorProvider = "DISABLED";
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[zone5][vector] oracle pool init failed: ${message}`);
      return null;
    }
  }

  async function runSimilaritySearch(input: DecisionInput): Promise<SimilarityContext> {
    const symbol = normalizeSymbol(input.snapshot.targetSymbol);

    if (!vectorConfig.enabled) {
      return buildColdSimilarityContext("vector_search_disabled", symbol, "DISABLED");
    }
    if (!oracleEnv) {
      return buildColdSimilarityContext("oracle_env_missing", symbol, "DISABLED");
    }

    const pool = await ensureVectorPool();
    if (!pool) {
      return buildColdSimilarityContext("oracle_pool_unavailable", symbol, "DISABLED");
    }

    const queryVectors = buildIntegratedQueryVectors(input);
    const startedAt = Date.now();
    let connection: oracledb.Connection | null = null;

    try {
      connection = await pool.getConnection();
      connection.callTimeout = vectorConfig.latencyBudgetMs;

      const z1Vec = JSON.stringify(queryVectors.z1);
      const z2Vec = JSON.stringify(queryVectors.z2);
      const z3Vec = JSON.stringify(queryVectors.z3);
      const z4Vec = JSON.stringify(queryVectors.z4);
      const topK = Math.max(1, vectorConfig.topK);

      const query = `
        select
          event_id,
          symbol,
          event_ts,
          profit_rate,
          (1 - vector_distance(z1_tech_vec, to_vector(:z1Vec), COSINE)) as sim_z1,
          (1 - vector_distance(z2_fund_vec, to_vector(:z2Vec), COSINE)) as sim_z2,
          (1 - vector_distance(z3_chart_vec, to_vector(:z3Vec), COSINE)) as sim_z3,
          (1 - vector_distance(z4_sent_vec, to_vector(:z4Vec), COSINE)) as sim_z4,
          (
            (1 - vector_distance(z4_sent_vec, to_vector(:z4Vec), COSINE))
            * (1 + greatest(nvl(profit_rate, 0), 0) / 100)
          ) as news_weighted_score,
          (
            (1 - vector_distance(z1_tech_vec, to_vector(:z1Vec), COSINE)) * :w1 +
            (1 - vector_distance(z2_fund_vec, to_vector(:z2Vec), COSINE)) * :w2 +
            (1 - vector_distance(z3_chart_vec, to_vector(:z3Vec), COSINE)) * :w3 +
            (1 - vector_distance(z4_sent_vec, to_vector(:z4Vec), COSINE)) * :w4
          ) as weighted_similarity
        from TB_INTEGRATED_VECTOR_STATION
        where symbol <> :symbol
        order by (
          vector_distance(z1_tech_vec, to_vector(:z1Vec), COSINE) * :w1 +
          vector_distance(z2_fund_vec, to_vector(:z2Vec), COSINE) * :w2 +
          vector_distance(z3_chart_vec, to_vector(:z3Vec), COSINE) * :w3 +
          vector_distance(z4_sent_vec, to_vector(:z4Vec), COSINE) * :w4
        ) asc
        fetch first ${topK} rows only
      `;

      const result = await connection.execute(
        query,
        {
          symbol,
          z1Vec,
          z2Vec,
          z3Vec,
          z4Vec,
          w1: vectorConfig.weightZ1,
          w2: vectorConfig.weightZ2,
          w3: vectorConfig.weightZ3,
          w4: vectorConfig.weightZ4
        },
        { outFormat: oracledb.OUT_FORMAT_OBJECT }
      );

      const latencyMs = Date.now() - startedAt;
      if (latencyMs > vectorConfig.latencyBudgetMs) {
        return buildColdSimilarityContext(`vector_query_over_budget_${latencyMs}ms`, symbol, vectorProvider, latencyMs);
      }

      const rows = Array.isArray(result.rows) ? (result.rows as Array<Record<string, unknown>>) : [];
      const matches = rows.map((row) => toSimilarityMatch(row)).filter((row): row is SimilarityMatch => row !== null);
      const similarRows = matches.filter((row) => row.weightedSimilarity >= vectorConfig.minWeightedSimilarity);
      const labeledRows = similarRows.filter((row) => row.profitRate !== null);
      const avgSimilarity = averageOf(similarRows.map((row) => row.weightedSimilarity));
      const expectedProfitRate = averageOf(labeledRows.map((row) => row.profitRate ?? 0));
      const z4TopCases = labeledRows
        .filter((row) => row.simZ4 >= vectorConfig.minWeightedSimilarity * 0.8)
        .sort((left, right) => right.newsWeightedScore - left.newsWeightedScore)
        .slice(0, Math.max(3, Math.min(8, topK)));
      const z4ExpectedProfitRate = averageOf(z4TopCases.map((row) => row.profitRate ?? 0));
      const winRate =
        labeledRows.length > 0
          ? labeledRows.filter((row) => (row.profitRate ?? 0) > 0).length / labeledRows.length
          : 0;

      const coldReason = decideColdStartReason(similarRows.length, labeledRows.length, avgSimilarity, winRate, vectorConfig);
      return {
        coldStart: coldReason !== null,
        reason: coldReason ?? "vector_ready",
        provider: vectorProvider,
        querySymbol: symbol,
        totalRows: matches.length,
        similarRows: similarRows.length,
        labeledRows: labeledRows.length,
        avgWeightedSimilarity: Number(avgSimilarity.toFixed(4)),
        winRate: Number(winRate.toFixed(4)),
        expectedProfitRate: Number(expectedProfitRate.toFixed(4)),
        z4ExpectedProfitRate: Number(z4ExpectedProfitRate.toFixed(4)),
        z4TopCases,
        latencyMs,
        topMatch: similarRows[0] ?? matches[0] ?? null,
        matches: similarRows.length > 0 ? similarRows : matches
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return buildColdSimilarityContext(`vector_query_failed:${message}`, symbol, vectorProvider, Date.now() - startedAt);
    } finally {
      if (connection) {
        await connection.close();
      }
    }
  }

  async function evaluate(input: DecisionInput): Promise<Zone5Decision> {
    const safetyDecision = buildSafetyDecision(input, ruleConfig);
    const fallback = buildRuleDecision(input, ruleConfig);
    let finalDecision = safetyDecision ?? fallback;
    let source: Zone5Source = "RULE";
    let error: string | null = null;
    let similarityContext: SimilarityContext = buildColdSimilarityContext("vector_not_checked", normalizeSymbol(input.snapshot.targetSymbol), vectorProvider);

    if (!safetyDecision) {
      similarityContext = await runSimilaritySearch(input);

      if (similarityContext.coldStart) {
        try {
          const coldDecision = await buildColdStartDecision(
            input,
            ruleConfig,
            fallback,
            similarityContext,
            provider,
            llmBaseUrl,
            llmModel,
            llmTimeoutMs
          );
          finalDecision = coldDecision.decision;
          if (coldDecision.usedLlm) {
            source = "LLM";
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : "unknown cold-start llm error";
          if (provider === "LLM") {
            throw err;
          }
          error = message;
          finalDecision = buildColdStartHeuristicDecision(input, ruleConfig, fallback, similarityContext, null);
        }
      } else {
        finalDecision = buildVectorHybridDecision(input, fallback, ruleConfig, similarityContext);
      }
    }

    if (!similarityContext.coldStart && (provider === "LLM" || provider === "AUTO")) {
      try {
        const llmDecision = await evaluateWithLlm(
          input,
          finalDecision,
          llmBaseUrl,
          llmModel,
          llmTimeoutMs,
          ruleConfig,
          similarityContext
        );
        if (llmDecision) {
          finalDecision = llmDecision;
          source = "LLM";
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown llm error";
        if (provider === "LLM") {
          throw err;
        }
        error = message;
      }
    }

    const actionOrder = buildActionOrderTemplate(finalDecision, input.snapshot.targetSymbol);
    const archive = buildStateArchive(finalDecision, input, similarityContext);

    lastSource = source;
    lastDecision = finalDecision;
    lastError = error;
    lastSimilarityRows = similarityContext.similarRows;
    lastLabeledRows = similarityContext.labeledRows;
    lastSimilarityLatencyMs = similarityContext.latencyMs;
    lastColdStartReason = similarityContext.coldStart ? similarityContext.reason : null;
    lastActionOrder = actionOrder;
    lastArchiveJson = JSON.stringify(archive);

    return finalDecision;
  }

  return {
    evaluate,
    getStateSnapshot: () => ({
      provider,
      source: lastSource,
      vectorProvider,
      vectorSearchEnabled: vectorConfig.enabled,
      llmBaseUrl,
      llmModel,
      lastDecisionId: lastDecision?.decisionId ?? null,
      lastAction: lastDecision?.action ?? null,
      lastConfidence: lastDecision?.confidenceScore ?? null,
      lastReasoning: lastDecision?.reasoning ?? null,
      lastError,
      lastSimilarityRows,
      lastLabeledRows,
      lastSimilarityLatencyMs,
      lastColdStartReason,
      lastActionOrder,
      lastArchiveJson
    })
  };
}

function buildSafetyDecision(input: DecisionInput, config: Zone5RuleConfig): Zone5Decision | null {
  const { snapshot } = input;
  const now = nowIso();
  const hasPosition = snapshot.positions.some((position) => position.symbol === snapshot.targetSymbol);

  if (snapshot.killSwitchOn) {
    return {
      decisionId: shortId("DEC"),
      action: hasPosition ? "SELL" : "PASS",
      confidenceScore: 0.99,
      reasoning: hasPosition
        ? "Master Kill-Switch 활성화. 보유 포지션 우선 청산."
        : "Master Kill-Switch 활성화 상태. 신규 진입 차단.",
      suggestedWeightPct: hasPosition ? 100 : 0,
      generatedAt: now
    };
  }

  if (snapshot.fundamental.riskFlag === "BLOCKED") {
    return {
      decisionId: shortId("DEC"),
      action: "PASS",
      confidenceScore: 0.97,
      reasoning: `Zone2 차단 조건 감지 (${snapshot.fundamental.issues.join(", ") || "리스크 플래그"}).`,
      suggestedWeightPct: 0,
      generatedAt: now
    };
  }

  if (snapshot.account.cashAvailable < config.minCash) {
    return {
      decisionId: shortId("DEC"),
      action: "PASS",
      confidenceScore: 0.94,
      reasoning: "예수금 부족으로 신규 진입 보류.",
      suggestedWeightPct: 0,
      generatedAt: now
    };
  }

  return null;
}

function buildRuleDecision(input: DecisionInput, config: Zone5RuleConfig): Zone5Decision {
  const { snapshot, pattern, madness, history } = input;
  const now = nowIso();
  const hasPosition = snapshot.positions.some((position) => position.symbol === snapshot.targetSymbol);

  let action: DecisionAction = "PASS";
  let confidence = 0.52;
  let reasoning = "관망. 아직 승률 우위가 확인되지 않음.";
  let suggestedWeightPct = 0;
  let targetPrice: number | undefined;
  let stopPrice: number | undefined;

  if (snapshot.killSwitchOn) {
    action = hasPosition ? "SELL" : "PASS";
    confidence = 0.99;
    reasoning = hasPosition
      ? "Master Kill-Switch 활성화. 보유 포지션 우선 청산."
      : "Master Kill-Switch 활성화 상태. 신규 진입 차단.";
    suggestedWeightPct = hasPosition ? 100 : 0;
  } else if (snapshot.fundamental.riskFlag === "BLOCKED") {
    action = "PASS";
    confidence = 0.97;
    reasoning = `Zone2 차단 조건 감지 (${snapshot.fundamental.issues.join(", ") || "리스크 플래그"}).`;
    suggestedWeightPct = 0;
  } else if (snapshot.account.cashAvailable < config.minCash) {
    action = "PASS";
    confidence = 0.94;
    reasoning = "예수금 부족으로 신규 진입 보류.";
    suggestedWeightPct = 0;
  } else if (
    pattern.klass === "CLASS_A" &&
    pattern.similarity >= config.minPatternSimilarity &&
    madness.stage === config.requiredStage
  ) {
    const historyPenalty = history.winRate < 0.4 ? 0.55 : 1;
    const rawWeight = history.winRate * config.maxWeightPct * 1.3 * historyPenalty;
    suggestedWeightPct = Math.max(5, Math.min(config.maxWeightPct, Math.round(rawWeight)));
    action = "BUY";
    confidence = clamp(0.58 + pattern.similarity * 0.33 + history.winRate * 0.08, 0, 0.98);
    reasoning =
      "Zone3 CLASS_A 고유사도 + Zone4 단계 조건 충족. Zone6 승률/예수금 기반으로 진입 비중 산출.";
    targetPrice = Math.round(snapshot.technical.resistance * 1.012);
    stopPrice = Math.round(snapshot.technical.support * 0.995);
  } else if (madness.stage === "STAGE_3" && hasPosition) {
    action = "SELL";
    confidence = 0.83;
    reasoning = "Zone4 STAGE_3 진입. 변동성 급증 리스크로 보유 비중 축소.";
    suggestedWeightPct = 50;
  }

  return {
    decisionId: shortId("DEC"),
    action,
    confidenceScore: Number(confidence.toFixed(2)),
    reasoning,
    targetPrice,
    stopPrice,
    suggestedWeightPct,
    generatedAt: now
  };
}

async function buildColdStartDecision(
  input: DecisionInput,
  config: Zone5RuleConfig,
  fallback: Zone5Decision,
  similarity: SimilarityContext,
  provider: Zone5Provider,
  llmBaseUrl: string,
  llmModel: string,
  timeoutMs: number
): Promise<{ decision: Zone5Decision; usedLlm: boolean }> {
  if (provider !== "LLM" && provider !== "AUTO") {
    return {
      decision: buildColdStartHeuristicDecision(input, config, fallback, similarity, null),
      usedLlm: false
    };
  }

  const llmResult = await evaluateColdStartZeroShotWithLlm(input, similarity, llmBaseUrl, llmModel, timeoutMs);
  if (!llmResult) {
    if (provider === "LLM") {
      throw new Error("cold_start_zero_shot_empty_response");
    }
    return {
      decision: buildColdStartHeuristicDecision(input, config, fallback, similarity, null),
      usedLlm: false
    };
  }

  return {
    decision: buildColdStartHeuristicDecision(input, config, fallback, similarity, llmResult),
    usedLlm: true
  };
}

function buildColdStartHeuristicDecision(
  input: DecisionInput,
  config: Zone5RuleConfig,
  fallback: Zone5Decision,
  similarity: SimilarityContext,
  llmResult: ColdStartLlmResult | null
): Zone5Decision {
  const { snapshot, pattern, madness } = input;
  const now = nowIso();
  const hasPosition = snapshot.positions.some((position) => position.symbol === snapshot.targetSymbol);
  const z1Gate = checkZ1Gate(snapshot, config);

  if (hasPosition && madness.stage === "STAGE_3") {
    return {
      decisionId: shortId("DEC"),
      action: "SELL",
      confidenceScore: 0.84,
      reasoning: "Cold Start 구간에서 STAGE_3 과열 감지. 데이터 품질 보호를 위해 포지션 청산.",
      suggestedWeightPct: 100,
      generatedAt: now
    };
  }

  if (!z1Gate.passed) {
    return {
      decisionId: shortId("DEC"),
      action: "PASS",
      confidenceScore: 0.73,
      reasoning: `Cold Start(${similarity.reason}) - Z1 수급 임계치 미충족 (${z1Gate.reason}).`,
      suggestedWeightPct: 0,
      generatedAt: now
    };
  }

  const llmEnter = llmResult?.enter ?? false;
  const llmConfidence = llmResult?.confidence ?? 0.5;
  const heuristicEnter = pattern.klass === "CLASS_A" && pattern.similarity >= config.minPatternSimilarity * 0.92 && madness.stage !== "STAGE_1";
  const shouldEnter = llmResult ? llmEnter : heuristicEnter;

  if (!shouldEnter || hasPosition) {
    return {
      decisionId: shortId("DEC"),
      action: "PASS",
      confidenceScore: Number(clamp((llmResult ? llmConfidence : 0.64), 0, 1).toFixed(2)),
      reasoning: llmResult
        ? `Cold Start Zero-shot 결과: 보수적 관망 (${llmResult.reasoning})`
        : `Cold Start(${similarity.reason}) - 유사 데이터 부족으로 신호 검증 대기. 기존 rule=${fallback.action}`,
      suggestedWeightPct: 0,
      generatedAt: now
    };
  }

  const weight = Math.max(1, Math.min(config.maxWeightPct, config.collectionWeightPct));
  return {
    decisionId: shortId("DEC"),
    action: "BUY",
    confidenceScore: Number(clamp((llmResult ? llmConfidence : 0.67), 0, 0.92).toFixed(2)),
    reasoning: llmResult
      ? `Cold Start Zero-shot 진입 승인. 수익 극대화보다 고해상도 학습 데이터 수집 목적의 소량 모의매매 (${llmResult.reasoning}).`
      : "Cold Start 휴리스틱 진입. 수익보다 데이터 수집 우선 원칙으로 소량 모의매매 실행.",
    targetPrice: Math.round(snapshot.technical.resistance * 1.008),
    stopPrice: Math.round(snapshot.technical.support * 0.996),
    suggestedWeightPct: weight,
    generatedAt: now
  };
}

function buildVectorHybridDecision(
  input: DecisionInput,
  fallback: Zone5Decision,
  config: Zone5RuleConfig,
  similarity: SimilarityContext
): Zone5Decision {
  const { snapshot, pattern, madness } = input;
  const hasPosition = snapshot.positions.some((position) => position.symbol === snapshot.targetSymbol);
  const z1Gate = checkZ1Gate(snapshot, config);

  if (hasPosition && (madness.stage === "STAGE_3" || similarity.winRate < 0.35 || similarity.expectedProfitRate <= -0.8)) {
    return {
      decisionId: shortId("DEC"),
      action: "SELL",
      confidenceScore: 0.82,
      reasoning: "통합 벡터 유사 사례의 기대값 약화 또는 과열 구간 진입으로 보유 포지션 축소/청산.",
      suggestedWeightPct: madness.stage === "STAGE_3" ? 100 : 60,
      generatedAt: nowIso()
    };
  }

  const patternPass = pattern.klass === "CLASS_A" && pattern.similarity >= config.minPatternSimilarity;
  const similarityPass = similarity.avgWeightedSimilarity >= 0.64 && similarity.winRate >= 0.5;
  const expectedProfitPass = similarity.expectedProfitRate >= -0.2;

  if (z1Gate.passed && patternPass && similarityPass && expectedProfitPass) {
    const score = clamp(
      similarity.avgWeightedSimilarity * 0.45 + similarity.winRate * 0.35 + clamp((similarity.expectedProfitRate + 2) / 4, 0, 1) * 0.2,
      0,
      1
    );
    const dynamicWeight = Math.round(clamp(score * config.maxWeightPct, 1, config.maxWeightPct));
    const collectionMode = similarity.labeledRows < config.collectionTargetLabeledRows;
    const weightCap = collectionMode ? Math.max(1, config.collectionWeightPct) : config.maxWeightPct;
    const suggestedWeightPct = Math.min(dynamicWeight, weightCap);

    return {
      decisionId: shortId("DEC"),
      action: "BUY",
      confidenceScore: Number(clamp(0.56 + score * 0.36, 0, 0.97).toFixed(2)),
      reasoning: collectionMode
        ? "통합 벡터 유사도/승률 조건 충족. 초기 구간이므로 데이터 수집 중심 소량 모의매매 진입."
        : "통합 벡터 유사도 합계와 과거 수익률 기대값이 진입 조건을 충족.",
      targetPrice: Math.round(snapshot.technical.resistance * 1.012),
      stopPrice: Math.round(snapshot.technical.support * 0.995),
      suggestedWeightPct,
      generatedAt: nowIso()
    };
  }

  return {
    ...fallback,
    reasoning: `${fallback.reasoning} | 유사도합계=${similarity.avgWeightedSimilarity.toFixed(3)}, winRate=${similarity.winRate.toFixed(3)}, expectedPnL=${similarity.expectedProfitRate.toFixed(3)}`
  };
}

async function evaluateWithLlm(
  input: DecisionInput,
  fallback: Zone5Decision,
  llmBaseUrl: string,
  llmModel: string,
  timeoutMs: number,
  config: Zone5RuleConfig,
  similarity: SimilarityContext
): Promise<Zone5Decision | null> {
  const url = `${llmBaseUrl}/chat/completions`;
  const payload = buildLlmInputPayload(input, config, fallback, similarity);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: llmModel,
        temperature: 0.1,
        max_tokens: 260,
        messages: [
          {
            role: "system",
            content:
              "You are Zone5 master decision agent. "
              + "Use weighted vector similarity context first, then risk constraints. "
              + "If confidence is low, choose PASS. "
              + "Respond with strict JSON only: action, confidence_score, reasoning, suggested_weight_pct, target_price, stop_price."
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

    const parsed = parseJsonObject(content) as LlmDecisionPayload | null;
    if (!parsed) {
      return null;
    }

    return sanitizeLlmDecision(parsed, fallback, config.maxWeightPct);
  } finally {
    clearTimeout(timer);
  }
}

async function evaluateColdStartZeroShotWithLlm(
  input: DecisionInput,
  similarity: SimilarityContext,
  llmBaseUrl: string,
  llmModel: string,
  timeoutMs: number
): Promise<ColdStartLlmResult | null> {
  const url = `${llmBaseUrl}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const payload = {
      objective: "profit보다 고해상도 학습 데이터 수집이 우선인 소량 모의매매",
      cold_start_reason: similarity.reason,
      target_symbol: input.snapshot.targetSymbol,
      zone1_gate: {
        spike_ratio: input.snapshot.technical.spikeRatio,
        volume_power: input.snapshot.technical.volumePower,
        order_imbalance: input.snapshot.technical.orderImbalance,
        support: input.snapshot.technical.support,
        resistance: input.snapshot.technical.resistance
      },
      zone3_chart: {
        klass: input.pattern.klass,
        similarity: input.pattern.similarity,
        matched_pattern_id: input.pattern.matchedPatternId
      },
      zone4_news_signal: {
        stage: input.madness.stage,
        score: input.madness.score,
        sentiment: input.madness.sentiment,
        news_velocity: input.madness.newsVelocity
      }
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: llmModel,
        temperature: 0.1,
        max_tokens: 220,
        messages: [
          {
            role: "system",
            content:
              "You are a zero-shot scalp trading analyst in cold-start mode with no reliable historical labels. "
              + "Judge only whether to enter a tiny paper-trade for data collection. "
              + "Respond with strict JSON only: enter(boolean), confidence_score(0~1), reasoning."
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

    const parsed = parseJsonObject(content) as LlmZeroShotPayload | null;
    if (!parsed) {
      return null;
    }

    const enter = asBoolean(parsed.enter);
    if (enter === null) {
      return null;
    }

    const confidenceRaw = asNumber(parsed.confidence_score) ?? asNumber(parsed.confidence) ?? 0.5;
    const reasoning = parseReasoning(parsed.reasoning) ?? "cold-start zero-shot result";
    return {
      enter,
      confidence: clamp(confidenceRaw, 0, 1),
      reasoning
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildLlmInputPayload(
  input: DecisionInput,
  config: Zone5RuleConfig,
  fallback: Zone5Decision,
  similarity: SimilarityContext
): Record<string, unknown> {
  const { snapshot, pattern, madness, history } = input;

  return {
    constraints: {
      min_cash: config.minCash,
      max_weight_pct: config.maxWeightPct,
      min_pattern_similarity: config.minPatternSimilarity,
      required_stage: config.requiredStage
    },
    account: {
      cash_available: snapshot.account.cashAvailable,
      total_assets: snapshot.account.totalAssets
    },
    target_symbol: snapshot.targetSymbol,
    zone1: {
      volume_power: snapshot.technical.volumePower,
      spike_ratio: snapshot.technical.spikeRatio,
      order_imbalance: snapshot.technical.orderImbalance,
      support: snapshot.technical.support,
      resistance: snapshot.technical.resistance
    },
    zone2: {
      risk_flag: snapshot.fundamental.riskFlag,
      issues: snapshot.fundamental.issues
    },
    zone3: {
      klass: pattern.klass,
      similarity: pattern.similarity
    },
    zone4: {
      stage: madness.stage,
      score: madness.score,
      sentiment: madness.sentiment
    },
    zone6: {
      win_rate: history.winRate,
      summary: history.summary
    },
    similarity_context: {
      cold_start: similarity.coldStart,
      reason: similarity.reason,
      similar_rows: similarity.similarRows,
      labeled_rows: similarity.labeledRows,
      avg_weighted_similarity: similarity.avgWeightedSimilarity,
      win_rate: similarity.winRate,
      expected_profit_rate: similarity.expectedProfitRate,
      z4_expected_profit_rate: similarity.z4ExpectedProfitRate,
      z4_top_cases: similarity.z4TopCases,
      top_match: similarity.topMatch
    },
    fallback_decision: fallback
  };
}

function sanitizeLlmDecision(
  parsed: LlmDecisionPayload,
  fallback: Zone5Decision,
  maxWeightPct: number
): Zone5Decision {
  const action = parseDecisionAction(parsed.action) ?? fallback.action;
  const confidenceRaw = asNumber(parsed.confidence_score) ?? asNumber(parsed.confidence) ?? fallback.confidenceScore;
  const confidence = Number(clamp(confidenceRaw, 0, 1).toFixed(2));
  const weightRaw = asNumber(parsed.suggested_weight_pct) ?? fallback.suggestedWeightPct;
  const suggestedWeightPct = action === "PASS" ? 0 : Math.round(clamp(weightRaw, 0, maxWeightPct));
  const reasoning = parseReasoning(parsed.reasoning) ?? fallback.reasoning;
  const targetPrice = asPositiveInteger(parsed.target_price) ?? fallback.targetPrice;
  const stopPrice = asPositiveInteger(parsed.stop_price) ?? fallback.stopPrice;

  return {
    decisionId: shortId("DEC"),
    action,
    confidenceScore: confidence,
    reasoning,
    targetPrice,
    stopPrice,
    suggestedWeightPct,
    generatedAt: nowIso()
  };
}

function buildActionOrderTemplate(decision: Zone5Decision, targetSymbol: string): Zone5ActionOrderTemplate {
  return {
    decisionId: decision.decisionId,
    targetSymbol,
    action: decision.action,
    orderType: "MARKET",
    suggestedWeightPct: decision.suggestedWeightPct,
    targetPrice: decision.targetPrice,
    stopPrice: decision.stopPrice,
    confidenceScore: decision.confidenceScore
  };
}

function buildStateArchive(decision: Zone5Decision, input: DecisionInput, similarity: SimilarityContext): Zone5StateArchive {
  const { snapshot, pattern, madness, history } = input;
  return {
    decision_id: decision.decisionId,
    timestamp: decision.generatedAt,
    target_symbol: snapshot.targetSymbol,
    action: decision.action,
    confidence_score: decision.confidenceScore,
    reasoning: decision.reasoning,
    snapshot_state: {
      account_balance: snapshot.account.cashAvailable,
      total_assets: snapshot.account.totalAssets,
      zone_metrics: {
        z1_volume_power: snapshot.technical.volumePower,
        z2_risk_flag: snapshot.fundamental.riskFlag,
        z3_similarity: pattern.similarity,
        z4_stage: madness.stage,
        z6_win_rate: history.winRate
      }
    },
    similarity_context: {
      cold_start: similarity.coldStart,
      reason: similarity.reason,
      similar_rows: similarity.similarRows,
      labeled_rows: similarity.labeledRows,
      avg_weighted_similarity: similarity.avgWeightedSimilarity,
      win_rate: similarity.winRate,
      expected_profit_rate: similarity.expectedProfitRate,
      z4_expected_profit_rate: similarity.z4ExpectedProfitRate
    }
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

function parseDecisionAction(value: unknown): DecisionAction | null {
  if (typeof value !== "string") {
    return null;
  }
  const action = value.trim().toUpperCase();
  if (action === "BUY" || action === "SELL" || action === "PASS") {
    return action;
  }
  return null;
}

function parseReasoning(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const reasoning = value.trim();
  return reasoning.length > 0 ? reasoning.slice(0, 500) : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asPositiveInteger(value: unknown): number | undefined {
  const num = asNumber(value);
  if (num === null || num <= 0) {
    return undefined;
  }
  return Math.round(num);
}

function asBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (value === 1) {
      return true;
    }
    if (value === 0) {
      return false;
    }
    return null;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "y") {
      return true;
    }
    if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "n") {
      return false;
    }
  }
  return null;
}

function createVectorConfig(): Zone5VectorConfig {
  const enabled = parseBool(process.env.ZONE5_VECTOR_SEARCH_ENABLED, true);
  const topK = Math.max(1, Math.min(100, Number(process.env.ZONE5_VECTOR_TOP_K ?? 24)));
  const minSimilarRows = Math.max(1, Number(process.env.ZONE5_VECTOR_MIN_SIMILAR_ROWS ?? 6));
  const minLabeledRows = Math.max(1, Number(process.env.ZONE5_VECTOR_MIN_LABELED_ROWS ?? 4));
  const minWeightedSimilarity = clamp(Number(process.env.ZONE5_VECTOR_MIN_WEIGHTED_SIMILARITY ?? 0.62), 0, 1);
  const minWinRate = clamp(Number(process.env.ZONE5_VECTOR_MIN_WIN_RATE ?? 0.5), 0, 1);
  const latencyBudgetMs = Math.max(10, Number(process.env.ZONE5_VECTOR_LATENCY_BUDGET_MS ?? 80));

  const rawWeightZ1 = Math.max(0, Number(process.env.ZONE5_VEC_WEIGHT_Z1 ?? 0.3));
  const rawWeightZ2 = Math.max(0, Number(process.env.ZONE5_VEC_WEIGHT_Z2 ?? 0.2));
  const rawWeightZ3 = Math.max(0, Number(process.env.ZONE5_VEC_WEIGHT_Z3 ?? 0.3));
  const rawWeightZ4 = Math.max(0, Number(process.env.ZONE5_VEC_WEIGHT_Z4 ?? 0.2));
  const sum = rawWeightZ1 + rawWeightZ2 + rawWeightZ3 + rawWeightZ4;
  const divisor = sum > 0 ? sum : 1;

  return {
    enabled,
    topK,
    minSimilarRows,
    minLabeledRows,
    minWeightedSimilarity,
    minWinRate,
    latencyBudgetMs,
    weightZ1: rawWeightZ1 / divisor,
    weightZ2: rawWeightZ2 / divisor,
    weightZ3: rawWeightZ3 / divisor,
    weightZ4: rawWeightZ4 / divisor
  };
}

function buildColdSimilarityContext(
  reason: string,
  querySymbol: string,
  provider: Zone5VectorProvider,
  latencyMs = 0
): SimilarityContext {
  return {
    coldStart: true,
    reason,
    provider,
    querySymbol,
    totalRows: 0,
    similarRows: 0,
    labeledRows: 0,
    avgWeightedSimilarity: 0,
    winRate: 0,
    expectedProfitRate: 0,
    z4ExpectedProfitRate: 0,
    latencyMs,
    topMatch: null,
    matches: [],
    z4TopCases: []
  };
}

function buildIntegratedQueryVectors(input: DecisionInput): IntegratedQueryVectorBundle {
  return {
    z1: buildZ1QueryVector(input.snapshot),
    z2: buildZ2QueryVector(input.snapshot),
    z3: buildZ3QueryVector(input.snapshot, input.pattern),
    z4: buildZ4QueryVector(input.snapshot, input.pattern, input.madness)
  };
}

function buildZ1QueryVector(snapshot: DashboardSnapshot): number[] {
  const tickPrice = Math.max(1, snapshot.tick.price);
  const spreadPct = (snapshot.technical.resistance - snapshot.technical.support) / tickPrice;
  const features = [
    clamp(snapshot.technical.volumePower / 250, -2, 2),
    clamp(snapshot.technical.spikeRatio / 500, -2, 3),
    clamp(snapshot.technical.maDivergence / 3, -2, 2),
    clamp((1 / Math.max(0.05, snapshot.technical.orderImbalance)) - 1, -2, 2),
    clamp(spreadPct * 25, -2, 2),
    clamp(snapshot.tick.volume / 500_000, -2, 2),
    clamp((snapshot.tick.bidDepth - snapshot.tick.askDepth) / Math.max(1, snapshot.tick.bidDepth + snapshot.tick.askDepth), -1, 1),
    clamp((snapshot.tick.price - snapshot.technical.support) / Math.max(1, snapshot.technical.resistance - snapshot.technical.support), -1, 2)
  ];
  return buildDeterministicVector(features, 128, 17);
}

function buildZ2QueryVector(snapshot: DashboardSnapshot): number[] {
  const issuesCount = snapshot.fundamental.issues.length;
  const features = [
    snapshot.fundamental.riskFlag === "BLOCKED" ? 1 : -1,
    clamp(snapshot.fundamental.riskScore * 2 - 1, -1, 1),
    clamp(snapshot.fundamental.ruleRiskScore * 2 - 1, -1, 1),
    clamp(snapshot.fundamental.vectorRiskScore * 2 - 1, -1, 1),
    clamp(snapshot.fundamental.similarPumpScore * 2 - 1, -1, 1),
    clamp(snapshot.fundamental.similarDelistScore * 2 - 1, -1, 1),
    clamp(snapshot.fundamental.disclosureToxicityScore * 2 - 1, -1, 1),
    snapshot.fundamental.safeMode ? 1 : -1,
    clamp(issuesCount / 8, 0, 2)
  ];
  return buildDeterministicVector(features, 256, 29);
}

function buildZ3QueryVector(snapshot: DashboardSnapshot, pattern: Zone3PatternMatch): number[] {
  const features = [
    pattern.klass === "CLASS_A" ? 1 : -1,
    pattern.klass === "CLASS_B" ? 1 : -1,
    pattern.klass === "CLASS_C" ? 1 : -1,
    clamp(pattern.similarity * 2 - 1, -1, 1),
    clamp(snapshot.technical.spikeRatio / 500, -2, 3),
    clamp(snapshot.technical.maDivergence / 3, -2, 2),
    clamp(snapshot.technical.volumePower / 250, -2, 2),
    clamp((snapshot.tick.price - snapshot.technical.support) / Math.max(1, snapshot.technical.resistance - snapshot.technical.support), -1, 2)
  ];
  return buildDeterministicVector(features, 512, 43);
}

function buildZ4QueryVector(snapshot: DashboardSnapshot, pattern: Zone3PatternMatch, madness: Zone4Madness): number[] {
  const stageVal = madness.stage === "STAGE_3" ? 1 : madness.stage === "STAGE_2" ? 0 : -1;
  const features = [
    clamp(madness.score / 100, 0, 1),
    stageVal,
    clamp(madness.sentiment, -1, 1),
    clamp(madness.newsVelocity / 100, 0, 2),
    pattern.klass === "CLASS_A" ? 1 : -1,
    clamp(pattern.similarity * 2 - 1, -1, 1),
    clamp(snapshot.technical.spikeRatio / 500, -2, 3),
    clamp(snapshot.technical.volumePower / 250, -2, 2),
    clamp(snapshot.account.realizedPnlPct / 20, -2, 2)
  ];
  return buildDeterministicVector(features, 768, 61);
}

function buildDeterministicVector(features: number[], dim: number, seed: number): number[] {
  const sanitized = features.length > 0 ? features : [0];
  const values: number[] = [];

  for (let idx = 0; idx < dim; idx += 1) {
    const a = sanitized[idx % sanitized.length] ?? 0;
    const b = sanitized[(idx * 7 + 3) % sanitized.length] ?? 0;
    const c = sanitized[(idx * 11 + 5) % sanitized.length] ?? 0;
    const harmonic = Math.sin((idx + 1) * (seed + 1) * 0.013) * 0.09 + Math.cos((idx + 1) * (seed + 1) * 0.021) * 0.07;
    values.push(a * 0.58 + b * 0.27 + c * 0.15 + harmonic);
  }

  const normSq = values.reduce((acc, value) => acc + value * value, 0);
  if (normSq <= 0) {
    return new Array(dim).fill(0);
  }

  const norm = Math.sqrt(normSq);
  return values.map((value) => Number((value / norm).toFixed(6)));
}

function toSimilarityMatch(row: Record<string, unknown>): SimilarityMatch | null {
  const eventId = String(row.EVENT_ID ?? "").trim();
  if (!eventId) {
    return null;
  }

  const symbol = String(row.SYMBOL ?? "").trim() || "UNKNOWN";
  const eventTs = String(row.EVENT_TS ?? "");
  const profitRaw = asNumber(row.PROFIT_RATE);
  return {
    eventId,
    symbol,
    eventTs,
    profitRate: profitRaw === null ? null : profitRaw,
    simZ1: clamp(asNumber(row.SIM_Z1) ?? 0, -1, 1),
    simZ2: clamp(asNumber(row.SIM_Z2) ?? 0, -1, 1),
    simZ3: clamp(asNumber(row.SIM_Z3) ?? 0, -1, 1),
    simZ4: clamp(asNumber(row.SIM_Z4) ?? 0, -1, 1),
    weightedSimilarity: clamp(asNumber(row.WEIGHTED_SIMILARITY) ?? 0, -1, 1),
    newsWeightedScore: Math.max(0, asNumber(row.NEWS_WEIGHTED_SCORE) ?? 0)
  };
}

function averageOf(values: number[]): number {
  if (values.length <= 0) {
    return 0;
  }
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function decideColdStartReason(
  similarRows: number,
  labeledRows: number,
  avgSimilarity: number,
  winRate: number,
  vectorConfig: Zone5VectorConfig
): string | null {
  if (similarRows < vectorConfig.minSimilarRows) {
    return "similar_rows_insufficient";
  }
  if (labeledRows < vectorConfig.minLabeledRows) {
    return "labeled_rows_insufficient";
  }
  if (avgSimilarity < vectorConfig.minWeightedSimilarity) {
    return "weighted_similarity_low";
  }
  if (labeledRows > 0 && winRate < vectorConfig.minWinRate) {
    return "win_rate_uncertain";
  }
  return null;
}

function checkZ1Gate(snapshot: DashboardSnapshot, config: Zone5RuleConfig): { passed: boolean; reason: string } {
  const failures: string[] = [];
  if (snapshot.technical.spikeRatio < config.z1SpikeThreshold) {
    failures.push(`spikeRatio ${snapshot.technical.spikeRatio.toFixed(1)} < ${config.z1SpikeThreshold.toFixed(1)}`);
  }
  if (snapshot.technical.volumePower < config.z1VolumePowerThreshold) {
    failures.push(`volumePower ${snapshot.technical.volumePower.toFixed(1)} < ${config.z1VolumePowerThreshold.toFixed(1)}`);
  }
  if (snapshot.technical.orderImbalance > config.z1OrderImbalanceMax) {
    failures.push(`orderImbalance ${snapshot.technical.orderImbalance.toFixed(2)} > ${config.z1OrderImbalanceMax.toFixed(2)}`);
  }

  return {
    passed: failures.length === 0,
    reason: failures.length === 0 ? "passed" : failures.join(", ")
  };
}

function normalizeProvider(raw?: string): Zone5Provider {
  const normalized = String(raw ?? "AUTO")
    .trim()
    .toUpperCase();
  if (normalized === "LLM" || normalized === "RULE") {
    return normalized;
  }
  return "AUTO";
}

function normalizeStage(raw?: string): Zone4Madness["stage"] {
  const normalized = String(raw ?? "STAGE_2")
    .trim()
    .toUpperCase();

  if (normalized === "STAGE_1" || normalized === "STAGE_2" || normalized === "STAGE_3") {
    return normalized;
  }

  return "STAGE_2";
}

function normalizeBaseUrl(raw?: string): string {
  const value = String(raw ?? "http://192.168.0.3:11434/v1").trim();
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return fallback;
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

function normalizeSymbol(raw: string): string {
  const digits = String(raw ?? "")
    .trim()
    .replace(/[^\d]/g, "");
  if (digits.length < 6) {
    return "UNKNOWN";
  }
  return digits.slice(0, 6);
}
