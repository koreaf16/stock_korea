import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import readline from "node:readline";

import oracledb from "oracledb";

export interface Zone3MineParams {
  startDate: string;
  endDate: string;
  symbols: string[];
}

export interface Zone3MiningStats {
  totalPatterns: number;
  classA: number;
  classC: number;
  classARatio: number;
  classCRatio: number;
  lastUpdatedAt: string | null;
}

export interface Zone3MiningState {
  running: boolean;
  progress: number;
  startedAt: string | null;
  updatedAt: string | null;
  params: Zone3MineParams | null;
  processed: number;
  inserted: number;
  lastMessage: string;
  lastError: string | null;
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
  stats?: Zone3MiningStats;
}

export interface Zone3MinerManager {
  startMining: (params: Zone3MineParams) => Promise<Zone3MiningState>;
  getStatus: () => Zone3MiningState;
  getStats: () => Promise<Zone3MiningStats>;
  stopMining: () => void;
}

interface OracleEnv {
  user: string;
  password: string;
  connectString: string;
}

export function createZone3MinerManager(onEvent: (event: Zone3MiningSocketEvent) => void): Zone3MinerManager {
  let state: Zone3MiningState = {
    running: false,
    progress: 0,
    startedAt: null,
    updatedAt: null,
    params: null,
    processed: 0,
    inserted: 0,
    lastMessage: "idle",
    lastError: null
  };
  let child: ChildProcessByStdio<null, Readable, Readable> | null = null;

  function emit(event: Omit<Zone3MiningSocketEvent, "timestamp" | "running" | "progress"> & Partial<Pick<Zone3MiningSocketEvent, "running" | "progress">>): void {
    const now = new Date().toISOString();
    state = {
      ...state,
      running: event.running ?? state.running,
      progress: clampPercent(event.progress ?? state.progress),
      updatedAt: now,
      lastMessage: event.message || state.lastMessage,
      processed: event.processed ?? state.processed,
      inserted: event.inserted ?? state.inserted,
      lastError: event.type === "error" ? event.message : state.lastError
    };

    onEvent({
      timestamp: now,
      running: state.running,
      progress: state.progress,
      ...event
    });
  }

  async function startMining(params: Zone3MineParams): Promise<Zone3MiningState> {
    if (state.running) {
      throw new Error("Zone3 마이닝이 이미 실행 중입니다.");
    }

    const scriptPath = resolveMinerScriptPath();
    if (!scriptPath) {
      throw new Error("services/python/zone3_miner.py 경로를 찾을 수 없습니다.");
    }

    const command = (process.env.ZONE3_PYTHON_CMD ?? "python").trim();
    const [pythonCmd, ...prefix] = command.split(/\s+/).filter(Boolean);
    if (!pythonCmd) {
      throw new Error("ZONE3_PYTHON_CMD 설정이 비어 있습니다.");
    }

    const args = [
      ...prefix,
      scriptPath,
      "--start-date",
      params.startDate,
      "--end-date",
      params.endDate,
      "--symbols",
      params.symbols.join(","),
      "--vector-dim",
      String(Math.max(128, Number(process.env.ZONE3_VECTOR_DIM ?? 1024)))
    ];

    const proc = spawn(pythonCmd, args, {
      cwd: process.cwd(),
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    child = proc;

    state = {
      ...state,
      running: true,
      progress: 0,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      params,
      processed: 0,
      inserted: 0,
      lastMessage: "zone3 mining started",
      lastError: null
    };

    emit({
      type: "status",
      message: `Zone3 마이닝 시작 (${params.startDate} ~ ${params.endDate})`,
      running: true,
      progress: 0
    });

    attachProcessStream(proc.stdout, "info");
    attachProcessStream(proc.stderr, "error");

    proc.on("close", (code, signal) => {
      const finishedOk = code === 0;
      emit({
        type: finishedOk ? "completed" : "error",
        message: finishedOk
          ? `Zone3 마이닝 프로세스 종료(code=${code ?? 0})`
          : `Zone3 마이닝 실패(code=${code ?? -1}, signal=${signal ?? "-"})`,
        running: false,
        progress: finishedOk ? 100 : state.progress,
        level: finishedOk ? "info" : "error"
      });
      child = null;
      void pushStats();
    });

    proc.on("error", (error) => {
      emit({
        type: "error",
        message: `Zone3 마이닝 프로세스 에러: ${error.message}`,
        running: false,
        level: "error"
      });
      child = null;
    });

    return state;
  }

  function attachProcessStream(stream: NodeJS.ReadableStream, defaultLevel: "info" | "error"): void {
    const rl = readline.createInterface({ input: stream });
    rl.on("line", (line) => {
      const text = line.trim();
      if (!text) {
        return;
      }

      const parsed = parseJsonLine(text);
      if (!parsed) {
        emit({
          type: "log",
          message: text,
          level: defaultLevel
        });
        return;
      }

      const eventType = normalizeEventType(parsed.type);
      const progress = typeof parsed.progress === "number" ? parsed.progress : undefined;
      const processed = typeof parsed.processed === "number" ? parsed.processed : undefined;
      const inserted = typeof parsed.inserted === "number" ? parsed.inserted : undefined;
      const running = typeof parsed.running === "boolean" ? parsed.running : undefined;
      const message = String(parsed.message ?? text);
      const level = normalizeLogLevel(parsed.level, defaultLevel);

      emit({
        type: eventType,
        message,
        progress,
        processed,
        inserted,
        running,
        level
      });
    });
  }

  function stopMining(): void {
    if (!child) {
      return;
    }
    child.kill("SIGTERM");
    child = null;
    emit({
      type: "status",
      message: "Zone3 마이닝 중지 요청",
      running: false,
      level: "warn"
    });
  }

  function getStatus(): Zone3MiningState {
    return { ...state, params: state.params ? { ...state.params, symbols: [...state.params.symbols] } : null };
  }

  async function getStats(): Promise<Zone3MiningStats> {
    const oracleEnv = readOracleEnv();
    if (!oracleEnv) {
      return {
        totalPatterns: 0,
        classA: 0,
        classC: 0,
        classARatio: 0,
        classCRatio: 0,
        lastUpdatedAt: null
      };
    }

    let conn: oracledb.Connection | null = null;
    try {
      conn = await oracledb.getConnection({
        user: oracleEnv.user,
        password: oracleEnv.password,
        connectString: oracleEnv.connectString
      });
      const result = await conn.execute<{
        TOTAL_PATTERNS: number;
        CLASS_A: number;
        CLASS_C: number;
        LAST_UPDATED_AT: string | null;
      }>(
        `
        select
          count(*) as total_patterns,
          sum(case when klass = 'CLASS_A' then 1 else 0 end) as class_a,
          sum(case when klass = 'CLASS_C' then 1 else 0 end) as class_c,
          to_char(max(updated_at), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_updated_at
        from TB_ZONE3_PATTERN_LIBRARY
        `
      );
      const row = (result.rows?.[0] ?? {}) as {
        TOTAL_PATTERNS?: number;
        CLASS_A?: number;
        CLASS_C?: number;
        LAST_UPDATED_AT?: string | null;
      };
      const total = Number(row.TOTAL_PATTERNS ?? 0);
      const classA = Number(row.CLASS_A ?? 0);
      const classC = Number(row.CLASS_C ?? 0);
      return {
        totalPatterns: total,
        classA,
        classC,
        classARatio: total > 0 ? classA / total : 0,
        classCRatio: total > 0 ? classC / total : 0,
        lastUpdatedAt: row.LAST_UPDATED_AT ?? null
      };
    } finally {
      if (conn) {
        await conn.close();
      }
    }
  }

  async function pushStats(): Promise<void> {
    try {
      const stats = await getStats();
      emit({
        type: "stats",
        message: "Zone3 패턴 라이브러리 통계 갱신",
        stats
      });
    } catch (error) {
      emit({
        type: "log",
        message: `Zone3 통계 조회 실패: ${error instanceof Error ? error.message : String(error)}`,
        level: "warn"
      });
    }
  }

  return {
    startMining,
    getStatus,
    getStats,
    stopMining
  };
}

function parseJsonLine(text: string): Record<string, unknown> | null {
  if (!text.startsWith("{")) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeEventType(raw: unknown): Zone3MiningSocketEvent["type"] {
  const token = String(raw ?? "").toLowerCase();
  if (token === "status" || token === "progress" || token === "log" || token === "completed" || token === "error" || token === "stats") {
    return token;
  }
  return "log";
}

function normalizeLogLevel(raw: unknown, fallback: "info" | "error"): "info" | "warn" | "error" {
  const token = String(raw ?? "").toLowerCase();
  if (token === "info" || token === "warn" || token === "error") {
    return token;
  }
  return fallback === "error" ? "error" : "info";
}

function resolveMinerScriptPath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), "services/python/zone3_miner.py"),
    path.resolve(process.cwd(), "../../services/python/zone3_miner.py")
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function readOracleEnv(): OracleEnv | null {
  const user = process.env.ORACLE_USER?.trim();
  const password = process.env.ORACLE_PASSWORD?.trim();
  const connectString = process.env.ORACLE_CONNECTION_STRING?.trim();
  if (!user || !password || !connectString) {
    return null;
  }
  return { user, password, connectString };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(value)));
}
