import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import type { Zone2Fundamental } from "@stock/contracts";

import { nowIso } from "../../utils.js";

type Zone2Provider = "AUTO" | "PYTHON" | "MOCK";
type Zone2Source = "PYTHON" | "MOCK";

const ISSUE_MAP = {
  cbBw: "최근 3개월 내 CB/BW/유상증자 이력",
  krx: "KRX 투자경고/투자위험/관리종목 지정",
  capital: "완전자본잠식 또는 재무 불건전성 신호"
} as const;

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

  const cache = new Map<string, Zone2CacheEntry>();
  let lastCheckedAt: string | null = null;
  let lastSource: Zone2Source | "NONE" = "NONE";

  function evaluate(input: {
    symbol: string;
    previous: Zone2Fundamental;
    tickCount: number;
    zone0Fundamental?: Zone0MarketFlowInput | null;
  }): Zone2Fundamental {
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
      nextEntry = evaluateFromMock(symbol, input.tickCount);
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
      pythonEnabled
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
    return evaluateFromMock(symbol, tickCount);
  }

  const fromPython = evaluateFromPython(symbol, tickCount, options);
  if (fromPython) {
    return fromPython;
  }

  return evaluateFromMock(symbol, tickCount);
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
  const riskFlag = parsed.risk_flag === "BLOCKED" || blockedByChecklist ? "BLOCKED" : "CLEAR";

  return {
    value: {
      symbol,
      riskFlag,
      issues,
      checkedAt
    },
    checkedAtMs: Date.parse(checkedAt) || Date.now(),
    tickCount,
    source: "PYTHON",
    checklist
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

  return {
    value: {
      symbol,
      riskFlag: issues.length > 0 ? "BLOCKED" : "CLEAR",
      issues,
      checkedAt
    },
    checkedAtMs: Date.parse(checkedAt) || Date.now(),
    tickCount,
    source: "MOCK",
    checklist
  };
}

function buildInvalidSymbolEntry(rawSymbol: string, tickCount: number): Zone2CacheEntry {
  const checkedAt = nowIso();
  return {
    value: {
      symbol: String(rawSymbol ?? "").trim() || "UNKNOWN",
      riskFlag: "BLOCKED",
      issues: ["유효하지 않은 심볼"],
      checkedAt
    },
    checkedAtMs: Date.parse(checkedAt) || Date.now(),
    tickCount,
    source: "MOCK",
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

  return {
    command,
    prefixArgs
  };
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

function normalizeSymbol(raw: string): string | null {
  const digits = String(raw ?? "").trim().replace(/[^\d]/g, "");
  if (digits.length < 6) {
    return null;
  }
  return digits.slice(0, 6);
}
