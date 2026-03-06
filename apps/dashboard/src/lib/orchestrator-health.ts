export interface OrchestratorHealth {
  ok: boolean;
  tickCount: number;
  zone0: {
    ticksBuffered: number;
    newsBuffered: number;
    boardBuffered: number;
    dartBuffered: number;
    fundamentalBuffered: number;
    macroBuffered: number;
    telegramBuffered: number;
    lastFrameAt: string | null;
  };
  zone1: {
    sessionDate: string;
    high: number;
    low: number;
    ma3: number;
    ma5: number;
  };
  zone2: {
    provider: string;
    source: string;
    cacheSize: number;
    lastCheckedAt: string | null;
  };
  zone3: {
    provider: string;
    source: string;
    candleCount: number;
    vectorDim: number;
    lastClass: string | null;
    lastSimilarity: number | null;
  };
  zone4: {
    provider: string;
    source: string;
    signalRate1m: number;
    lastScore: number | null;
    lastStage: string | null;
  };
  zone5: {
    provider: string;
    source: string;
    llmModel: string;
    lastDecisionId: string | null;
    lastAction: string | null;
    lastConfidence: number | null;
    lastError: string | null;
  };
  zone6: {
    provider: string;
    source: string;
    recordCount: number;
    lastSimilarTradeId: string | null;
    lastWinRate: number | null;
    lastIngestedTradeId: string | null;
    lastIngestedPnlPct: number | null;
    lastError: string | null;
  };
  now: string;
}

const ORCHESTRATOR_URL = process.env.NEXT_PUBLIC_ORCHESTRATOR_URL ?? "http://localhost:5001";

export async function fetchOrchestratorHealth(signal?: AbortSignal): Promise<OrchestratorHealth> {
  const response = await fetch(`${ORCHESTRATOR_URL}/health`, {
    method: "GET",
    headers: {
      "Content-Type": "application/json"
    },
    cache: "no-store",
    signal
  });

  if (!response.ok) {
    throw new Error(`health request failed (${response.status})`);
  }

  return (await response.json()) as OrchestratorHealth;
}
