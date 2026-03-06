import type {
  ActionOrder,
  DashboardSnapshot,
  DecisionAction,
  ManualOrderCommand,
  OrderLogEntry,
  OrderSource,
  Position,
  WatchPoolItem
} from "@stock/contracts";

import { nowIso, shortId } from "./utils.js";
import { createRuntimeState, type RuntimeState } from "./state/store.js";

const WATCH_POOL_LIMIT = Math.max(10, Number(process.env.TARGET_WATCH_POOL_LIMIT ?? 20));
const WATCH_POOL_STALE_MS = Math.max(60_000, Number(process.env.TARGET_WATCH_POOL_STALE_MS ?? 600_000));
const TARGET_SELECT_SPIKE_THRESHOLD = Number(process.env.TARGET_SELECT_SPIKE_THRESHOLD ?? 300);
const TARGET_SELECT_VOLUME_POWER_THRESHOLD = Number(process.env.TARGET_SELECT_VOLUME_POWER_THRESHOLD ?? 120);
const TARGET_PREEMPT_SPIKE_THRESHOLD = Number(process.env.TARGET_PREEMPT_SPIKE_THRESHOLD ?? 500);
const TARGET_KEEP_MIN_VOLUME_POWER = Number(process.env.TARGET_KEEP_MIN_VOLUME_POWER ?? 100);
const TARGET_KEEP_MIN_MA_DIVERGENCE = Number(process.env.TARGET_KEEP_MIN_MA_DIVERGENCE ?? 0);
const TARGET_PASS_STREAK_LIMIT = Math.max(1, Number(process.env.TARGET_PASS_STREAK_LIMIT ?? 3));
const DEFAULT_TARGET_SYMBOL = "005930";

interface CachedFundamentalInput {
  symbol: string;
  foreignNetBuyQty: number;
  institutionalNetBuyQty: number;
  shortBalanceQty: number;
  source: "KOSCOM" | "KRX";
  timestamp: string;
}

interface TargetSelectionInput {
  previousSnapshot: DashboardSnapshot;
  watchPool: WatchPoolItem[];
  incomingSymbol: string;
}

interface TargetSelection {
  symbol: string;
  reason: string;
}

interface TargetManagerState {
  watchPoolBySymbol: Map<string, WatchPoolItem>;
  latestTickBySymbol: Map<string, DashboardSnapshot["tick"]>;
  latestTechnicalBySymbol: Map<string, DashboardSnapshot["technical"]>;
  latestFundamentalBySymbol: Map<string, CachedFundamentalInput>;
  passStreakBySymbol: Map<string, number>;
}

const TARGET_MANAGER: TargetManagerState = createTargetManagerState();

export function initRuntime(): RuntimeState {
  resetTargetManager();
  return createRuntimeState();
}

