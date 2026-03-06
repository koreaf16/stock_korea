import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import type { PatternClass, Zone0Tick, Zone1Technical, Zone3PatternMatch } from "@stock/contracts";

import { clamp, nowIso } from "../../utils.js";

type Zone3Provider = "AUTO" | "PYTHON" | "LOCAL_VECTOR";
type Zone3Source = "PYTHON" | "LOCAL_VECTOR";

interface Candle {
  minuteKey: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface ReferencePattern {
  id: string;
  klass: PatternClass;
  vector: number[];
}

interface PythonWorkerResult {
  klass: PatternClass;
  similarity: number;
  matched_pattern_id: string;
}

interface Zone3EngineResult {
  output: Zone3PatternMatch;
  source: Zone3Source;
}

export interface Zone3StateSnapshot {
  provider: Zone3Provider;
  source: Zone3Source | "NONE";
  vectorDim: number;
  candleWindowMinutes: number;
  candleCount: number;
  lastClass: PatternClass | null;
  lastSimilarity: number | null;
  lastUpdatedAt: string | null;
}

export interface Zone3Engine {
  evaluate: (input: { symbol: string; tick: Zone0Tick; technical: Zone1Technical }) => Zone3PatternMatch;
  getStateSnapshot: () => Zone3StateSnapshot;
}

export function createZone3Engine(): Zone3Engine {
  const provider = normalizeProvider(process.env.ZONE3_PROVIDER);
  const vectorDim = Math.max(128, Number(process.env.ZONE3_VECTOR_DIM ?? 1_024));
  const candleWindowMinutes = Math.max(10, Number(process.env.ZONE3_CANDLE_WINDOW_MINUTES ?? 30));
  const minCandles = Math.max(3, Number(process.env.ZONE3_MIN_CANDLES ?? 8));

  const references = buildReferenceLibrary(vectorDim);
  const candles: Candle[] = [];

  let lastSource: Zone3Source | "NONE" = "NONE";
  let lastClass: PatternClass | null = null;
  let lastSimilarity: number | null = null;
  let lastUpdatedAt: string | null = null;

  function evaluate(input: { symbol: string; tick: Zone0Tick; technical: Zone1Technical }): Zone3PatternMatch {
    upsertCandle(candles, input.tick, candleWindowMinutes);

    const local = evaluateWithLocalVector(input, candles, references, vectorDim, minCandles);
    let finalResult: Zone3EngineResult = local;

    if (provider === "PYTHON" || provider === "AUTO") {
      const pythonResult = evaluateWithPython(input, local);
      if (pythonResult) {
        finalResult = pythonResult;
      }
    }

    lastSource = finalResult.source;
    lastClass = finalResult.output.klass;
    lastSimilarity = finalResult.output.similarity;
    lastUpdatedAt = finalResult.output.updatedAt;

    return finalResult.output;
  }

  return {
    evaluate,
    getStateSnapshot: () => ({
      provider,
      source: lastSource,
      vectorDim,
      candleWindowMinutes,
      candleCount: candles.length,
      lastClass,
      lastSimilarity,
      lastUpdatedAt
    })
  };
}

function evaluateWithLocalVector(
  input: { symbol: string; technical: Zone1Technical },
  candles: Candle[],
  references: ReferencePattern[],
  vectorDim: number,
  minCandles: number
): Zone3EngineResult {
  const now = nowIso();
  if (candles.length < minCandles) {
    return {
      source: "LOCAL_VECTOR",
      output: {
        klass: "CLASS_B",
        similarity: 0.5,
        matchedPatternId: "PATTERN_WARMUP",
        updatedAt: now
      }
    };
  }

  const vector = vectorizeCandles(candles, vectorDim);
  let best: { klass: PatternClass; id: string; sim: number } = {
    klass: "CLASS_B",
    id: "CLASS_B_RANGE",
    sim: -1
  };

  for (const ref of references) {
    const sim = cosineSimilarity(vector, ref.vector);
    if (sim > best.sim) {
      best = {
        klass: ref.klass,
        id: ref.id,
        sim
      };
    }
  }

  const technicalNudge = computeTechnicalNudge(input.technical, best.klass);
  const similarity = clamp((best.sim + 1) / 2 + technicalNudge, 0, 0.99);

  return {
    source: "LOCAL_VECTOR",
    output: {
      klass: best.klass,
      similarity: Number(similarity.toFixed(2)),
      matchedPatternId: best.id,
      updatedAt: now
    }
  };
}

function evaluateWithPython(
  input: { symbol: string; technical: Zone1Technical },
  localResult: Zone3EngineResult
): Zone3EngineResult | null {
  const scriptPath = resolveZone3WorkerPath();
  if (!scriptPath) {
    return null;
  }

  const rawCmd = (process.env.ZONE3_PYTHON_CMD ?? "python").trim();
  const [pythonCmd, ...prefixArgs] = rawCmd.split(/\s+/);
  if (!pythonCmd) {
    return null;
  }

  const proc = spawnSync(
    pythonCmd,
    [
      ...prefixArgs,
      scriptPath,
      "--symbol",
      input.symbol,
      "--spike-ratio",
      input.technical.spikeRatio.toString(),
      "--volume-power",
      input.technical.volumePower.toString(),
      "--local-similarity",
      localResult.output.similarity.toString()
    ],
    {
      encoding: "utf8",
      timeout: 1_500
    }
  );

  if (proc.error || proc.status !== 0 || !proc.stdout) {
    return null;
  }

  let parsed: PythonWorkerResult;
  try {
    parsed = JSON.parse(proc.stdout) as PythonWorkerResult;
  } catch {
    return null;
  }

  return {
    source: "PYTHON",
    output: {
      klass: parsed.klass,
      similarity: Number(clamp(parsed.similarity, 0, 0.99).toFixed(2)),
      matchedPatternId: parsed.matched_pattern_id,
      updatedAt: nowIso()
    }
  };
}

function upsertCandle(candles: Candle[], tick: Zone0Tick, candleWindowMinutes: number): void {
  const minuteKey = tick.timestamp.slice(0, 16);
  const last = candles[candles.length - 1];

  if (!last || last.minuteKey !== minuteKey) {
    candles.push({
      minuteKey,
      open: tick.price,
      high: tick.price,
      low: tick.price,
      close: tick.price,
      volume: tick.volume
    });
  } else {
    last.high = Math.max(last.high, tick.price);
    last.low = Math.min(last.low, tick.price);
    last.close = tick.price;
    last.volume += tick.volume;
  }

  while (candles.length > candleWindowMinutes) {
    candles.shift();
  }
}

function vectorizeCandles(candles: Candle[], vectorDim: number): number[] {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);

