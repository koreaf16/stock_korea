import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import type { Zone2Fundamental } from "@stock/contracts";
import oracledb from "oracledb";

import { nowIso } from "../../utils.js";

type Zone2Provider = "AUTO" | "PYTHON" | "MOCK";
type Zone2Source = "PYTHON" | "MOCK" | "SAFE_MODE";
type Zone2VectorProvider = "ORACLE" | "DISABLED";

const ISSUE_MAP = {
  cbBw: "최근 3개월 내 CB/BW/유상증자 이력",
  krx: "KRX 투자경고/투자위험/관리종목 지정",
  capital: "완전자본잠식 또는 재무 불건전성 신호",
  safeMode: "vector_api_failure_safe_mode"
} as const;

const FINANCIAL_VECTOR_DIM = Math.max(8, Number(process.env.ZONE2_FINANCIAL_VECTOR_DIM ?? 16));

interface OracleEnv {
  user: string;
  password: string;
  connectString: string;
}

interface Zone2WorkerResult {
  symbol: string;
  risk_flag: "CLEAR" | "BLOCKED";
  issues: string[];
  checked_at?: string;
  has_cb_bw_issue?: boolean;
  has_krx_warning?: boolean;
  has_capital_impairment?: boolean;
  risk_score?: number;
  rule_risk_score?: number;
  vector_risk_score?: number;
  similar_pump_score?: number;
  similar_delist_score?: number;
  disclosure_toxicity_score?: number;
  vector_latency_ms?: number;
  safe_mode?: boolean;
  financial_signature_vector?: unknown;
  disclosure_vector?: unknown;
}

interface Zone2ChecklistFlags {
  hasCbBwIssue: boolean;
  hasKrxWarning: boolean;
  hasCapitalImpairment: boolean;
}

export interface Zone0MarketFlowInput {
  symbol: string;
  foreignNetBuyQty: number;
  institutionalNetBuyQty: number;
  shortBalanceQty: number;
  source: "KOSCOM" | "KRX";
  timestamp: string;
}

interface Zone2CacheEntry {
  value: Zone2Fundamental;
  checkedAtMs: number;
  tickCount: number;
  source: Zone2Source;
  checklist: Zone2ChecklistFlags;
  financialSignatureVector: number[] | null;
}

export interface Zone2StateSnapshot {
  provider: Zone2Provider;
  source: Zone2Source | "NONE";
  refreshTicks: number;
  staleSeconds: number;
  cacheSize: number;
  lastCheckedAt: string | null;
  pythonEnabled: boolean;
  vectorSearchEnabled: boolean;
  vectorProvider: Zone2VectorProvider;
  lastVectorLatencyMs: number | null;
}

export interface Zone2Engine {
  evaluate: (input: {
    symbol: string;
    previous: Zone2Fundamental;
    tickCount: number;
    zone0Fundamental?: Zone0MarketFlowInput | null;
  }) => Promise<Zone2Fundamental>;
  getStateSnapshot: () => Zone2StateSnapshot;
}

interface PythonExecCommand {
  command: string;
  prefixArgs: string[];
}

interface EvaluateByProviderOptions {
  provider: Zone2Provider;
  workerPath: string | null;
  pythonExec: PythonExecCommand | null;
  pythonAvailable: boolean;
}

interface MarketFlowThresholds {
  foreignNetSellBlockThreshold: number;
  institutionNetSellBlockThreshold: number;
  shortBalanceBlockThreshold: number;
}

interface VectorSearchResult {
  ok: boolean;
  reason?: string;
  similarPumpScore: number;
  similarDelistScore: number;
  latencyMs: number;
}