export async function stepRuntime(prev: RuntimeState): Promise<RuntimeState> {
  const prevSnapshot = prev.snapshot;

  const zone0Frame = prev.zone0.consumeFrame();
  if (!zone0Frame) {
    return prev;
  }

  const tickCount = prev.tickCount + 1;
  const incomingTick = zone0Frame.tick;
  const incomingSymbol = ensureSymbol(incomingTick.symbol, ensureSymbol(prevSnapshot.targetSymbol));
  const nextGlobalContext = zone0Frame.globalContext ?? prevSnapshot.globalContext;

  const incomingTechnical = prev.zone1.nextTechnical({
    tick: incomingTick,
    orderBook: zone0Frame.orderBook
  });

  ingestTargetSignals(incomingTick, incomingTechnical, zone0Frame.fundamentalData ?? []);

  const watchPool = buildWatchPoolSnapshot(nowIso());
  const selected = selectTargetSymbol({
    previousSnapshot: prevSnapshot,
    watchPool,
    incomingSymbol
  });

  const targetSymbol = selected.symbol;
  const targetTick = resolveTargetTick(targetSymbol, incomingTick, prevSnapshot);
  const targetTechnical = resolveTargetTechnical(targetSymbol, incomingTechnical, prevSnapshot);
  const latestMarketFlow = TARGET_MANAGER.latestFundamentalBySymbol.get(targetSymbol) ?? null;

  const fundamental = prev.zone2.evaluate({
    symbol: targetSymbol,
    previous: prevSnapshot.fundamental,
    tickCount,
    zone0Fundamental: latestMarketFlow
      ? {
          symbol: latestMarketFlow.symbol,
          foreignNetBuyQty: latestMarketFlow.foreignNetBuyQty,
          institutionalNetBuyQty: latestMarketFlow.institutionalNetBuyQty,
          shortBalanceQty: latestMarketFlow.shortBalanceQty,
          source: latestMarketFlow.source,
          timestamp: latestMarketFlow.timestamp
        }
      : null
  });
  const pattern = prev.zone3.evaluate({
    symbol: targetSymbol,
    tick: targetTick,
    technical: targetTechnical
  });
  const madness = prev.zone4.evaluate({
    symbol: targetSymbol,
    technical: targetTechnical,
    pattern,
    sentimentPulse: zone0Frame.sentimentPulse
  });
  const history = prev.zone6.evaluate({
    symbol: targetSymbol,
    pattern,
    madness
  });

  const positionsMarkedWithIncoming = markToMarket(prevSnapshot.positions, incomingTick);
  const positionsMarked = markToMarket(positionsMarkedWithIncoming, targetTick);

  const skeleton: DashboardSnapshot = {
    ...prevSnapshot,
    targetSymbol,
    targetReason: selected.reason,
    watchPool,
    globalContext: nextGlobalContext,
    tick: targetTick,
    technical: targetTechnical,
    fundamental,
    pattern,
    madness,
    history,
    positions: positionsMarked,
    lastUpdatedAt: nowIso()
  };

  const decision = await prev.zone5.evaluate({
    snapshot: skeleton,
    pattern,
    madness,
    history
  });

  let snapshotWithDecision: DashboardSnapshot = {
    ...skeleton,
    decision
  };

  const aiOrder = buildOrderFromDecision(snapshotWithDecision);
  if (aiOrder) {
    snapshotWithDecision = executeOrder(snapshotWithDecision, aiOrder, "AI");
  } else {
    snapshotWithDecision = refreshAccountTotals(snapshotWithDecision);
  }

  updatePassStreak(targetSymbol, snapshotWithDecision.decision.action);
  maybeRecordHistoryOutcome(prev, skeleton, snapshotWithDecision, aiOrder);

  return {
    tickCount,
    zone0: prev.zone0,
    zone1: prev.zone1,
    zone2: prev.zone2,
    zone3: prev.zone3,
    zone4: prev.zone4,
    zone5: prev.zone5,
    zone6: prev.zone6,
    snapshot: snapshotWithDecision
  };
}

export function applyKillSwitch(prev: RuntimeState, enabled: boolean): RuntimeState {
  let snapshot: DashboardSnapshot = {
    ...prev.snapshot,
    killSwitchOn: enabled,
    lastUpdatedAt: nowIso()
  };

  if (enabled && snapshot.positions.length > 0) {
    for (const position of [...snapshot.positions]) {
      snapshot = executeOrder(
        snapshot,
        {
          symbol: position.symbol,
          side: "SELL",
          qty: position.qty,
          type: "MARKET"
        },
        "KILL_SWITCH"
      );
    }
  }

  return {
    ...prev,
    snapshot
  };
}

export function applyManualOrder(prev: RuntimeState, command: ManualOrderCommand): RuntimeState {
  const order: ActionOrder = {
    symbol: command.symbol,
    side: command.side,
    qty: Math.max(1, Math.floor(command.qty)),
    type: "MARKET"
  };

  return {
    ...prev,
    snapshot: executeOrder(prev.snapshot, order, "MANUAL")
  };
}

function createTargetManagerState(): TargetManagerState {
  return {
    watchPoolBySymbol: new Map<string, WatchPoolItem>(),
    latestTickBySymbol: new Map<string, DashboardSnapshot["tick"]>(),
    latestTechnicalBySymbol: new Map<string, DashboardSnapshot["technical"]>(),
    latestFundamentalBySymbol: new Map<string, CachedFundamentalInput>(),
    passStreakBySymbol: new Map<string, number>()
  };
}

