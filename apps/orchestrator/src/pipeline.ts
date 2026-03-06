import type {
  ActionOrder,
  DashboardSnapshot,
  ManualOrderCommand,
  OrderLogEntry,
  OrderSource,
  Position
} from "@stock/contracts";

import { nowIso, shortId } from "./utils.js";
import { createRuntimeState, type RuntimeState } from "./state/store.js";

export function initRuntime(): RuntimeState {
  return createRuntimeState();
}

export async function stepRuntime(prev: RuntimeState): Promise<RuntimeState> {
  const tickCount = prev.tickCount + 1;
  const prevSnapshot = prev.snapshot;

  const zone0Frame = prev.zone0.nextFrame({
    targetSymbol: prevSnapshot.targetSymbol,
    previousTick: prevSnapshot.tick
  });
  const tick = zone0Frame.tick;
  const technical = prev.zone1.nextTechnical({
    tick,
    orderBook: zone0Frame.orderBook
  });
  const fundamental = prev.zone2.evaluate({
    symbol: prevSnapshot.targetSymbol,
    previous: prevSnapshot.fundamental,
    tickCount
  });
  const pattern = prev.zone3.evaluate({
    symbol: prevSnapshot.targetSymbol,
    tick,
    technical
  });
  const madness = prev.zone4.evaluate({
    symbol: prevSnapshot.targetSymbol,
    technical,
    pattern,
    sentimentPulse: zone0Frame.sentimentPulse
  });
  const history = prev.zone6.evaluate({
    symbol: prevSnapshot.targetSymbol,
    pattern,
    madness
  });

  const skeleton: DashboardSnapshot = {
    ...prevSnapshot,
    tick,
    technical,
    fundamental,
    pattern,
    madness,
    history,
    positions: markToMarket(prevSnapshot.positions, tick),
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
