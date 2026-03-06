import type { Zone0Tick, Zone1Technical } from "@stock/contracts";

import type { Zone0OrderBook } from "../zone0/ingest.js";

import { clamp, nowIso } from "../../utils.js";

const ONE_MINUTE_SECONDS = 60;
const THREE_MINUTES_SECONDS = 180;
const FIVE_MINUTES_SECONDS = 300;

class NumericRing {
  private readonly values: number[];
  private head = 0;
  private length = 0;
  private runningSum = 0;

  constructor(private readonly capacity: number) {
    this.values = new Array(capacity).fill(0);
  }

  push(value: number): number | null {
    let evicted: number | null = null;

    if (this.length < this.capacity) {
      this.values[(this.head + this.length) % this.capacity] = value;
      this.length += 1;
    } else {
      evicted = this.values[this.head] ?? 0;
      this.values[this.head] = value;
      this.head = (this.head + 1) % this.capacity;
    }

    this.runningSum += value - (evicted ?? 0);
    return evicted;
  }

  clear(): void {
    this.values.fill(0);
    this.head = 0;
    this.length = 0;
    this.runningSum = 0;
  }

  get sum(): number {
    return this.runningSum;
  }

  get avg(): number {
    return this.length > 0 ? this.runningSum / this.length : 0;
  }

  get size(): number {
    return this.length;
  }
}

export interface Zone1StateSnapshot {
  sessionDate: string;
  open: number;
  high: number;
  low: number;
  notionalRecent1m: number;
  notionalPrev1m: number;
  ma3: number;
  ma5: number;
}

export interface Zone1Engine {
  nextTechnical: (input: { tick: Zone0Tick; orderBook: Zone0OrderBook }) => Zone1Technical;
  getStateSnapshot: () => Zone1StateSnapshot;
}

export function createZone1Engine(): Zone1Engine {
  const notionalRecent1m = new NumericRing(ONE_MINUTE_SECONDS);
  const notionalPrev1m = new NumericRing(ONE_MINUTE_SECONDS);
  const ma3Window = new NumericRing(THREE_MINUTES_SECONDS);
  const ma5Window = new NumericRing(FIVE_MINUTES_SECONDS);

  let sessionDate = "";
  let sessionOpen = 0;
  let sessionHigh = 0;
  let sessionLow = 0;
  let prevPrice: number | null = null;

  function resetSession(dateKey: string, openPrice: number): void {
    sessionDate = dateKey;
    sessionOpen = openPrice;
    sessionHigh = openPrice;
    sessionLow = openPrice;
    prevPrice = null;

    notionalRecent1m.clear();
    notionalPrev1m.clear();
    ma3Window.clear();
    ma5Window.clear();
  }

  function nextTechnical(input: { tick: Zone0Tick; orderBook: Zone0OrderBook }): Zone1Technical {
    const { tick, orderBook } = input;
    const dateKey = tick.timestamp.slice(0, 10);

    if (!sessionDate || sessionDate !== dateKey) {
      resetSession(dateKey, tick.price);
    }

    sessionHigh = Math.max(sessionHigh, tick.price);
    sessionLow = Math.min(sessionLow, tick.price);

    const notional = tick.price * tick.volume;
    const shiftedFromRecent = notionalRecent1m.push(notional);
    if (shiftedFromRecent !== null) {
      notionalPrev1m.push(shiftedFromRecent);
    }

    ma3Window.push(tick.price);
    ma5Window.push(tick.price);

    const orderImbalance = orderBook.totalAskDepth / Math.max(1, orderBook.totalBidDepth);
    const volumePower = deriveVolumePower(tick, orderBook, prevPrice);

    const spikeRatio =
      notionalPrev1m.size > 0 ? (notionalRecent1m.sum / Math.max(1, notionalPrev1m.sum)) * 100 : 100;

    const ma3 = ma3Window.avg || tick.price;
    const ma5 = ma5Window.avg || tick.price;
    const ma3DiffPct = ((tick.price - ma3) / Math.max(1, ma3)) * 100;
    const ma5DiffPct = ((tick.price - ma5) / Math.max(1, ma5)) * 100;
    const maDivergence = ma3DiffPct * 0.6 + ma5DiffPct * 0.4;

    const pivot = (sessionOpen + sessionHigh + sessionLow) / 3;
    const support = Math.round(Math.max(1, 2 * pivot - sessionHigh));
    const resistance = Math.round(Math.max(support + 1, 2 * pivot - sessionLow));

    prevPrice = tick.price;

    return {
      volumePower: Number(clamp(volumePower, 10, 400).toFixed(2)),
      spikeRatio: Number(clamp(spikeRatio, 1, 1_200).toFixed(2)),
      maDivergence: Number(clamp(maDivergence, -20, 20).toFixed(2)),
      orderImbalance: Number(clamp(orderImbalance, 0.1, 10).toFixed(2)),
      support,
      resistance,
      updatedAt: nowIso()
    };
  }

  return {
    nextTechnical,
    getStateSnapshot: () => ({
      sessionDate,
      open: sessionOpen,
      high: sessionHigh,
      low: sessionLow,
      notionalRecent1m: Number(notionalRecent1m.sum.toFixed(2)),
      notionalPrev1m: Number(notionalPrev1m.sum.toFixed(2)),
      ma3: Number((ma3Window.avg || 0).toFixed(2)),
      ma5: Number((ma5Window.avg || 0).toFixed(2))
    })
  };
}

function deriveVolumePower(tick: Zone0Tick, orderBook: Zone0OrderBook, prevPrice: number | null): number {
  const totalDepth = orderBook.totalAskDepth + orderBook.totalBidDepth;
  const bidDepthRatio = totalDepth > 0 ? orderBook.totalBidDepth / totalDepth : 0.5;
  const priceBias = prevPrice === null ? 0 : tick.price >= prevPrice ? 0.12 : -0.12;
  const buyVolume = tick.volume * clamp(bidDepthRatio + priceBias, 0.08, 0.92);
  const sellVolume = Math.max(1, tick.volume - buyVolume);

  return (buyVolume / sellVolume) * 100;
}
