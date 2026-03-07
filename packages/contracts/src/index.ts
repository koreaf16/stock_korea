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
  volumePower?: number;
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
  riskScore: number;
  ruleRiskScore: number;
  vectorRiskScore: number;
  similarPumpScore: number;
  similarDelistScore: number;
  disclosureToxicityScore: number;
  vectorLatencyMs: number;
  safeMode: boolean;
  issues: string[];
  checkedAt: string;
}

export interface GlobalMacroContext {
  usdKrw: number;
  us10yYield: number;
  updatedAt: string;
  usdKrwSource: string;
  us10ySource: string;
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

export interface WatchPoolItem {
  symbol: string;
  spikeRatio: number;
  volumePower: number;
  maDivergence: number;
  lastPrice: number;
  updatedAt: string;
}

export interface DashboardSnapshot {
  network: NetworkServiceStatus[];
  account: AccountSnapshot;
  killSwitchOn: boolean;
  targetSymbol: string;
  targetReason: string;
  watchPool: WatchPoolItem[];
  globalContext: GlobalMacroContext;
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

export interface Zone3MiningSocketEvent {
  type: "status" | "progress" | "log" | "completed" | "error" | "stats";
  timestamp: string;
  running: boolean;
  progress: number;
  message: string;
  level?: "info" | "warn" | "error";
  processed?: number;
  inserted?: number;
  stats?: {
    totalPatterns: number;
    classA: number;
    classC: number;
    classARatio: number;
    classCRatio: number;
    lastUpdatedAt: string | null;
  };
}

export const SOCKET_EVENTS = {
  INIT: "dashboard:init",
  UPDATE: "dashboard:update",
  ZONE0_RAW: "zone0:raw",
  ZONE3_MINING: "zone3:mining",
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
        state: "DOWN",
        updatedAt: now
      },
      {
        name: "ORACLE_26AI",
        endpoint: "192.168.0.120:1521/AI_DB",
        state: "DOWN",
        updatedAt: now
      },
      {
        name: "LOCAL_LLM",
        endpoint: "192.168.0.3:11434",
        state: "DOWN",
        updatedAt: now
      }
    ],
    account: {
      totalAssets: 0,
      cashAvailable: 0,
      realizedPnlPct: 0
    },
    killSwitchOn: false,
    targetSymbol: "UNKNOWN",
    targetReason: "초기 상태: 타겟 탐색 대기",
    watchPool: [],
    globalContext: {
      usdKrw: 0,
      us10yYield: 0,
      updatedAt: now,
      usdKrwSource: "NO_DATA",
      us10ySource: "NO_DATA"
    },
    tick: {
      symbol: "UNKNOWN",
      price: 0,
      volume: 0,
      bidDepth: 0,
      askDepth: 0,
      timestamp: now
    },
    technical: {
      volumePower: 0,
      spikeRatio: 0,
      maDivergence: 0,
      orderImbalance: 0,
      support: 0,
      resistance: 0,
      updatedAt: now
    },
    fundamental: {
      symbol: "UNKNOWN",
      riskFlag: "BLOCKED",
      riskScore: 1,
      ruleRiskScore: 1,
      vectorRiskScore: 1,
      similarPumpScore: 0,
      similarDelistScore: 1,
      disclosureToxicityScore: 1,
      vectorLatencyMs: 0,
      safeMode: true,
      issues: ["실데이터 대기"],
      checkedAt: now
    },
    pattern: {
      klass: "CLASS_B",
      similarity: 0,
      matchedPatternId: "NO_DATA",
      updatedAt: now
    },
    madness: {
      score: 0,
      stage: "STAGE_1",
      sentiment: 0,
      newsVelocity: 0,
      updatedAt: now
    },
    history: {
      similarTradeId: "HIST_NONE",
      winRate: 0,
      summary: "실거래 이력 대기",
      updatedAt: now
    },
    decision: {
      decisionId: "DEC_INIT",
      action: "PASS",
      confidenceScore: 0,
      reasoning: "실데이터 수신 전",
      suggestedWeightPct: 0,
      generatedAt: now
    },
    positions: [],
    orderLog: [],
    lastUpdatedAt: now
  };
}
