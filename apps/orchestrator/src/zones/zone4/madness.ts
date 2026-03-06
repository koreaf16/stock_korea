import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import type { Zone1Technical, Zone3PatternMatch, Zone4Madness } from "@stock/contracts";
import type { Zone0SentimentPulse } from "../zone0/ingest.js";

import { clamp, nowIso } from "../../utils.js";

type Zone4Provider = "AUTO" | "PYTHON" | "LOCAL";
type Zone4Source = "PYTHON" | "LOCAL";

interface PythonWorkerResult {
  score: number;
  stage: "STAGE_1" | "STAGE_2" | "STAGE_3";
  sentiment: number;
  news_velocity: number;
}

interface Zone4EngineResult {
  output: Zone4Madness;
  source: Zone4Source;
}

export interface Zone4StateSnapshot {
  provider: Zone4Provider;
  source: Zone4Source | "NONE";
  stage2Threshold: number;
  stage3Threshold: number;
  signalRate1m: number;
  lastScore: number | null;
  lastStage: Zone4Madness["stage"] | null;
  lastUpdatedAt: string | null;
}

export interface Zone4Engine {
  evaluate: (input: {
    symbol: string;
    technical: Zone1Technical;
    pattern: Zone3PatternMatch;
    sentimentPulse?: Zone0SentimentPulse;
  }) => Zone4Madness;
  getStateSnapshot: () => Zone4StateSnapshot;
}

export function createZone4Engine(): Zone4Engine {
  const provider = normalizeProvider(process.env.ZONE4_PROVIDER);
  const stage2Threshold = Math.max(25, Number(process.env.ZONE4_STAGE2_THRESHOLD ?? 55));
  const stage3Threshold = Math.max(stage2Threshold + 5, Number(process.env.ZONE4_STAGE3_THRESHOLD ?? 75));
  const emaAlpha = clamp(Number(process.env.ZONE4_EMA_ALPHA ?? 0.35), 0.05, 1);

  const signalWindow = new Array<number>(60).fill(0);
  let signalIndex = 0;
  let signalCount = 0;
  let signalSum = 0;

  let emaScore: number | null = null;
  let lastSource: Zone4Source | "NONE" = "NONE";
  let lastScore: number | null = null;
  let lastStage: Zone4Madness["stage"] | null = null;
  let lastUpdatedAt: string | null = null;

  function evaluate(input: {
    symbol: string;
    technical: Zone1Technical;
    pattern: Zone3PatternMatch;
    sentimentPulse?: Zone0SentimentPulse;
  }): Zone4Madness {
    const local = evaluateLocal(
      input.technical,
      input.pattern,
      input.sentimentPulse,
      stage2Threshold,
      stage3Threshold,
      emaAlpha,
      {
        getSignalRate: () => getSignalRate1m(signalSum, signalCount),
        updateSignal: (value: number) => {
          const prevValue = signalWindow[signalIndex] ?? 0;
          signalWindow[signalIndex] = value;
          signalIndex = (signalIndex + 1) % signalWindow.length;
          signalCount = Math.min(signalWindow.length, signalCount + 1);
          signalSum = signalSum - prevValue + value;
        },
        getEma: () => emaScore,
        setEma: (value: number) => {
          emaScore = value;
        }
      }
    );

    let finalResult: Zone4EngineResult = local;
    if (provider === "PYTHON" || provider === "AUTO") {
      const pythonResult = evaluatePython(input.symbol, input.technical, input.pattern, local.output);
      if (pythonResult) {
        finalResult = pythonResult;
      }
    }

    lastSource = finalResult.source;
    lastScore = finalResult.output.score;
    lastStage = finalResult.output.stage;
    lastUpdatedAt = finalResult.output.updatedAt;

    return finalResult.output;
  }

  return {
    evaluate,
    getStateSnapshot: () => ({
      provider,
      source: lastSource,
      stage2Threshold,
      stage3Threshold,
      signalRate1m: Number(getSignalRate1m(signalSum, signalCount).toFixed(2)),
      lastScore,
      lastStage,
      lastUpdatedAt
    })
  };
}