  const base = closes[0] ?? 1;
  const maxVol = Math.max(1, ...volumes);

  const closeNorm = closes.map((price) => (price - base) / Math.max(1, base));
  const volumeNorm = volumes.map((vol) => vol / maxVol);

  const vector: number[] = [];
  const srcLen = closes.length;
  const denom = Math.max(1, vectorDim - 1);

  for (let i = 0; i < vectorDim; i += 1) {
    const t = (i / denom) * Math.max(0, srcLen - 1);
    const left = Math.floor(t);
    const right = Math.min(srcLen - 1, Math.ceil(t));
    const alpha = t - left;

    const pLeft = closeNorm[left] ?? 0;
    const pRight = closeNorm[right] ?? pLeft;
    const vLeft = volumeNorm[left] ?? 0;
    const vRight = volumeNorm[right] ?? vLeft;

    const priceFeature = lerp(pLeft, pRight, alpha);
    const volumeFeature = lerp(vLeft, vRight, alpha) - 0.5;
    vector.push(priceFeature * 0.82 + volumeFeature * 0.18);
  }

  return normalizeVector(vector);
}

function buildReferenceLibrary(vectorDim: number): ReferencePattern[] {
  return [
    {
      id: "CLASS_A_BREAKOUT_01",
      klass: "CLASS_A",
      vector: makeArchetype(vectorDim, "A", 1)
    },
    {
      id: "CLASS_A_BREAKOUT_02",
      klass: "CLASS_A",
      vector: makeArchetype(vectorDim, "A", 2)
    },
    {
      id: "CLASS_B_RANGE_01",
      klass: "CLASS_B",
      vector: makeArchetype(vectorDim, "B", 1)
    },
    {
      id: "CLASS_B_RANGE_02",
      klass: "CLASS_B",
      vector: makeArchetype(vectorDim, "B", 2)
    },
    {
      id: "CLASS_C_DUMP_01",
      klass: "CLASS_C",
      vector: makeArchetype(vectorDim, "C", 1)
    },
    {
      id: "CLASS_C_DUMP_02",
      klass: "CLASS_C",
      vector: makeArchetype(vectorDim, "C", 2)
    }
  ];
}

function makeArchetype(vectorDim: number, klass: "A" | "B" | "C", variant: number): number[] {
  const out: number[] = [];
  const denom = Math.max(1, vectorDim - 1);

  for (let i = 0; i < vectorDim; i += 1) {
    const x = i / denom;
    let value = 0;

    if (klass === "A") {
      const slope = variant === 1 ? 0.15 : 0.11;
      const burst = variant === 1 ? Math.max(0, x - 0.72) * 0.55 : Math.max(0, x - 0.65) * 0.48;
      value = -0.03 + slope * x + burst;
    } else if (klass === "B") {
      const amp = variant === 1 ? 0.05 : 0.035;
      value = amp * Math.sin(x * Math.PI * (variant === 1 ? 4 : 5));
    } else {
      const slope = variant === 1 ? -0.18 : -0.13;
      const dump = variant === 1 ? Math.max(0, x - 0.55) * -0.38 : Math.max(0, x - 0.62) * -0.31;
      value = 0.02 + slope * x + dump;
    }

    out.push(value);
  }

  return normalizeVector(out);
}

function computeTechnicalNudge(technical: Zone1Technical, klass: PatternClass): number {
  if (klass === "CLASS_A") {
    if (technical.spikeRatio >= 300 && technical.volumePower >= 120) {
      return 0.06;
    }
    if (technical.spikeRatio < 120) {
      return -0.06;
    }
  }

  if (klass === "CLASS_C") {
    if (technical.orderImbalance > 1.4 && technical.maDivergence < -1.5) {
      return 0.05;
    }
    if (technical.maDivergence > 1.2) {
      return -0.05;
    }
  }

  return 0;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const size = Math.min(a.length, b.length);

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

function normalizeVector(vec: number[]): number[] {
  const norm = Math.sqrt(vec.reduce((acc, value) => acc + value * value, 0));
  if (norm === 0) {
    return vec.map(() => 0);
  }
  return vec.map((v) => v / norm);
}

function resolveZone3WorkerPath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "services/python/zone3_worker.py"),
    path.resolve(process.cwd(), "../../services/python/zone3_worker.py")
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function normalizeProvider(raw?: string): Zone3Provider {
  const normalized = String(raw ?? "AUTO")
    .trim()
    .toUpperCase();
  if (normalized === "PYTHON" || normalized === "LOCAL_VECTOR") {
    return normalized;
  }
  return "AUTO";
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
