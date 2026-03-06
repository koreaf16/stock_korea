import type {
  DashboardSnapshot,
  DecisionAction,
  Zone3PatternMatch,
  Zone4Madness,
  Zone5Decision,
  Zone6HistoryFeedback
} from "@stock/contracts";

import { clamp, nowIso, shortId } from "../../utils.js";

type Zone5Provider = "AUTO" | "LLM" | "RULE";
type Zone5Source = "LLM" | "RULE";

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
}

export interface Zone5StateSnapshot {
  provider: Zone5Provider;
  source: Zone5Source | "NONE";
  llmBaseUrl: string;
  llmModel: string;
  lastDecisionId: string | null;
  lastAction: DecisionAction | null;
  lastConfidence: number | null;
  lastReasoning: string | null;
  lastError: string | null;
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
    requiredStage: normalizeStage(process.env.ZONE5_REQUIRED_MADNESS_STAGE)
  };

  let lastSource: Zone5Source | "NONE" = "NONE";
  let lastDecision: Zone5Decision | null = null;
  let lastError: string | null = null;
  let lastActionOrder: Zone5ActionOrderTemplate | null = null;
  let lastArchiveJson: string | null = null;

  async function evaluate(input: DecisionInput): Promise<Zone5Decision> {
    const fallback = buildRuleDecision(input, ruleConfig);
    let finalDecision = fallback;
    let source: Zone5Source = "RULE";
    let error: string | null = null;

    if (provider === "LLM" || provider === "AUTO") {
      try {
        const llmDecision = await evaluateWithLlm(input, fallback, llmBaseUrl, llmModel, llmTimeoutMs, ruleConfig);
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
    const archive = buildStateArchive(finalDecision, input);

    lastSource = source;
    lastDecision = finalDecision;
    lastError = error;
    lastActionOrder = actionOrder;
    lastArchiveJson = JSON.stringify(archive);

    return finalDecision;
  }

  return {
    evaluate,
    getStateSnapshot: () => ({
      provider,
      source: lastSource,
      llmBaseUrl,
      llmModel,
      lastDecisionId: lastDecision?.decisionId ?? null,
      lastAction: lastDecision?.action ?? null,
      lastConfidence: lastDecision?.confidenceScore ?? null,
      lastReasoning: lastDecision?.reasoning ?? null,
      lastError,
      lastActionOrder,
      lastArchiveJson
    })
  };
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

async function evaluateWithLlm(
  input: DecisionInput,
  fallback: Zone5Decision,
  llmBaseUrl: string,
  llmModel: string,
  timeoutMs: number,
  config: Zone5RuleConfig
): Promise<Zone5Decision | null> {
  const url = `${llmBaseUrl}/chat/completions`;
  const payload = buildLlmInputPayload(input, config, fallback);
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
              "You are Zone5 master decision agent. Respond with strict JSON only: action, confidence_score, reasoning, suggested_weight_pct, target_price, stop_price."
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

function buildLlmInputPayload(
  input: DecisionInput,
  config: Zone5RuleConfig,
  fallback: Zone5Decision
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

function buildStateArchive(decision: Zone5Decision, input: DecisionInput): Zone5StateArchive {
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
