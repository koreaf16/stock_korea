export type ConnectionState = "UP" | "DOWN";

export type NetworkServiceName = "KIS_API" | "ORACLE_26AI" | "LOCAL_LLM";

export interface NetworkServiceStatus {
  name: NetworkServiceName;
  endpoint: string;
  state: ConnectionState;
  updatedAt: string;
}

export interface AccountSnapshot {
  totalAssets: number;
  cashAvailable: number;
  realizedPnlPct: number;
}

export interface Position {
  symbol: string;
  name: string;
  entryPrice: number;
  currentPrice: number;
  qty: number;
  pnlPct: number;
}

export type OrderSide = "BUY" | "SELL";
export type OrderType = "MARKET" | "LIMIT";
export type OrderStatus = "SENT" | "FILLED" | "REJECTED";
export type OrderSource = "AI" | "MANUAL" | "KILL_SWITCH";

export interface ManualOrderCommand {
  symbol: string;
  side: OrderSide;
  qty: number;
}

export interface ActionOrder {
  symbol: string;
  side: OrderSide;
  qty: number;
  type: OrderType;
}

export interface OrderLogEntry {
  id: string;
  symbol: string;
  side: OrderSide;
  qty: number;
  price: number;
  status: OrderStatus;
  source: OrderSource;
  timestamp: string;
}

export interface Zone0Tick {
  symbol: string;
  price: number;
  volume: number;
  bidDepth: number;
  askDepth: number;
  timestamp: string;
}

export interface Zone1Technical {
  volumePower: number;
  spikeRatio: number;
  maDivergence: number;
  orderImbalance: number;
  support: number;
  resistance: number;
  updatedAt: string;
}

export type FundamentalRiskFlag = "CLEAR" | "BLOCKED";

export interface Zone2Fundamental {
  symbol: string;
  riskFlag: FundamentalRiskFlag;
  issues: string[];
  checkedAt: string;
}

export type PatternClass = "CLASS_A" | "CLASS_B" | "CLASS_C";

export interface Zone3PatternMatch {
  klass: PatternClass;
  similarity: number;
  matchedPatternId: string;
  updatedAt: string;
}

export type MadnessStage = "STAGE_1" | "STAGE_2" | "STAGE_3";

export interface Zone4Madness {
  score: number;
  stage: MadnessStage;
  sentiment: number;
  newsVelocity: number;
  updatedAt: string;
}

export interface Zone6HistoryFeedback {
  similarTradeId: string;
  winRate: number;
  summary: string;
  updatedAt: string;
}

export type DecisionAction = "BUY" | "SELL" | "PASS";

export interface Zone5Decision {
  decisionId: string;
  action: DecisionAction;
  confidenceScore: number;
  reasoning: string;
  targetPrice?: number;
  stopPrice?: number;
  suggestedWeightPct: number;
  generatedAt: string;
}

export interface DashboardSnapshot {
  network: NetworkServiceStatus[];
  account: AccountSnapshot;
  killSwitchOn: boolean;
  targetSymbol: string;
  tick: Zone0Tick;
  technical: Zone1Technical;
  fundamental: Zone2Fundamental;
  pattern: Zone3PatternMatch;
  madness: Zone4Madness;
  history: Zone6HistoryFeedback;
  decision: Zone5Decision;
  positions: Position[];
  orderLog: OrderLogEntry[];
  lastUpdatedAt: string;
}

export interface DashboardUpdateEvent {
  type: "SNAPSHOT";
  payload: DashboardSnapshot;
}

export const SOCKET_EVENTS = {
  INIT: "dashboard:init",
  UPDATE: "dashboard:update",
  COMMAND_KILL_SWITCH: "command:kill-switch",
  COMMAND_MANUAL_ORDER: "command:manual-order"
} as const;

export function createEmptyDashboardSnapshot(): DashboardSnapshot {
  const now = new Date().toISOString();

  return {
    network: [
      {
        name: "KIS_API",
        endpoint: "wss://openapi.koreainvestment.com",
        state: "UP",
        updatedAt: now
      },
      {
        name: "ORACLE_26AI",
        endpoint: "192.168.0.120:1521/AI_DB",
        state: "UP",
        updatedAt: now
      },
      {
        name: "LOCAL_LLM",
        endpoint: "192.168.0.3:11434",
        state: "UP",
        updatedAt: now
      }
    ],
    account: {
      totalAssets: 50_000_000,
      cashAvailable: 15_000_000,
      realizedPnlPct: 0
    },
    killSwitchOn: false,
    targetSymbol: "005930",
    tick: {
      symbol: "005930",
      price: 71_000,
      volume: 10_000,
      bidDepth: 210_000,
      askDepth: 190_000,
      timestamp: now
    },
    technical: {
      volumePower: 101,
      spikeRatio: 80,
      maDivergence: 0,
      orderImbalance: 0.9,
      support: 70_700,
      resistance: 71_500,
      updatedAt: now
    },
    fundamental: {
      symbol: "005930",
      riskFlag: "CLEAR",
      issues: [],
      checkedAt: now
    },
    pattern: {
      klass: "CLASS_B",
      similarity: 0.56,
      matchedPatternId: "PATTERN_BOOTSTRAP",
      updatedAt: now
    },
    madness: {
      score: 35,
      stage: "STAGE_1",
      sentiment: 0.12,
      newsVelocity: 14,
      updatedAt: now
    },
    history: {
      similarTradeId: "HIST_BOOTSTRAP",
      winRate: 0.5,
      summary: "초기 상태",
      updatedAt: now
    },
    decision: {
      decisionId: "DEC_BOOTSTRAP",
      action: "PASS",
      confidenceScore: 0.5,
      reasoning: "시스템 초기화 상태",
      suggestedWeightPct: 0,
      generatedAt: now
    },
    positions: [],
    orderLog: [],
    lastUpdatedAt: now
  };
}

