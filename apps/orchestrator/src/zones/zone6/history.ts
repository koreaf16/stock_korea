import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import type { Zone3PatternMatch, Zone4Madness, Zone6HistoryFeedback } from "@stock/contracts";

import { clamp, nowIso, shortId } from "../../utils.js";

type Zone6Provider = "AUTO" | "PYTHON" | "LOCAL_VECTOR";
type Zone6Source = "PYTHON" | "LOCAL_VECTOR";

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
  target_symbol?: string;
  action?: string;
  snapshot_state?: {
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
  vectorDim: number;
  maxRecords: number;
  minSimilarity: number;
  recordCount: number;
  lastSimilarTradeId: string | null;
  lastWinRate: number | null;
  lastSummary: string | null;
  lastUpdatedAt: string | null;
  lastIngestedTradeId: string | null;
  lastIngestedPnlPct: number | null;
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

  const records: Zone6MemoryRecord[] = [];

  let lastSource: Zone6Source | "NONE" = "NONE";
  let lastSimilarTradeId: string | null = null;
  let lastWinRate: number | null = null;
  let lastSummary: string | null = null;
  let lastUpdatedAt: string | null = null;
  let lastIngestedTradeId: string | null = null;
  let lastIngestedPnlPct: number | null = null;
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
  }

  return {
    evaluate,
    recordTradeOutcome,
    getStateSnapshot: () => ({
      provider,
      source: lastSource,
      vectorDim,
      maxRecords,
      minSimilarity,
      recordCount: records.length,
      lastSimilarTradeId,
      lastWinRate,
      lastSummary,
      lastUpdatedAt,
      lastIngestedTradeId,
      lastIngestedPnlPct,
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
  const baseline = buildBaselineFeedback(symbol, pattern, madness);
  if (records.length === 0) {
    return {
      source: "LOCAL_VECTOR",
      output: baseline
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
      output: baseline
    };
  }

  const weightSum = topCandidates.reduce((acc, candidate) => acc + Math.max(0, candidate.similarity), 0);
  if (weightSum <= 0) {
    return {
      source: "LOCAL_VECTOR",
      output: baseline
    };
  }

  const weightedWins = topCandidates.reduce((acc, candidate) => {
    const weight = Math.max(0, candidate.similarity);
    return acc + (candidate.record.isWin ? weight : 0);
  }, 0);
  const weightedWinRate = weightedWins / weightSum;
  const avgPnl =
    topCandidates.reduce((acc, candidate) => acc + candidate.record.realizedPnlPct, 0) / Math.max(1, topCandidates.length);
  const winRate = clamp(weightedWinRate * 0.75 + baseline.winRate * 0.25, 0.1, 0.9);

  const best = topCandidates[0];
  if (!best) {
    return {
      source: "LOCAL_VECTOR",
      output: baseline
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

function buildBaselineFeedback(symbol: string, pattern: Zone3PatternMatch, madness: Zone4Madness): Zone6HistoryFeedback {
  const baseWinRate = pattern.klass === "CLASS_A" ? 0.62 : pattern.klass === "CLASS_C" ? 0.38 : 0.5;
  const stagePenalty = madness.stage === "STAGE_3" ? -0.08 : madness.stage === "STAGE_2" ? 0.03 : 0;
  const similarityBoost = (pattern.similarity - 0.5) * 0.22;
  const winRate = clamp(baseWinRate + stagePenalty + similarityBoost, 0.1, 0.9);
  const key = hashToken(`${symbol}:${pattern.klass}:${madness.stage}`).toString(36).slice(0, 6).toUpperCase();

  const summary =
    pattern.klass === "CLASS_A"
      ? "과거 급등 유사 패턴 우위. 과열 전환(STAGE_3) 시 추격 매수는 축소 권장."
      : pattern.klass === "CLASS_C"
        ? "과거 급락 유사 패턴 우세. 반등 확인 전 보수적 접근 권장."
        : "뚜렷한 우위 패턴 없음. 거래대금/호가 균형 재확인 필요.";

  return {
    similarTradeId: `HIST_BASE_${key}`,
    winRate: Number(winRate.toFixed(2)),
    summary,
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