function resetTargetManager(): void {
  TARGET_MANAGER.watchPoolBySymbol.clear();
  TARGET_MANAGER.latestTickBySymbol.clear();
  TARGET_MANAGER.latestTechnicalBySymbol.clear();
  TARGET_MANAGER.latestFundamentalBySymbol.clear();
  TARGET_MANAGER.passStreakBySymbol.clear();
}

function ingestTargetSignals(
  tick: DashboardSnapshot["tick"],
  technical: DashboardSnapshot["technical"],
  fundamentals: CachedFundamentalInput[]
): void {
  const symbol = normalizeSymbol(tick.symbol);
  if (!symbol) {
    return;
  }

  TARGET_MANAGER.latestTickBySymbol.set(symbol, {
    ...tick,
    symbol
  });

  TARGET_MANAGER.latestTechnicalBySymbol.set(symbol, technical);

  TARGET_MANAGER.watchPoolBySymbol.set(symbol, {
    symbol,
    spikeRatio: technical.spikeRatio,
    volumePower: technical.volumePower,
    maDivergence: technical.maDivergence,
    lastPrice: tick.price,
    updatedAt: technical.updatedAt
  });

  for (const item of fundamentals) {
    const fundamentalSymbol = normalizeSymbol(item.symbol);
    if (!fundamentalSymbol) {
      continue;
    }

    TARGET_MANAGER.latestFundamentalBySymbol.set(fundamentalSymbol, {
      ...item,
      symbol: fundamentalSymbol
    });
  }
}

function buildWatchPoolSnapshot(now: string): WatchPoolItem[] {
  const nowMs = Date.parse(now);

  for (const [symbol, item] of TARGET_MANAGER.watchPoolBySymbol.entries()) {
    const updatedAt = Date.parse(item.updatedAt);
    if (!Number.isFinite(updatedAt)) {
      continue;
    }

    if (nowMs - updatedAt > WATCH_POOL_STALE_MS) {
      TARGET_MANAGER.watchPoolBySymbol.delete(symbol);
      TARGET_MANAGER.latestTickBySymbol.delete(symbol);
      TARGET_MANAGER.latestTechnicalBySymbol.delete(symbol);
      TARGET_MANAGER.latestFundamentalBySymbol.delete(symbol);
      TARGET_MANAGER.passStreakBySymbol.delete(symbol);
    }
  }

  return [...TARGET_MANAGER.watchPoolBySymbol.values()]
    .sort((a, b) => {
      if (b.spikeRatio !== a.spikeRatio) {
        return b.spikeRatio - a.spikeRatio;
      }
      if (b.volumePower !== a.volumePower) {
        return b.volumePower - a.volumePower;
      }
      return Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
    })
    .slice(0, WATCH_POOL_LIMIT);
}

