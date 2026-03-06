import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import type { Zone2Fundamental } from "@stock/contracts";

import { nowIso } from "../../utils.js";

type Zone2Provider = "AUTO" | "PYTHON" | "MOCK";
type Zone2Source = "PYTHON" | "MOCK";

interface Zone2WorkerResult {
  symbol: string;
  risk_flag: "CLEAR" | "BLOCKED";
  issues: string[];
  checked_at?: string;
  has_cb_bw_issue?: boolean;
  has_krx_warning?: boolean;
  has_capital_impairment?: boolean;
}

interface Zone2ChecklistFlags {
  hasCbBwIssue: boolean;
  hasKrxWarning: boolean;
  hasCapitalImpairment: boolean;
}

interface Zone2CacheEntry {
  value: Zone2Fundamental;
  checkedAtMs: number;
  tickCount: number;
  source: Zone2Source;
  checklist: Zone2ChecklistFlags;
}

export interface Zone2StateSnapshot {
  provider: Zone2Provider;
  source: Zone2Source | "NONE";
  refreshTicks: number;
  staleSeconds: number;
  cacheSize: number;
  lastCheckedAt: string | null;
  pythonEnabled: boolean;
}

export interface Zone2Engine {
  evaluate: (input: { symbol: string; previous: Zone2Fundamental; tickCount: number }) => Zone2Fundamental;
  getStateSnapshot: () => Zone2StateSnapshot;
}

export function createZone2Engine(): Zone2Engine {
  const provider = normalizeProvider(process.env.ZONE2_PROVIDER);
  const refreshTicks = Math.max(1, Number(process.env.ZONE2_REFRESH_TICKS ?? 15));
  const staleSeconds = Math.max(30, Number(process.env.ZONE2_STALE_SECONDS ?? 180));
  const staleMs = staleSeconds * 1_000;
  const forceBlockedSymbols = parseSymbolList(process.env.ZONE2_FORCE_BLOCKED_SYMBOLS);

  const cache = new Map<string, Zone2CacheEntry>();
  let lastCheckedAt: string | null = null;
  let lastSource: Zone2Source | "NONE" = "NONE";

  function evaluate(input: { symbol: string; previous: Zone2Fundamental; tickCount: number }): Zone2Fundamental {
    const symbol = input.symbol.trim();
    const nowMs = Date.now();
    const cached = cache.get(symbol);

    if (cached && !isExpired(cached, input.tickCount, nowMs, refreshTicks, staleMs)) {
      return cached.value;
    }

    let nextEntry: Zone2CacheEntry | null = null;

    if (provider === "PYTHON" || provider === "AUTO") {
      nextEntry = evaluateFromPython(symbol, input.tickCount);
    }

    if (!nextEntry) {
      nextEntry = evaluateFromMock(symbol, input.tickCount, forceBlockedSymbols);
    }

    cache.set(symbol, nextEntry);
    lastCheckedAt = nextEntry.value.checkedAt;
    lastSource = nextEntry.source;

    return nextEntry.value;
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
      pythonEnabled: provider !== "MOCK"
    })
  };
}

function evaluateFromPython(symbol: string, tickCount: number): Zone2CacheEntry | null {
  const scriptPath = resolveZone2WorkerPath();
  if (!scriptPath) {
    return null;
  }

  const pythonCommandRaw = (process.env.ZONE2_PYTHON_CMD ?? "python").trim();
  const [pythonCommand, ...prefixArgs] = pythonCommandRaw.split(/\s+/);
  if (!pythonCommand) {
    return null;
  }

  const proc = spawnSync(pythonCommand, [...prefixArgs, scriptPath, "--symbol", symbol], {
    encoding: "utf8",
    timeout: 1_500
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
  const checklist: Zone2ChecklistFlags = {
    hasCbBwIssue: Boolean(parsed.has_cb_bw_issue),
    hasKrxWarning: Boolean(parsed.has_krx_warning),
    hasCapitalImpairment: Boolean(parsed.has_capital_impairment)
  };

  return {
    value: {
      symbol,
      riskFlag: parsed.risk_flag === "BLOCKED" ? "BLOCKED" : "CLEAR",
      issues: parsed.issues ?? [],
      checkedAt
    },
    checkedAtMs: Date.parse(checkedAt) || Date.now(),
    tickCount,
    source: "PYTHON",
    checklist
  };
}

function evaluateFromMock(symbol: string, tickCount: number, forceBlockedSymbols: Set<string>): Zone2CacheEntry {
  const checklist = deriveChecklistFromSymbol(symbol, forceBlockedSymbols);
  const issues: string[] = [];

  if (checklist.hasCbBwIssue) {
    issues.push("최근 3개월 내 CB/BW/유상증자 이력");
  }
  if (checklist.hasKrxWarning) {
    issues.push("KRX 투자경고/투자위험/관리종목 지정");
  }
  if (checklist.hasCapitalImpairment) {
    issues.push("완전자본잠식 또는 재무 불건전성 신호");
  }

  const riskFlag = issues.length > 0 ? "BLOCKED" : "CLEAR";
  const checkedAt = nowIso();

  return {
    value: {
      symbol,
      riskFlag,
      issues,
      checkedAt
    },
    checkedAtMs: Date.parse(checkedAt) || Date.now(),
    tickCount,
    source: "MOCK",
    checklist
  };
}

function deriveChecklistFromSymbol(symbol: string, forceBlockedSymbols: Set<string>): Zone2ChecklistFlags {
  if (forceBlockedSymbols.has(symbol)) {
    return {
      hasCbBwIssue: true,
      hasKrxWarning: true,
      hasCapitalImpairment: true
    };
  }

  const hash = hashSymbol(symbol);

  return {
    hasCbBwIssue: hash % 23 === 0,
    hasKrxWarning: hash % 29 === 0,
    hasCapitalImpairment: hash % 31 === 0
  };
}

function hashSymbol(symbol: string): number {
  let hash = 7;
  for (const ch of symbol) {
    hash = (hash * 31 + ch.charCodeAt(0)) % 1_000_003;
  }
  return hash;
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

function isExpired(
  entry: Zone2CacheEntry,
  tickCount: number,
  nowMs: number,
  refreshTicks: number,
  staleMs: number
): boolean {
  return tickCount - entry.tickCount >= refreshTicks || nowMs - entry.checkedAtMs >= staleMs;
}

function normalizeProvider(raw?: string): Zone2Provider {
  const normalized = String(raw ?? "AUTO")
    .trim()
    .toUpperCase();

  if (normalized === "PYTHON" || normalized === "MOCK") {
    return normalized;
  }

  return "AUTO";
}

function parseSymbolList(raw?: string): Set<string> {
  if (!raw) {
    return new Set();
  }

  return new Set(
    raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  );
}
