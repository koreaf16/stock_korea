import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

import type { Zone1Technical, Zone3PatternMatch, Zone4Madness } from "@stock/contracts";
import type { Zone0SentimentPulse } from "../zone0/ingest.js";

import { clamp, nowIso } from "../../utils.js";

type Zone4Provider = "AUTO" | "PYTHON" | "LOCAL";
type Zone4Source = "PYTHON" | "LOCAL";
const SIGNAL_WINDOW_MS = 60_000;
const PYTHON_PROBE_TIMEOUT_MS = 1_200;

interface PythonWorkerResult {
  score: number;
  stage?: "STAGE_1" | "STAGE_2" | "STAGE_3";
  sentiment: number;
  news_velocity: number;
}

interface Zone4ScoredResult {
  score: number;
  sentiment: number;
  newsVelocity: number;
}

interface Zone4EngineResult {
  output: Zone4ScoredResult;
  source: Zone4Source;
}

interface PythonExecCommand {
  command: string;
  prefixArgs: string[];
}

interface SignalSample {
  atMs: number;
  signalCount: number;
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
  const workerPath = resolveZone4WorkerPath();
  const pythonExec = parsePythonCommand(process.env.ZONE4_PYTHON_CMD ?? "python");
  const pythonEnabled = Boolean(provider !== "LOCAL" && workerPath && pythonExec && canRunPythonCommand(pythonExec));

  const signalWindow: SignalSample[] = [];
  let signalSum = 0;

  let emaScore: number | null = null;
  let lastSource: Zone4Source | "NONE" = "NONE";
  let lastScore: number | null = null;
  let lastStage: Zone4Madness["stage"] | null = null;
  let lastUpdatedAt: string | null = null;

  function pruneSignalWindow(nowMs: number): void {
    const cutoff = nowMs - SIGNAL_WINDOW_MS;
    while (signalWindow.length > 0) {
      const oldest = signalWindow[0];
      if (!oldest || oldest.atMs >= cutoff) {
        break;
      }
      signalWindow.shift();
      signalSum -= oldest.signalCount;
    }
    if (signalSum < 0) {
      signalSum = 0;
    }
  }

  function updateSignalWindow(nextSignalCount: number, nowMs: number): void {
    pruneSignalWindow(nowMs);
    const safeSignalCount = Math.max(0, nextSignalCount);
    signalWindow.push({
      atMs: nowMs,
      signalCount: safeSignalCount
    });
    signalSum += safeSignalCount;
    pruneSignalWindow(nowMs);
  }

  function getSignalRate1m(nowMs: number): number {
    pruneSignalWindow(nowMs);
    return signalSum;
  }

  function evaluate(input: {
    symbol: string;
    technical: Zone1Technical;
    pattern: Zone3PatternMatch;
    sentimentPulse?: Zone0SentimentPulse;
  }): Zone4Madness {
    const nowMs = Date.now();
    const pulseSignalCount = Math.max(0, input.sentimentPulse?.signalCount ?? 0);
    updateSignalWindow(pulseSignalCount, nowMs);
    const signalRate1m = getSignalRate1m(nowMs);

    const local = evaluateLocal(
      input.technical,
      input.pattern,
      input.sentimentPulse,
      emaAlpha,
      signalRate1m,
      {
        getEma: () => emaScore,
        setEma: (value: number) => {
          emaScore = value;
        }
      }
    );

    let finalResult: Zone4EngineResult = local;
    if ((provider === "PYTHON" || provider === "AUTO") && pythonEnabled && workerPath && pythonExec) {
      const pythonResult = evaluatePython(input.symbol, input.technical, input.pattern, local.output, {
        workerPath,
        pythonExec
      });
      if (pythonResult) {
        finalResult = pythonResult;
      }
    }

    const score = Number(clamp(finalResult.output.score, 0, 100).toFixed(2));
    const output: Zone4Madness = {
      score,
      stage: deriveStage(score, stage2Threshold, stage3Threshold),
      sentiment: Number(clamp(finalResult.output.sentiment, -1, 1).toFixed(2)),
      newsVelocity: Number(clamp(finalResult.output.newsVelocity, 0, 100).toFixed(2)),
      updatedAt: nowIso()
    };

    lastSource = finalResult.source;
    lastScore = output.score;
    lastStage = output.stage;
    lastUpdatedAt = output.updatedAt;

    return output;
  }

  return {
    evaluate,
    getStateSnapshot: () => ({
      provider,
      source: lastSource,
      stage2Threshold,
      stage3Threshold,
      signalRate1m: Number(getSignalRate1m(Date.now()).toFixed(2)),
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
  emaAlpha: number,
  signalRate1m: number,
  runtime: {
    getEma: () => number | null;
    setEma: (value: number) => void;
  }
): Zone4EngineResult {
  const sentiment = clamp(sentimentPulse?.score ?? 0, -1, 1);
  const pulseVelocity = clamp(sentimentPulse?.velocity ?? 0, 0, 100);

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

  return {
    source: "LOCAL",
    output: {
      score: smoothed,
      sentiment: Number(sentiment.toFixed(2)),
      newsVelocity: Number(clamp(pulseVelocity * 0.75 + signalRate1m * 0.25, 0, 100).toFixed(2))
    }
  };
}

function evaluatePython(
  symbol: string,
  technical: Zone1Technical,
  pattern: Zone3PatternMatch,
  local: Zone4ScoredResult,
  options: {
    workerPath: string;
    pythonExec: PythonExecCommand;
  }
): Zone4EngineResult | null {
  const proc = spawnSync(
    options.pythonExec.command,
    [
      ...options.pythonExec.prefixArgs,
      options.workerPath,
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
      score: parsed.score,
      sentiment: parsed.sentiment,
      newsVelocity: parsed.news_velocity
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

function parsePythonCommand(raw: string): PythonExecCommand | null {
  const commandLine = String(raw ?? "").trim();
  if (!commandLine) {
    return null;
  }

  const [command, ...prefixArgs] = commandLine.split(/\s+/);
  if (!command) {
    return null;
  }

  return {
    command,
    prefixArgs
  };
}

function canRunPythonCommand(exec: PythonExecCommand): boolean {
  const probe = spawnSync(exec.command, [...exec.prefixArgs, "--version"], {
    encoding: "utf8",
    timeout: PYTHON_PROBE_TIMEOUT_MS
  });
  if (probe.error) {
    return false;
  }
  return probe.status === 0;
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