function selectTargetSymbol(input: TargetSelectionInput): TargetSelection {
  const previousTarget = normalizeSymbol(input.previousSnapshot.targetSymbol);
  const previousReason = input.previousSnapshot.targetReason || "타겟 탐색 대기";

  const preemption = input.watchPool.find(
    (item) => item.symbol !== previousTarget && item.spikeRatio > TARGET_PREEMPT_SPIKE_THRESHOLD && hasLiveSignal(item.symbol)
  );

  if (preemption && previousTarget) {
    return {
      symbol: preemption.symbol,
      reason: `강력한 주도주 난입(Spike ${preemption.spikeRatio.toFixed(1)}%)으로 ${previousTarget} -> ${preemption.symbol} 선점 전환`
    };
  }

  if (!previousTarget || !hasLiveSignal(previousTarget)) {
    const qualified = findQualifiedCandidate(input.watchPool, null);
    const candidate = qualified ?? findFallbackCandidate(input.watchPool, input.incomingSymbol, null);
    return {
      symbol: candidate.symbol,
      reason: qualified
        ? `수급 폭발(Spike ${candidate.spikeRatio.toFixed(1)}%, VP ${candidate.volumePower.toFixed(1)})로 타겟 선정`
        : `유효 신호 부족으로 ${candidate.symbol} 관찰 타겟 지정`
    };
  }

  const currentMetric = input.watchPool.find((item) => item.symbol === previousTarget) ?? null;
  const passStreak = TARGET_MANAGER.passStreakBySymbol.get(previousTarget) ?? 0;
  const momentumLost = !currentMetric || currentMetric.volumePower < TARGET_KEEP_MIN_VOLUME_POWER || currentMetric.maDivergence < TARGET_KEEP_MIN_MA_DIVERGENCE;
  const passExceeded = passStreak >= TARGET_PASS_STREAK_LIMIT;
  const positionClosed = wasTargetPositionClosed(input.previousSnapshot, previousTarget);

  if (momentumLost || passExceeded || positionClosed) {
    const candidate =
      findQualifiedCandidate(input.watchPool, previousTarget) ??
      findFallbackCandidate(input.watchPool, input.incomingSymbol, previousTarget);

    if (candidate.symbol !== previousTarget) {
      if (passExceeded) {
        return {
          symbol: candidate.symbol,
          reason: `Zone5 PASS ${passStreak}회 누적으로 ${previousTarget} -> ${candidate.symbol} 타겟 교체`
        };
      }

      if (positionClosed) {
        return {
          symbol: candidate.symbol,
          reason: `포지션 청산 확인으로 ${previousTarget} -> ${candidate.symbol} 타겟 재선정`
        };
      }

      const vp = currentMetric?.volumePower ?? 0;
      const ma = currentMetric?.maDivergence ?? 0;
      return {
        symbol: candidate.symbol,
        reason: `모멘텀 상실(VP ${vp.toFixed(1)}, MA ${ma.toFixed(2)})로 ${previousTarget} -> ${candidate.symbol} 전환`
      };
    }
  }

  return {
    symbol: previousTarget,
    reason: previousReason
  };
}

function findQualifiedCandidate(watchPool: WatchPoolItem[], excludeSymbol: string | null): WatchPoolItem | null {
  for (const item of watchPool) {
    if (excludeSymbol && item.symbol === excludeSymbol) {
      continue;
    }
    if (item.spikeRatio <= TARGET_SELECT_SPIKE_THRESHOLD) {
      continue;
    }
    if (item.volumePower <= TARGET_SELECT_VOLUME_POWER_THRESHOLD) {
      continue;
    }
    if (!hasLiveSignal(item.symbol)) {
      continue;
    }

    return item;
  }

  return null;
}

function findFallbackCandidate(watchPool: WatchPoolItem[], incomingSymbol: string, excludeSymbol: string | null): WatchPoolItem {
  for (const item of watchPool) {
    if (excludeSymbol && item.symbol === excludeSymbol) {
      continue;
    }
    if (hasLiveSignal(item.symbol)) {
      return item;
    }
  }

  const incomingTick = TARGET_MANAGER.latestTickBySymbol.get(incomingSymbol);
  const incomingTechnical = TARGET_MANAGER.latestTechnicalBySymbol.get(incomingSymbol);

  return {
    symbol: incomingSymbol,
    spikeRatio: incomingTechnical?.spikeRatio ?? 0,
    volumePower: incomingTechnical?.volumePower ?? 0,
    maDivergence: incomingTechnical?.maDivergence ?? 0,
    lastPrice: incomingTick?.price ?? 0,
    updatedAt: incomingTechnical?.updatedAt ?? nowIso()
  };
}

function resolveTargetTick(
  targetSymbol: string,
  incomingTick: DashboardSnapshot["tick"],
  previousSnapshot: DashboardSnapshot
): DashboardSnapshot["tick"] {
  const incomingSymbol = normalizeSymbol(incomingTick.symbol);
  if (incomingSymbol && incomingSymbol === targetSymbol) {
    return {
      ...incomingTick,
      symbol: targetSymbol
    };
  }

  const cached = TARGET_MANAGER.latestTickBySymbol.get(targetSymbol);
  if (cached) {
    return cached;
  }

  const previousTickSymbol = normalizeSymbol(previousSnapshot.tick.symbol);
  if (previousTickSymbol && previousTickSymbol === targetSymbol) {
    return {
      ...previousSnapshot.tick,
      symbol: targetSymbol
    };
  }

  return {
    ...incomingTick,
    symbol: targetSymbol
  };
}