export function createZone2Engine(): Zone2Engine {
  const provider = normalizeProvider(process.env.ZONE2_PROVIDER);
  const refreshTicks = Math.max(1, Number(process.env.ZONE2_REFRESH_TICKS ?? 15));
  const staleSeconds = Math.max(30, Number(process.env.ZONE2_STALE_SECONDS ?? 180));
  const staleMs = staleSeconds * 1_000;
  const forceBlockedSymbols = parseSymbolList(process.env.ZONE2_FORCE_BLOCKED_SYMBOLS);
  const workerPath = resolveZone2WorkerPath();
  const pythonExec = parsePythonCommand(process.env.ZONE2_PYTHON_CMD ?? "python");
  const pythonEnabled = Boolean(provider !== "MOCK" && workerPath && pythonExec && canRunPythonCommand(pythonExec));

  const foreignNetSellBlockThreshold = Math.min(-1, Number(process.env.ZONE2_FOREIGN_NET_SELL_BLOCK_THRESHOLD ?? -200_000));
  const institutionNetSellBlockThreshold = Math.min(
    -1,
    Number(process.env.ZONE2_INSTITUTION_NET_SELL_BLOCK_THRESHOLD ?? -180_000)
  );
  const shortBalanceBlockThreshold = Math.max(1, Number(process.env.ZONE2_SHORT_BALANCE_BLOCK_THRESHOLD ?? 500_000));

  const vectorSearchEnabled = parseBool(process.env.ZONE2_VECTOR_SEARCH_ENABLED, true);
  const vectorTopK = Math.max(1, Math.min(20, Number(process.env.ZONE2_VECTOR_TOP_K ?? 5)));
  const vectorLatencyBudgetMs = Math.max(10, Number(process.env.ZONE2_VECTOR_LATENCY_BUDGET_MS ?? 50));
  const vectorBlockThreshold = clampNumber(Number(process.env.ZONE2_VECTOR_BLOCK_THRESHOLD ?? 0.65), 0.2, 0.95);
  const hybridRuleWeight = clampNumber(Number(process.env.ZONE2_RULE_WEIGHT ?? 0.6), 0.0, 1.0);
  const hybridVectorWeight = clampNumber(Number(process.env.ZONE2_VECTOR_WEIGHT ?? 0.4), 0.0, 1.0);

  const oracleEnv = readOracleEnv();
  let vectorProvider: Zone2VectorProvider = vectorSearchEnabled && oracleEnv ? "ORACLE" : "DISABLED";
  let vectorPool: oracledb.Pool | null = null;

  const cache = new Map<string, Zone2CacheEntry>();
  let lastCheckedAt: string | null = null;
  let lastSource: Zone2Source | "NONE" = "NONE";
  let lastVectorLatencyMs: number | null = null;

  async function evaluate(input: {
    symbol: string;
    previous: Zone2Fundamental;
    tickCount: number;
    zone0Fundamental?: Zone0MarketFlowInput | null;
  }): Promise<Zone2Fundamental> {
    const symbol = normalizeSymbol(input.symbol);
    if (!symbol) {
      const invalid = buildInvalidSymbolEntry(input.symbol, input.tickCount);
      cache.set(String(input.symbol ?? "").trim(), invalid);
      lastCheckedAt = invalid.value.checkedAt;
      lastSource = invalid.source;
      return invalid.value;
    }

    const nowMs = Date.now();
    const cached = cache.get(symbol);
    const marketFlow = normalizeMarketFlowInput(input.zone0Fundamental, symbol);
    const cacheExpired = cached ? isExpired(cached, input.tickCount, nowMs, refreshTicks, staleMs) : true;

    if (cached && !cacheExpired && !marketFlow) {
      return cached.value;
    }

    let nextEntry: Zone2CacheEntry | null = null;

    if (cached && !cacheExpired) {
      nextEntry = cached;
    } else {
      nextEntry = evaluateByProvider(symbol, input.tickCount, {
        provider,
        workerPath,
        pythonExec,
        pythonAvailable: pythonEnabled
      });
    }

    if (!nextEntry) {
      nextEntry = buildSafeModeEntry(symbol, input.tickCount, "zone2_provider_failure");
    }

    if (marketFlow) {
      nextEntry = applyMarketFlowOverlay(nextEntry, marketFlow, input.tickCount, {
        foreignNetSellBlockThreshold,
        institutionNetSellBlockThreshold,
        shortBalanceBlockThreshold
      });
    }
    nextEntry = applyForceBlockOverlay(nextEntry, forceBlockedSymbols, input.tickCount);

    nextEntry = await applyVectorOverlay(nextEntry, symbol, input.tickCount);

    cache.set(symbol, nextEntry);
    lastCheckedAt = nextEntry.value.checkedAt;
    lastSource = nextEntry.source;

    return nextEntry.value;
  }

  async function ensureVectorPool(): Promise<oracledb.Pool | null> {
    if (!vectorSearchEnabled || !oracleEnv) {
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
        queueTimeout: 200
      });
      vectorProvider = "ORACLE";
      return vectorPool;
    } catch (error) {
      vectorProvider = "DISABLED";
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[zone2][vector] oracle pool init failed: ${message}`);
      return null;
    }
  }

  async function runVectorSimilaritySearch(symbol: string, vector: number[]): Promise<VectorSearchResult> {
    if (!vectorSearchEnabled) {
      return {
        ok: true,
        similarPumpScore: 0,
        similarDelistScore: 0,
        latencyMs: 0
      };
    }

    if (!oracleEnv) {
      return {
        ok: false,
        reason: "oracle_env_missing",
        similarPumpScore: 0,
        similarDelistScore: 1,
        latencyMs: 0
      };
    }

    const pool = await ensureVectorPool();
    if (!pool) {
      return {
        ok: false,
        reason: "oracle_pool_unavailable",
        similarPumpScore: 0,
        similarDelistScore: 1,
        latencyMs: 0
      };
    }

    let connection: oracledb.Connection | null = null;
    const startedAt = Date.now();

    try {
      connection = await pool.getConnection();
      connection.callTimeout = vectorLatencyBudgetMs;

      const vectorJson = JSON.stringify(normalizeVector(vector, FINANCIAL_VECTOR_DIM));
      const query = `
        select
          nvl((
            select max(1 - vector_distance(financial_signature_vector, to_vector(:vectorJson), COSINE))
            from (
              select financial_signature_vector
              from TB_ZONE2_FUNDAMENTAL
              where financial_signature_vector is not null
                and risk_flag = 'CLEAR'
                and symbol <> :symbol
              order by vector_distance(financial_signature_vector, to_vector(:vectorJson), COSINE)
              fetch first ${vectorTopK} rows only
            )
          ), 0) as pump_score,
          nvl((
            select max(1 - vector_distance(financial_signature_vector, to_vector(:vectorJson), COSINE))
            from (
              select financial_signature_vector
              from TB_ZONE2_FUNDAMENTAL
              where financial_signature_vector is not null
                and risk_flag = 'BLOCKED'
                and symbol <> :symbol
              order by vector_distance(financial_signature_vector, to_vector(:vectorJson), COSINE)
              fetch first ${vectorTopK} rows only
            )
          ), 0) as delist_score
        from dual
      `;

      const result = await connection.execute(query, { vectorJson, symbol }, { outFormat: oracledb.OUT_FORMAT_OBJECT });
      const latencyMs = Date.now() - startedAt;
      if (latencyMs > vectorLatencyBudgetMs) {
        return {
          ok: false,
          reason: `vector_query_over_budget_${latencyMs}ms`,
          similarPumpScore: 0,
          similarDelistScore: 1,
          latencyMs
        };
      }

      const row = Array.isArray(result.rows) && result.rows.length > 0 ? (result.rows[0] as Record<string, unknown>) : null;
      const pumpScore = clampNumber(toFiniteNumber(row?.PUMP_SCORE, 0), 0, 1);
      const delistScore = clampNumber(toFiniteNumber(row?.DELIST_SCORE, 0), 0, 1);

      return {
        ok: true,
        similarPumpScore: pumpScore,
        similarDelistScore: delistScore,
        latencyMs
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        reason: `vector_query_failed:${message}`,
        similarPumpScore: 0,
        similarDelistScore: 1,
        latencyMs: Date.now() - startedAt
      };
    } finally {
      if (connection) {
        await connection.close();
      }
    }
  }

  async function applyVectorOverlay(baseEntry: Zone2CacheEntry, symbol: string, tickCount: number): Promise<Zone2CacheEntry> {
    const signature = baseEntry.financialSignatureVector;
    if (!vectorSearchEnabled) {
      const nextRiskScore = clampNumber(
        baseEntry.value.ruleRiskScore * hybridRuleWeight + baseEntry.value.vectorRiskScore * hybridVectorWeight,
        0,
        1
      );
      const nextRiskFlag = nextRiskScore >= vectorBlockThreshold || baseEntry.value.riskFlag === "BLOCKED" ? "BLOCKED" : "CLEAR";
      const checkedAt = nowIso();
      return {
        ...baseEntry,
        value: {
          ...baseEntry.value,
          riskScore: nextRiskScore,
          riskFlag: nextRiskFlag,
          checkedAt
        },
        checkedAtMs: Date.parse(checkedAt) || Date.now(),
        tickCount
      };
    }

    if (!signature || signature.length === 0) {
      return buildSafeModeEntry(symbol, tickCount, "missing_financial_signature_vector");
    }

    const vectorResult = await runVectorSimilaritySearch(symbol, signature);
    lastVectorLatencyMs = vectorResult.latencyMs;
    if (!vectorResult.ok) {
      return buildSafeModeEntry(symbol, tickCount, vectorResult.reason ?? "vector_search_failed", baseEntry);
    }

    const vectorRiskScore = clampNumber(vectorResult.similarDelistScore * 0.72 + (1 - vectorResult.similarPumpScore) * 0.28, 0, 1);
    const riskScore = clampNumber(
      baseEntry.value.ruleRiskScore * hybridRuleWeight + vectorRiskScore * hybridVectorWeight,
      0,
      1
    );
    const checkedAt = nowIso();

    const nextIssues = [...baseEntry.value.issues];
    if (vectorResult.similarDelistScore >= 0.86) {
      nextIssues.push("재무 벡터 상장폐지군 고유사도 경고");
    }
    if (vectorResult.similarPumpScore <= 0.25) {
      nextIssues.push("급등 이력군과 재무 지문 불일치");
    }

    const dedupedIssues = dedupeIssues(nextIssues);
    const blocked = baseEntry.value.riskFlag === "BLOCKED" || riskScore >= vectorBlockThreshold || dedupedIssues.length > 0;

    return {
      ...baseEntry,
      value: {
        ...baseEntry.value,
        riskFlag: blocked ? "BLOCKED" : "CLEAR",
        riskScore,
        vectorRiskScore,
        similarPumpScore: vectorResult.similarPumpScore,
        similarDelistScore: vectorResult.similarDelistScore,
        vectorLatencyMs: vectorResult.latencyMs,
        safeMode: false,
        issues: dedupedIssues,
        checkedAt
      },
      checkedAtMs: Date.parse(checkedAt) || Date.now(),
      tickCount
    };
  }

  return {
    evaluate,
    getStateSnapshot: () => ({
      provider,
      source: lastSource,
      refreshTicks,
      staleSeconds,
      cacheSize: cache.size,
      lastCheckedAt,
      pythonEnabled,
      vectorSearchEnabled,
      vectorProvider,
      lastVectorLatencyMs
    })
  };
}

function evaluateByProvider(
  symbol: string,
  tickCount: number,
  options: EvaluateByProviderOptions
): Zone2CacheEntry | null {
  if (options.provider === "MOCK") {
    return evaluateFromMock(symbol, tickCount);
  }
  if (!options.pythonAvailable) {
    return buildSafeModeEntry(symbol, tickCount, "python_worker_unavailable");
  }

  const fromPython = evaluateFromPython(symbol, tickCount, options);
  if (fromPython) {
    return fromPython;
  }

  return buildSafeModeEntry(symbol, tickCount, "python_worker_failed");
}

function evaluateFromPython(
  symbol: string,
  tickCount: number,
  options: Pick<EvaluateByProviderOptions, "workerPath" | "pythonExec">
): Zone2CacheEntry | null {
  if (!options.workerPath || !options.pythonExec) {
    return null;
  }

  const proc = spawnSync(options.pythonExec.command, [...options.pythonExec.prefixArgs, options.workerPath, "--symbol", symbol], {
    encoding: "utf8",
    timeout: 1_800
  });

  if (proc.error || proc.status !== 0 || !proc.stdout) {
    return null;
  }

  let parsed: Zone2WorkerResult;
  try {
    parsed = JSON.parse(proc.stdout) as Zone2WorkerResult;
  } catch {
    return null;
  }

  const checkedAt = parsed.checked_at ?? nowIso();
  const issues = normalizeIssues(parsed.issues);
  const checklist: Zone2ChecklistFlags = {
    hasCbBwIssue: Boolean(parsed.has_cb_bw_issue),
    hasKrxWarning: Boolean(parsed.has_krx_warning),
    hasCapitalImpairment: Boolean(parsed.has_capital_impairment)
  };

  if (checklist.hasCbBwIssue && !hasChecklistIssue(issues, ISSUE_MAP.cbBw)) {
    issues.push(ISSUE_MAP.cbBw);
  }
  if (checklist.hasKrxWarning && !hasChecklistIssue(issues, ISSUE_MAP.krx)) {
    issues.push(ISSUE_MAP.krx);
  }
  if (checklist.hasCapitalImpairment && !hasChecklistIssue(issues, ISSUE_MAP.capital)) {
    issues.push(ISSUE_MAP.capital);
  }

  const blockedByChecklist = checklist.hasCbBwIssue || checklist.hasKrxWarning || checklist.hasCapitalImpairment;
  const ruleRiskScore = clampNumber(toFiniteNumber(parsed.rule_risk_score, blockedByChecklist ? 0.92 : 0.38), 0, 1);
  const vectorRiskScore = clampNumber(toFiniteNumber(parsed.vector_risk_score, 0.5), 0, 1);
  const riskScore = clampNumber(toFiniteNumber(parsed.risk_score, ruleRiskScore), 0, 1);
  const disclosureToxicityScore = clampNumber(toFiniteNumber(parsed.disclosure_toxicity_score, 0.5), 0, 1);
  const similarPumpScore = clampNumber(toFiniteNumber(parsed.similar_pump_score, 0), 0, 1);
  const similarDelistScore = clampNumber(toFiniteNumber(parsed.similar_delist_score, 0), 0, 1);
  const vectorLatencyMs = Math.max(0, toFiniteNumber(parsed.vector_latency_ms, 0));

  const riskFlag =
    parsed.risk_flag === "BLOCKED" || blockedByChecklist || riskScore >= 0.65 || Boolean(parsed.safe_mode) ? "BLOCKED" : "CLEAR";

  const financialSignatureVector = normalizeVectorCandidate(parsed.financial_signature_vector, FINANCIAL_VECTOR_DIM);

  return {
    value: {
      symbol,
      riskFlag,
      riskScore,
      ruleRiskScore,
      vectorRiskScore,
      similarPumpScore,
      similarDelistScore,
      disclosureToxicityScore,
      vectorLatencyMs,
      safeMode: Boolean(parsed.safe_mode),
      issues: dedupeIssues(issues),
      checkedAt
    },
    checkedAtMs: Date.parse(checkedAt) || Date.now(),
    tickCount,
    source: Boolean(parsed.safe_mode) ? "SAFE_MODE" : "PYTHON",
    checklist,
    financialSignatureVector
  };
}

function evaluateFromMock(symbol: string, tickCount: number): Zone2CacheEntry {
  const hashed = symbolHash(symbol);
  const checklist: Zone2ChecklistFlags = {
    hasCbBwIssue: hashed % 23 === 0,
    hasKrxWarning: hashed % 29 === 0,
    hasCapitalImpairment: hashed % 31 === 0
  };

  const issues: string[] = [];
  if (checklist.hasCbBwIssue) {
    issues.push(ISSUE_MAP.cbBw);
  }
  if (checklist.hasKrxWarning) {
    issues.push(ISSUE_MAP.krx);
  }
  if (checklist.hasCapitalImpairment) {
    issues.push(ISSUE_MAP.capital);
  }

  const checkedAt = nowIso();
  const blocked = issues.length > 0;
  const ruleRiskScore = blocked ? 0.9 : 0.35;
  const riskScore = ruleRiskScore;

  return {
    value: {
      symbol,
      riskFlag: blocked ? "BLOCKED" : "CLEAR",
      riskScore,
      ruleRiskScore,
      vectorRiskScore: 0.5,
      similarPumpScore: 0,
      similarDelistScore: 0,
      disclosureToxicityScore: blocked ? 0.75 : 0.35,
      vectorLatencyMs: 0,
      safeMode: false,
      issues,
      checkedAt
    },
    checkedAtMs: Date.parse(checkedAt) || Date.now(),
    tickCount,
    source: "MOCK",
    checklist,
    financialSignatureVector: deterministicFinancialSignature(symbol)
  };
}

function buildInvalidSymbolEntry(rawSymbol: string, tickCount: number): Zone2CacheEntry {
  const checkedAt = nowIso();
  return {
    value: {
      symbol: String(rawSymbol ?? "").trim() || "UNKNOWN",
      riskFlag: "BLOCKED",
      riskScore: 1,
      ruleRiskScore: 1,
      vectorRiskScore: 1,
      similarPumpScore: 0,
      similarDelistScore: 1,
      disclosureToxicityScore: 1,
      vectorLatencyMs: 0,
      safeMode: true,
      issues: ["유효하지 않은 심볼"],
      checkedAt
    },
    checkedAtMs: Date.parse(checkedAt) || Date.now(),
    tickCount,
    source: "SAFE_MODE",
    checklist: {
      hasCbBwIssue: false,
      hasKrxWarning: false,
      hasCapitalImpairment: false
    },
    financialSignatureVector: null
  };
}

function buildSafeModeEntry(symbol: string, tickCount: number, reason: string, baseEntry?: Zone2CacheEntry): Zone2CacheEntry {
  const checkedAt = nowIso();
  const issues = baseEntry ? [...baseEntry.value.issues] : [];
  issues.push(`${ISSUE_MAP.safeMode}:${reason}`);

  return {
    value: {
      symbol,
      riskFlag: "BLOCKED",
      riskScore: 1,
      ruleRiskScore: Math.max(baseEntry?.value.ruleRiskScore ?? 0.8, 0.8),
      vectorRiskScore: 1,
      similarPumpScore: 0,
      similarDelistScore: 1,
      disclosureToxicityScore: Math.max(baseEntry?.value.disclosureToxicityScore ?? 0.7, 0.7),
      vectorLatencyMs: baseEntry?.value.vectorLatencyMs ?? 0,
      safeMode: true,
      issues: dedupeIssues(issues),
      checkedAt
    },
    checkedAtMs: Date.parse(checkedAt) || Date.now(),
    tickCount,
    source: "SAFE_MODE",
    checklist: baseEntry?.checklist ?? {
      hasCbBwIssue: false,
      hasKrxWarning: false,
      hasCapitalImpairment: false
    },
    financialSignatureVector: baseEntry?.financialSignatureVector ?? null
  };
}

function resolveZone2WorkerPath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "services/python/zone2_worker.py"),
    path.resolve(process.cwd(), "../../services/python/zone2_worker.py")
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
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

function isExpired(
  entry: Zone2CacheEntry,
  tickCount: number,
  nowMs: number,
  refreshTicks: number,
  staleMs: number
): boolean {
  return tickCount - entry.tickCount >= refreshTicks || nowMs - entry.checkedAtMs >= staleMs;
}

function normalizeMarketFlowInput(raw: Zone0MarketFlowInput | null | undefined, symbol: string): Zone0MarketFlowInput | null {
  if (!raw) {
    return null;
  }
  if (String(raw.symbol ?? "").trim() !== symbol) {
    return null;
  }
  if (!Number.isFinite(raw.foreignNetBuyQty) || !Number.isFinite(raw.institutionalNetBuyQty) || !Number.isFinite(raw.shortBalanceQty)) {
    return null;
  }

  return {
    symbol,
    foreignNetBuyQty: Number(raw.foreignNetBuyQty),
    institutionalNetBuyQty: Number(raw.institutionalNetBuyQty),
    shortBalanceQty: Number(raw.shortBalanceQty),
    source: raw.source,
    timestamp: raw.timestamp || nowIso()
  };
}

function applyMarketFlowOverlay(
  baseEntry: Zone2CacheEntry,
  marketFlow: Zone0MarketFlowInput,
  tickCount: number,
  thresholds: MarketFlowThresholds
): Zone2CacheEntry {
  const issues = new Set(stripPreviousMarketFlowIssues(baseEntry.value.issues));

  let extraRisk = 0;
  if (marketFlow.foreignNetBuyQty <= thresholds.foreignNetSellBlockThreshold) {
    issues.add(`외국인 순매수 급감(${marketFlow.foreignNetBuyQty.toLocaleString("ko-KR")})`);
    extraRisk += 0.18;
  }
  if (marketFlow.institutionalNetBuyQty <= thresholds.institutionNetSellBlockThreshold) {
    issues.add(`기관 순매수 급감(${marketFlow.institutionalNetBuyQty.toLocaleString("ko-KR")})`);
    extraRisk += 0.14;
  }
  if (marketFlow.shortBalanceQty >= thresholds.shortBalanceBlockThreshold) {
    issues.add(`공매도 잔고 고위험(${marketFlow.shortBalanceQty.toLocaleString("ko-KR")})`);
    extraRisk += 0.2;
  }

  const checkedAt = marketFlow.timestamp || nowIso();
  const nextRiskScore = clampNumber(baseEntry.value.riskScore + extraRisk, 0, 1);
  const dedupedIssues = dedupeIssues([...issues]);

  return {
    ...baseEntry,
    value: {
      ...baseEntry.value,
      riskFlag: dedupedIssues.length > 0 || nextRiskScore >= 0.65 ? "BLOCKED" : baseEntry.value.riskFlag,
      riskScore: nextRiskScore,
      issues: dedupedIssues,
      checkedAt
    },
    checkedAtMs: Date.parse(checkedAt) || Date.now(),
    tickCount
  };
}

function applyForceBlockOverlay(baseEntry: Zone2CacheEntry, forceBlockedSymbols: Set<string>, tickCount: number): Zone2CacheEntry {
  if (!forceBlockedSymbols.has(baseEntry.value.symbol)) {
    return baseEntry;
  }

  const issues = new Set(baseEntry.value.issues);
  issues.add("forced_blocked_symbol");
  const checkedAt = nowIso();

  return {
    ...baseEntry,
    value: {
      ...baseEntry.value,
      riskFlag: "BLOCKED",
      riskScore: 1,
      vectorRiskScore: Math.max(baseEntry.value.vectorRiskScore, 0.8),
      issues: [...issues],
      checkedAt
    },
    checkedAtMs: Date.parse(checkedAt) || Date.now(),
    tickCount
  };
}

function stripPreviousMarketFlowIssues(issues: string[]): string[] {
  return issues.filter(
    (issue) =>
      !issue.startsWith("외국인 순매수 급감(") &&
      !issue.startsWith("기관 순매수 급감(") &&
      !issue.startsWith("공매도 잔고 고위험(")
  );
}

function normalizeProvider(raw?: string): Zone2Provider {
  const normalized = String(raw ?? "AUTO").trim().toUpperCase();
  if (normalized === "PYTHON" || normalized === "MOCK") {
    return normalized;
  }
  return "AUTO";
}

function parseSymbolList(raw?: string): Set<string> {
  if (!raw) {
    return new Set();
  }

  const symbols = raw
    .split(",")
    .map((item) => normalizeSymbol(item))
    .filter(Boolean)
    .map((symbol) => symbol as string);
  return new Set(symbols);
}

function parsePythonCommand(raw: string): PythonExecCommand | null {
  const commandLine = String(raw ?? "").trim();
  if (!commandLine) {
    return null;
  }

  const [command, ...prefixArgs] = commandLine.split(/\s+/);
  if (!command) {
    return null;
  }
  return { command, prefixArgs };
}

function canRunPythonCommand(exec: PythonExecCommand): boolean {
  const probe = spawnSync(exec.command, [...exec.prefixArgs, "--version"], {
    encoding: "utf8",
    timeout: 1_200
  });

  if (probe.error) {
    return false;
  }
  return probe.status === 0;
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

function normalizeIssues(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const issue = String(item ?? "").trim();
    if (!issue || seen.has(issue)) {
      continue;
    }
    seen.add(issue);
    deduped.push(issue);
  }
  return deduped;
}

function dedupeIssues(issues: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const issue of issues) {
    const normalized = String(issue ?? "").trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(normalized);
  }
  return deduped;
}

function hasChecklistIssue(issues: string[], target: string): boolean {
  return issues.some((issue) => issue.includes(target));
}

function symbolHash(symbol: string): number {
  let hash = 7;
  for (const ch of symbol) {
    hash = (hash * 31 + ch.charCodeAt(0)) % 1_000_003;
  }
  return hash;
}

function deterministicFinancialSignature(symbol: string): number[] {
  const hashed = symbolHash(symbol);
  const vector: number[] = [];
  for (let idx = 0; idx < FINANCIAL_VECTOR_DIM; idx += 1) {
    const value = ((hashed * (idx + 11)) % 997) / 997;
    vector.push(value * 2 - 1);
  }
  return normalizeVector(vector, FINANCIAL_VECTOR_DIM);
}

function normalizeVectorCandidate(raw: unknown, expectedDim: number): number[] | null {
  if (!Array.isArray(raw)) {
    return null;
  }
  const parsed = raw
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value))
    .map((value) => Number(value));
  if (parsed.length === 0) {
    return null;
  }
  return normalizeVector(parsed, expectedDim);
}

function normalizeVector(values: number[], expectedDim: number): number[] {
  const out = [...values];
  if (out.length < expectedDim) {
    out.push(...new Array(expectedDim - out.length).fill(0));
  } else if (out.length > expectedDim) {
    out.splice(expectedDim);
  }

  const normSq = out.reduce((sum, value) => sum + value * value, 0);
  if (normSq <= 0) {
    return out;
  }
  const norm = Math.sqrt(normSq);
  return out.map((value) => Number((value / norm).toFixed(6)));
}

function normalizeSymbol(raw: string): string | null {
  const digits = String(raw ?? "").trim().replace(/[^\d]/g, "");
  if (digits.length < 6) {
    return null;
  }
  return digits.slice(0, 6);
}

function toFiniteNumber(raw: unknown, fallback: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}