function evaluateLocal(
  technical: Zone1Technical,
  pattern: Zone3PatternMatch,
  sentimentPulse: Zone0SentimentPulse | undefined,
  stage2Threshold: number,
  stage3Threshold: number,
  emaAlpha: number,
  runtime: {
    updateSignal: (value: number) => void;
    getSignalRate: () => number;
    getEma: () => number | null;
    setEma: (value: number) => void;
  }
): Zone4EngineResult {
  const sentiment = clamp(sentimentPulse?.score ?? 0, -1, 1);
  const pulseVelocity = clamp(sentimentPulse?.velocity ?? 0, 0, 100);
  const signalCount = Math.max(0, sentimentPulse?.signalCount ?? 0);
  runtime.updateSignal(signalCount);
  const signalRate1m = runtime.getSignalRate();

  const spikeNorm = clamp((technical.spikeRatio - 80) / 320, 0, 1);
  const volumeNorm = clamp((technical.volumePower - 70) / 220, 0, 1);
  const patternNorm = clamp(pattern.similarity, 0, 1);
  const divergenceNorm = clamp(Math.abs(technical.maDivergence) / 8, 0, 1);
  const sentimentNorm = Math.abs(sentiment);
  const socialNorm = clamp((pulseVelocity * 0.7 + signalRate1m * 0.9) / 100, 0, 1);

  const rawScore =
    spikeNorm * 23 +
    volumeNorm * 19 +
    patternNorm * 22 +
    divergenceNorm * 8 +
    sentimentNorm * 14 +
    socialNorm * 14;

  const prevEma = runtime.getEma();
  const smoothed = prevEma === null ? rawScore : prevEma * (1 - emaAlpha) + rawScore * emaAlpha;
  runtime.setEma(smoothed);

  const score = Number(clamp(smoothed, 0, 100).toFixed(2));
  const stage = deriveStage(score, stage2Threshold, stage3Threshold);

  return {
    source: "LOCAL",
    output: {
      score,
      stage,
      sentiment: Number(sentiment.toFixed(2)),
      newsVelocity: Number(clamp(pulseVelocity * 0.75 + signalRate1m * 0.25, 0, 100).toFixed(2)),
      updatedAt: nowIso()
    }
  };
}

function evaluatePython(
  symbol: string,
  technical: Zone1Technical,
  pattern: Zone3PatternMatch,
  local: Zone4Madness
): Zone4EngineResult | null {
  const scriptPath = resolveZone4WorkerPath();
  if (!scriptPath) {
    return null;
  }

  const rawCmd = (process.env.ZONE4_PYTHON_CMD ?? "python").trim();
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
      symbol,
      "--spike-ratio",
      technical.spikeRatio.toString(),
      "--volume-power",
      technical.volumePower.toString(),
      "--similarity",
      pattern.similarity.toString(),
      "--sentiment",
      local.sentiment.toString(),
      "--news-velocity",
      local.newsVelocity.toString(),
      "--local-score",
      local.score.toString()
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
      score: Number(clamp(parsed.score, 0, 100).toFixed(2)),
      stage: parsed.stage,
      sentiment: Number(clamp(parsed.sentiment, -1, 1).toFixed(2)),
      newsVelocity: Number(clamp(parsed.news_velocity, 0, 100).toFixed(2)),
      updatedAt: nowIso()
    }
  };
}

function deriveStage(score: number, stage2Threshold: number, stage3Threshold: number): Zone4Madness["stage"] {
  if (score >= stage3Threshold) {
    return "STAGE_3";
  }
  if (score >= stage2Threshold) {
    return "STAGE_2";
  }
  return "STAGE_1";
}

function getSignalRate1m(signalSum: number, signalCount: number): number {
  if (signalCount === 0) {
    return 0;
  }
  return signalSum * (60 / signalCount);
}

function resolveZone4WorkerPath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "services/python/zone4_worker.py"),
    path.resolve(process.cwd(), "../../services/python/zone4_worker.py")
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function normalizeProvider(raw?: string): Zone4Provider {
  const normalized = String(raw ?? "AUTO")
    .trim()
    .toUpperCase();

  if (normalized === "PYTHON" || normalized === "LOCAL") {
    return normalized;
  }

  return "AUTO";
}