function resolveTargetTechnical(
  targetSymbol: string,
  incomingTechnical: DashboardSnapshot["technical"],
  previousSnapshot: DashboardSnapshot
): DashboardSnapshot["technical"] {
  const cached = TARGET_MANAGER.latestTechnicalBySymbol.get(targetSymbol);
  if (cached) {
    return cached;
  }

  const previousTickSymbol = normalizeSymbol(previousSnapshot.tick.symbol);
  if (previousTickSymbol && previousTickSymbol === targetSymbol) {
    return previousSnapshot.technical;
  }

  return incomingTechnical;
}

function hasLiveSignal(symbol: string): boolean {
  return TARGET_MANAGER.latestTickBySymbol.has(symbol) && TARGET_MANAGER.latestTechnicalBySymbol.has(symbol);
}

function wasTargetPositionClosed(snapshot: DashboardSnapshot, targetSymbol: string): boolean {
  const stillHolding = snapshot.positions.some((position) => normalizeSymbol(position.symbol) === targetSymbol);
  if (stillHolding) {
    return false;
  }

  const latestOrder = snapshot.orderLog[0];
  if (!latestOrder) {
    return false;
  }

  return (
    normalizeSymbol(latestOrder.symbol) === targetSymbol &&
    latestOrder.side === "SELL" &&
    latestOrder.status === "FILLED"
  );
}

function updatePassStreak(symbol: string, action: DecisionAction): void {
  const current = TARGET_MANAGER.passStreakBySymbol.get(symbol) ?? 0;
  if (action === "PASS") {
    TARGET_MANAGER.passStreakBySymbol.set(symbol, current + 1);
    return;
  }

  TARGET_MANAGER.passStreakBySymbol.set(symbol, 0);
}

function ensureSymbol(raw: string, fallback = DEFAULT_TARGET_SYMBOL): string {
  return normalizeSymbol(raw) ?? fallback;
}

function normalizeSymbol(raw: string | undefined | null): string | null {
  const text = String(raw ?? "").trim();
  if (!text) {
    return null;
  }

  const digits = text.replace(/[^\d]/g, "");
  if (digits.length < 6) {
    return null;
  }

  return digits.slice(0, 6);
}

function buildOrderFromDecision(snapshot: DashboardSnapshot): ActionOrder | null {
  const { decision, tick, account, targetSymbol } = snapshot;

  if (decision.action === "PASS" || decision.suggestedWeightPct <= 0) {
    return null;
  }

  if (decision.action === "BUY") {
    const budget = account.cashAvailable * (decision.suggestedWeightPct / 100);
    const qty = Math.max(0, Math.floor(budget / Math.max(1, tick.price)));
    if (qty <= 0) {
      return null;
    }

    return {
      symbol: targetSymbol,
      side: "BUY",
      qty,
      type: "MARKET"
    };
  }

  const position = snapshot.positions.find((entry) => entry.symbol === targetSymbol);
  if (!position) {
    return null;
  }

  const qty = Math.max(1, Math.floor(position.qty * (decision.suggestedWeightPct / 100)));

  return {
    symbol: targetSymbol,
    side: "SELL",
    qty: Math.min(qty, position.qty),
    type: "MARKET"
  };
}

function maybeRecordHistoryOutcome(
  runtime: RuntimeState,
  beforeSnapshot: DashboardSnapshot,
  afterSnapshot: DashboardSnapshot,
  executedOrder: ActionOrder | null
): void {
  if (!executedOrder || executedOrder.side !== "SELL") {
    return;
  }

  const targetSymbol = afterSnapshot.targetSymbol;
  const beforePosition = beforeSnapshot.positions.find((position) => position.symbol === targetSymbol);
  const afterPosition = afterSnapshot.positions.find((position) => position.symbol === targetSymbol);
  if (!beforePosition || afterPosition) {
    return;
  }

  const zone5State = runtime.zone5.getStateSnapshot();
  const archiveJson = zone5State.lastArchiveJson;
  if (!archiveJson) {
    return;
  }

  const realizedPnlPct =
    ((afterSnapshot.tick.price - beforePosition.entryPrice) / Math.max(1, beforePosition.entryPrice)) * 100;

  runtime.zone6.recordTradeOutcome({
    symbol: targetSymbol,
    archiveJson,
    realizedPnlPct: Number(realizedPnlPct.toFixed(2))
  });
}

