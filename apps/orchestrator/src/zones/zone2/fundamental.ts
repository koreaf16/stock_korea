import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import type { Zone2Fundamental } from "@stock/contracts";

import { nowIso } from "../../utils.js";

type Zone2Provider = "AUTO" | "PYTHON";
type Zone2Source = "PYTHON" | "NO_DATA";

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
  evaluate: (input: {
    symbol: string;
    previous: Zone2Fundamental;
    tickCount: number;
    zone0Fundamental?: Zone0MarketFlowInput | null;
  }) => Zone2Fundamental;
  getStateSnapshot: () => Zone2StateSnapshot;
}

export function createZone2Engine(): Zone2Engine {
  const provider = normalizeProvider(process.env.ZONE2_PROVIDER);
  const refreshTicks = Math.max(1, Number(process.env.ZONE2_REFRESH_TICKS ?? 15));
  const staleSeconds = Math.max(30, Number(process.env.ZONE2_STALE_SECONDS ?? 180));
  const staleMs = staleSeconds * 1_000;
  const forceBlockedSymbols = parseSymbolList(process.env.ZONE2_FORCE_BLOCKED_SYMBOLS);
  const foreignNetSellBlockThreshold = Math.min(-1, Number(process.env.ZONE2_FOREIGN_NET_SELL_BLOCK_THRESHOLD ?? -200_000));
  const institutionNetSellBlockThreshold = Math.min(
    -1,
    Number(process.env.ZONE2_INSTITUTION_NET_SELL_BLOCK_THRESHOLD ?? -180_000)
  );
  const shortBalanceBlockThreshold = Math.max(1, Number(process.env.ZONE2_SHORT_BALANCE_BLOCK_THRESHOLD ?? 500_000));

  const cache = new Map<string, Zone2CacheEntry>();
  let lastCheckedAt: string | null = null;
  let lastSource: Zone2Source | "NONE" = "NONE";

  function evaluate(input: {
    symbol: string;
    previous: Zone2Fundamental;
    tickCount: number;
    zone0Fundamental?: Zone0MarketFlowInput | null;
  }): Zone2Fundamental {
    const symbol = input.symbol.trim();
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
      nextEntry = evaluateFromPython(symbol, input.tickCount);
    }

    if (!nextEntry) {
      nextEntry = buildNoDataEntry(symbol, input.tickCount);
    }

    if (marketFlow) {
      nextEntry = applyMarketFlowOverlay(nextEntry, marketFlow, input.tickCount, {
        foreignNetSellBlockThreshold,
        institutionNetSellBlockThreshold,
        shortBalanceBlockThreshold
      });
    }
    nextEntry = applyForceBlockOverlay(nextEntry, forceBlockedSymbols, input.tickCount);

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
      pythonEnabled: true
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

function buildNoDataEntry(symbol: string, tickCount: number): Zone2CacheEntry {
  const checkedAt = nowIso();

  return {
    value: {
      symbol,
      riskFlag: "BLOCKED",
      issues: ["Zone2 실데이터 미수신"],
      checkedAt
    },
    checkedAtMs: Date.parse(checkedAt) || Date.now(),
    tickCount,
    source: "NO_DATA",
    checklist: {
      hasCbBwIssue: false,
      hasKrxWarning: false,
      hasCapitalImpairment: false
    }
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

interface MarketFlowThresholds {
  foreignNetSellBlockThreshold: number;
  institutionNetSellBlockThreshold: number;
  shortBalanceBlockThreshold: number;
}

function applyMarketFlowOverlay(
  baseEntry: Zone2CacheEntry,
  marketFlow: Zone0MarketFlowInput,
  tickCount: number,
  thresholds: MarketFlowThresholds
): Zone2CacheEntry {
  const issues = new Set(stripPreviousMarketFlowIssues(baseEntry.value.issues));

  if (marketFlow.foreignNetBuyQty <= thresholds.foreignNetSellBlockThreshold) {
    issues.add(`외국인 순매수 급감(${marketFlow.foreignNetBuyQty.toLocaleString("ko-KR")})`);
  }
  if (marketFlow.institutionalNetBuyQty <= thresholds.institutionNetSellBlockThreshold) {
    issues.add(`기관 순매수 급감(${marketFlow.institutionalNetBuyQty.toLocaleString("ko-KR")})`);
  }
  if (marketFlow.shortBalanceQty >= thresholds.shortBalanceBlockThreshold) {
    issues.add(`공매도 잔고 고위험(${marketFlow.shortBalanceQty.toLocaleString("ko-KR")})`);
  }

  const nextIssues = [...issues];
  const riskFlag = nextIssues.length > 0 ? "BLOCKED" : baseEntry.value.riskFlag;
  const checkedAt = marketFlow.timestamp || nowIso();

  return {
    value: {
      symbol: baseEntry.value.symbol,
      riskFlag,
      issues: nextIssues,
      checkedAt
    },
    checkedAtMs: Date.parse(checkedAt) || Date.now(),
    tickCount,
    source: baseEntry.source,
    checklist: baseEntry.checklist
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
    value: {
      symbol: baseEntry.value.symbol,
      riskFlag: "BLOCKED",
      issues: [...issues],
      checkedAt
    },
    checkedAtMs: Date.parse(checkedAt) || Date.now(),
    tickCount,
    source: baseEntry.source,
    checklist: baseEntry.checklist
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
  const normalized = String(raw ?? "AUTO")
    .trim()
    .toUpperCase();

  if (normalized === "PYTHON") {
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