function executeOrder(snapshot: DashboardSnapshot, order: ActionOrder, source: OrderSource): DashboardSnapshot {
  const now = nowIso();
  const price = snapshot.tick.price;
  const logBase: Omit<OrderLogEntry, "status"> = {
    id: shortId("ORD"),
    symbol: order.symbol,
    side: order.side,
    qty: order.qty,
    price,
    source,
    timestamp: now
  };

  const positions = [...snapshot.positions];
  const account = { ...snapshot.account };

  if (order.side === "BUY") {
    const cost = price * order.qty;
    if (account.cashAvailable < cost) {
      return appendOrderLog(snapshot, { ...logBase, status: "REJECTED" });
    }

    account.cashAvailable -= cost;
    const idx = positions.findIndex((position) => position.symbol === order.symbol);
    if (idx >= 0) {
      const current = positions[idx];
      if (!current) {
        return appendOrderLog(snapshot, { ...logBase, status: "REJECTED" });
      }
      const totalQty = current.qty + order.qty;
      const weightedEntry = (current.entryPrice * current.qty + price * order.qty) / totalQty;
      positions[idx] = {
        ...current,
        entryPrice: Math.round(weightedEntry),
        currentPrice: price,
        qty: totalQty,
        pnlPct: Number((((price - weightedEntry) / weightedEntry) * 100).toFixed(2))
      };
    } else {
      positions.push({
        symbol: order.symbol,
        name: order.symbol,
        entryPrice: price,
        currentPrice: price,
        qty: order.qty,
        pnlPct: 0
      });
    }

    return appendOrderLog(
      refreshAccountTotals({
        ...snapshot,
        account,
        positions,
        lastUpdatedAt: now
      }),
      { ...logBase, status: "FILLED" }
    );
  }

  const idx = positions.findIndex((position) => position.symbol === order.symbol);
  if (idx < 0) {
    return appendOrderLog(snapshot, { ...logBase, status: "REJECTED" });
  }

  const current = positions[idx];
  if (!current || current.qty < order.qty) {
    return appendOrderLog(snapshot, { ...logBase, status: "REJECTED" });
  }

  const realizedPnlPct = ((price - current.entryPrice) / Math.max(1, current.entryPrice)) * 100;
  account.cashAvailable += price * order.qty;
  account.realizedPnlPct = Number((account.realizedPnlPct + realizedPnlPct * (order.qty / current.qty)).toFixed(2));

  const remainingQty = current.qty - order.qty;
  if (remainingQty <= 0) {
    positions.splice(idx, 1);
  } else {
    positions[idx] = {
      ...current,
      currentPrice: price,
      qty: remainingQty,
      pnlPct: Number((((price - current.entryPrice) / current.entryPrice) * 100).toFixed(2))
    };
  }

  return appendOrderLog(
    refreshAccountTotals({
      ...snapshot,
      account,
      positions,
      lastUpdatedAt: now
    }),
    { ...logBase, status: "FILLED" }
  );
}

function appendOrderLog(snapshot: DashboardSnapshot, entry: OrderLogEntry): DashboardSnapshot {
  return {
    ...snapshot,
    orderLog: [entry, ...snapshot.orderLog].slice(0, 120),
    lastUpdatedAt: nowIso()
  };
}

function markToMarket(positions: Position[], tick: DashboardSnapshot["tick"]): Position[] {
  return positions.map((position) => {
    if (position.symbol !== tick.symbol) {
      return position;
    }

    const pnlPct = ((tick.price - position.entryPrice) / Math.max(1, position.entryPrice)) * 100;

    return {
      ...position,
      currentPrice: tick.price,
      pnlPct: Number(pnlPct.toFixed(2))
    };
  });
}

function refreshAccountTotals(snapshot: DashboardSnapshot): DashboardSnapshot {
  const marketValue = snapshot.positions.reduce((acc, position) => acc + position.currentPrice * position.qty, 0);
  const totalAssets = snapshot.account.cashAvailable + marketValue;

  return {
    ...snapshot,
    account: {
      ...snapshot.account,
      totalAssets: Math.round(totalAssets)
    },
    lastUpdatedAt: nowIso()
  };
}
