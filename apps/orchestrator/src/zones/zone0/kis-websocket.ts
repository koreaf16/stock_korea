import axios from "axios";
import { createDecipheriv } from "node:crypto";
import WebSocket from "ws";

import { runWithRetry } from "./http-retry.js";

const DEFAULT_SYMBOL = "005930";
const EXECUTION_TR_ID = "H0STCNT0";
const ORDERBOOK_TR_ID = "H0STASP0";
const APPROVAL_PATH = "/oauth2/Approval";

type KisLogger = Pick<Console, "info" | "warn" | "error" | "debug">;

interface KisEnv {
  appKey: string;
  appSecret: string;
  wsUrl: string;
  restUrl: string;
}

export interface KisExecutionTick {
  symbol: string;
  price: number;
  volume: number;
  volumePower: number;
  tradeTime: string;
  receivedAt: string;
  raw: string;
}

export interface KisOrderBookLevel {
  price: number;
  qty: number;
}

export interface KisOrderBook {
  symbol: string;
  asks: KisOrderBookLevel[];
  bids: KisOrderBookLevel[];
  totalAskDepth: number;
  totalBidDepth: number;
  tradeTime: string;
  receivedAt: string;
  raw: string;
}

export interface KisWebSocketOptions {
  targetSymbol?: string;
  targetSymbols?: string[];
  reconnectDelayMs?: number;
  logger?: KisLogger;
  onConnectionStateChange?: (connected: boolean) => void;
  onTick?: (tick: KisExecutionTick) => void;
  onOrderBook?: (orderBook: KisOrderBook) => void;
  onControlMessage?: (payload: unknown) => void;
}

interface ApprovalResponse {
  approval_key?: string;
}

interface RealtimeCryptoKey {
  key: string;
  iv: string;
}

export class KisWebSocketClient {
  private readonly env: KisEnv;
  private readonly reconnectDelayMs: number;
  private readonly logger: KisLogger;

  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private connecting = false;
  private connected = false;
  private approvalKey: string | null = null;
  private targetSymbols: string[];
  private readonly realtimeCryptoByTrId = new Map<string, RealtimeCryptoKey>();
  private readonly realtimeCryptoByTrSymbol = new Map<string, RealtimeCryptoKey>();
  private readonly onConnectionStateChange?: (connected: boolean) => void;
  private readonly onTick?: (tick: KisExecutionTick) => void;
  private readonly onOrderBook?: (orderBook: KisOrderBook) => void;
  private readonly onControlMessage?: (payload: unknown) => void;

  constructor(options: KisWebSocketOptions = {}) {
    this.env = loadKisEnv();
    const requestedSymbols =
      options.targetSymbols && options.targetSymbols.length > 0
        ? options.targetSymbols
        : [options.targetSymbol ?? DEFAULT_SYMBOL];
    this.targetSymbols = normalizeSymbolList(requestedSymbols);
    this.reconnectDelayMs = Math.max(500, options.reconnectDelayMs ?? 3_000);
    this.logger = options.logger ?? console;
    this.onConnectionStateChange = options.onConnectionStateChange;
    this.onTick = options.onTick;
    this.onOrderBook = options.onOrderBook;
    this.onControlMessage = options.onControlMessage;
  }

  public async start(symbolOrSymbols?: string | string[]): Promise<void> {
    // 1) 외부에서 타겟 종목(단일/복수)을 주입하면 런타임 감시 목록을 교체한다.
    if (Array.isArray(symbolOrSymbols) && symbolOrSymbols.length > 0) {
      this.targetSymbols = normalizeSymbolList(symbolOrSymbols);
    } else if (typeof symbolOrSymbols === "string" && symbolOrSymbols.trim()) {
      this.targetSymbols = normalizeSymbolList([symbolOrSymbols]);
    }

    this.stopped = false;
    await this.connect();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    this.setConnected(false);
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.approvalKey = null;
    this.realtimeCryptoByTrId.clear();
    this.realtimeCryptoByTrSymbol.clear();

    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      socket.removeAllListeners();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
    }
  }

  public getCurrentSymbol(): string {
    return this.targetSymbols[0] ?? DEFAULT_SYMBOL;
  }

  public getCurrentSymbols(): string[] {
    return [...this.targetSymbols];
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public async changeSymbol(nextSymbol: string): Promise<void> {
    await this.updateSymbols([nextSymbol]);
  }

  public async updateSymbols(nextSymbols: string[]): Promise<void> {
    const normalized = normalizeSymbolList(nextSymbols);
    const safeSymbols = normalized.length > 0 ? normalized : [DEFAULT_SYMBOL];
    const previous = new Set(this.targetSymbols);
    const next = new Set(safeSymbols);

    const toAdd = safeSymbols.filter((symbol) => !previous.has(symbol));
    const toRemove = this.targetSymbols.filter((symbol) => !next.has(symbol));
    this.targetSymbols = safeSymbols;

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.approvalKey) {
      return;
    }

    // 2) 이미 소켓이 열린 상태면 증분 구독/해제를 반영한다.
    for (const symbol of toRemove) {
      this.sendUnsubscribe(this.ws, this.approvalKey, EXECUTION_TR_ID, symbol);
      this.sendUnsubscribe(this.ws, this.approvalKey, ORDERBOOK_TR_ID, symbol);
    }
    for (const symbol of toAdd) {
      this.sendSubscribe(this.ws, this.approvalKey, EXECUTION_TR_ID, symbol);
      this.sendSubscribe(this.ws, this.approvalKey, ORDERBOOK_TR_ID, symbol);
    }

    this.logger.info(
      `[KIS][WS] 구독 심볼 갱신 완료: +${toAdd.length} / -${toRemove.length} / total=${this.targetSymbols.length}`
    );
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.connecting) {
      return;
    }

    this.connecting = true;

    try {
      // 3) WebSocket 연결 전에 REST API로 approval_key를 발급받는다.
      const approvalKey = await this.fetchApprovalKey();
      if (this.stopped) {
        return;
      }

      // 4) 발급받은 approval_key로 KIS WebSocket 서버에 접속한다.
      await this.openSocket(approvalKey);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[KIS][WS] 연결 실패: ${message}`);
      this.scheduleReconnect("initial-connect-failed");
    } finally {
      this.connecting = false;
    }
  }

  private async fetchApprovalKey(): Promise<string> {
    const url = buildUrl(this.env.restUrl, APPROVAL_PATH);
    const response = await runWithRetry(
      () =>
        axios.post<ApprovalResponse>(
          url,
          {
            grant_type: "client_credentials",
            appkey: this.env.appKey,
            secretkey: this.env.appSecret
          },
          {
            headers: {
              "Content-Type": "application/json; charset=utf-8"
            },
            timeout: 10_000
          }
        ),
      {
        context: "kis-approval"
      }
    );

    const approvalKey = response.data.approval_key;
    if (!approvalKey) {
      throw new Error("approval_key 발급 실패 (응답에 approval_key 없음)");
    }

    this.logger.info("[KIS][REST] approval_key 발급 완료");
    this.approvalKey = approvalKey;
    return approvalKey;
  }

  private async openSocket(approvalKey: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.env.wsUrl);
      let settled = false;

      const cleanupBeforeReject = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.removeAllListeners();
        reject(error);
      };

      socket.once("open", () => {
        settled = true;
        this.ws = socket;
        this.setConnected(true);
        this.logger.info(`[KIS][WS] 연결 성공: ${this.env.wsUrl}`);

        // 5) 소켓 연결 직후 감시 풀 전체에 대해 실시간 체결(H0STCNT0), 10호가(H0STASP0)를 구독한다.
        for (const symbol of this.targetSymbols) {
          this.sendSubscribe(socket, approvalKey, EXECUTION_TR_ID, symbol);
          this.sendSubscribe(socket, approvalKey, ORDERBOOK_TR_ID, symbol);
        }
        resolve();
      });

      socket.on("message", (rawData: WebSocket.RawData) => {
        this.handleIncomingMessage(rawData);
      });

      socket.on("close", (code: number, reasonBuffer: Buffer) => {
        const reasonText = reasonBuffer.toString("utf8");
        this.logger.warn(`[KIS][WS] 연결 종료 code=${code} reason=${reasonText || "-"}`);
        if (this.ws === socket) {
          this.ws = null;
        }
        this.setConnected(false);
        this.approvalKey = null;
        this.realtimeCryptoByTrId.clear();
        this.realtimeCryptoByTrSymbol.clear();
        if (!this.stopped) {
          this.scheduleReconnect("socket-close");
        }
      });

      socket.on("error", (error: Error) => {
        this.logger.error(`[KIS][WS] 소켓 에러: ${error.message}`);
        this.setConnected(false);
        if (!settled) {
          cleanupBeforeReject(error);
        }
      });
    });
  }

  private setConnected(next: boolean): void {
    if (this.connected === next) {
      return;
    }
    this.connected = next;
    this.onConnectionStateChange?.(next);
  }

  private sendSubscribe(socket: WebSocket, approvalKey: string, trId: string, symbol: string): void {
    this.sendControl(socket, approvalKey, "1", trId, symbol);
    this.logger.info(`[KIS][WS] ${trId} 구독 요청 전송: ${symbol}`);
  }

  private sendUnsubscribe(socket: WebSocket, approvalKey: string, trId: string, symbol: string): void {
    this.sendControl(socket, approvalKey, "2", trId, symbol);
    this.logger.info(`[KIS][WS] ${trId} 구독 해제 요청 전송: ${symbol}`);
  }

  private sendControl(socket: WebSocket, approvalKey: string, trType: "1" | "2", trId: string, symbol: string): void {
    const payload = {
      header: {
        approval_key: approvalKey,
        custtype: "P",
        tr_type: trType,
        "content-type": "utf-8"
      },
      body: {
        input: {
          tr_id: trId,
          tr_key: symbol
        }
      }
    };

    socket.send(JSON.stringify(payload));
  }

  private handleIncomingMessage(rawData: WebSocket.RawData): void {
    const text = toUtf8(rawData).trim();
    if (!text) {
      return;
    }

    if (text.startsWith("PINGPONG")) {
      this.logger.debug("[KIS][WS] PINGPONG 수신");
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(text);
      }
      return;
    }

    // 6) 제어 메시지(JSON)와 실시간 체결 텍스트를 분기 처리한다.
    if (text.startsWith("{")) {
      this.handleControlJson(text);
      return;
    }

    // 7) 실시간 텍스트는 split('|') + split('^') 방식으로 고정 파싱한다.
    const pipe = text.split("|");
    if (pipe.length < 4) {
      return;
    }

    const trId = pipe[1] ?? "";
    const payload = pipe[3];
    if (!trId || !payload) {
      return;
    }

    const dataType = pipe[0];
    const encrypted = dataType === "1";
    const decryptedPayload = encrypted ? this.decryptRealtimePayload(trId, payload) : payload;
    if (!decryptedPayload) {
      return;
    }

    const fallbackSymbol = this.targetSymbols[0] ?? DEFAULT_SYMBOL;

    if (trId === EXECUTION_TR_ID) {
      const tick = parseExecutionPayload(decryptedPayload, text, fallbackSymbol);
      if (!tick) {
        return;
      }

      this.logger.info(
        `[KIS][TICK] ${tick.symbol} | 현재가 ${tick.price.toLocaleString("ko-KR")} | 체결량 ${tick.volume.toLocaleString("ko-KR")} | 체결강도 ${tick.volumePower.toFixed(2)}`
      );
      this.onTick?.(tick);
      return;
    }

    if (trId === ORDERBOOK_TR_ID) {
      const orderBook = parseOrderBookPayload(decryptedPayload, text, fallbackSymbol);
      if (!orderBook) {
        return;
      }

      this.logger.debug(
        `[KIS][HOGA] ${orderBook.symbol} | 총매도 ${orderBook.totalAskDepth.toLocaleString("ko-KR")} | 총매수 ${orderBook.totalBidDepth.toLocaleString("ko-KR")}`
      );
      this.onOrderBook?.(orderBook);
    }
  }

  private handleControlJson(text: string): void {
    try {
      const parsed: unknown = JSON.parse(text);
      this.maybeStoreRealtimeCrypto(parsed);
      this.onControlMessage?.(parsed);
      this.logger.debug(`[KIS][WS][CTRL] ${text}`);
    } catch {
      this.logger.warn(`[KIS][WS][CTRL] JSON 파싱 실패: ${text}`);
    }
  }

  private maybeStoreRealtimeCrypto(payload: unknown): void {
    if (!payload || typeof payload !== "object") {
      return;
    }

    const root = payload as Record<string, unknown>;
    const header = root.header as Record<string, unknown> | undefined;
    const body = root.body as Record<string, unknown> | undefined;
    const output = body?.output as Record<string, unknown> | undefined;

    const trId = String(header?.tr_id ?? "").trim();
    const trKey = sanitizeSymbol(String(header?.tr_key ?? "").trim());
    const key = String(output?.key ?? "").trim();
    const iv = String(output?.iv ?? "").trim();
    if (!trId || !key || !iv) {
      return;
    }

    const crypto: RealtimeCryptoKey = { key, iv };
    this.realtimeCryptoByTrId.set(trId, crypto);
    this.realtimeCryptoByTrSymbol.set(`${trId}:${trKey}`, crypto);
  }

  private decryptRealtimePayload(trId: string, encryptedPayload: string): string | null {
    const symbolKeys = this.targetSymbols.map((symbol) => `${trId}:${symbol}`);
    let crypto: RealtimeCryptoKey | undefined;
    for (const candidate of symbolKeys) {
      const found = this.realtimeCryptoByTrSymbol.get(candidate);
      if (found) {
        crypto = found;
        break;
      }
    }
    if (!crypto) {
      crypto = this.realtimeCryptoByTrId.get(trId);
    }
    if (!crypto) {
      this.logger.warn(`[KIS][WS] 암호화 프레임 키 없음: tr_id=${trId}`);
      return null;
    }

    try {
      return decryptAes256CbcBase64(encryptedPayload, crypto.key, crypto.iv);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[KIS][WS] 암호화 프레임 복호화 실패(tr_id=${trId}): ${message}`);
      return null;
    }
  }

  private scheduleReconnect(reason: string): void {
    // 8) 장중 연결 끊김 대비: 단순 자동 재연결 스켈레톤.
    if (this.stopped || this.reconnectTimer) {
      return;
    }

    this.logger.warn(`[KIS][WS] ${reason}, ${this.reconnectDelayMs}ms 후 재연결`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, this.reconnectDelayMs);
  }
}

export function parseExecutionTick(message: string, fallbackSymbol = DEFAULT_SYMBOL): KisExecutionTick | null {
  const pipe = message.split("|");
  if (pipe.length < 4) {
    return null;
  }

  const dataType = pipe[0];
  const trId = pipe[1];
  const payload = pipe[3];
  if (dataType !== "0" || trId !== EXECUTION_TR_ID || !payload) {
    return null;
  }

  return parseExecutionPayload(payload, message, fallbackSymbol);
}

export function parseOrderBook(message: string, fallbackSymbol = DEFAULT_SYMBOL): KisOrderBook | null {
  const pipe = message.split("|");
  if (pipe.length < 4) {
    return null;
  }

  const dataType = pipe[0];
  const trId = pipe[1];
  const payload = pipe[3];
  if (dataType !== "0" || trId !== ORDERBOOK_TR_ID || !payload) {
    return null;
  }

  return parseOrderBookPayload(payload, message, fallbackSymbol);
}

function parseExecutionPayload(payload: string, raw: string, fallbackSymbol: string): KisExecutionTick | null {
  const fields = payload.split("^");
  if (fields.length === 0) {
    return null;
  }

  const symbol = fields[0] && fields[0].length > 0 ? fields[0] : fallbackSymbol;
  const tradeTime = fields[1] ?? "";

  // H0STCNT0 포맷은 브로커 스펙/채널별로 필드 위치가 다를 수 있어 우선순위 인덱스로 안전 파싱한다.
  const price = pickNumber(fields, [2, 1]);
  const volume = pickNumber(fields, [12, 13, 14], 0);
  const volumePower = pickNumber(fields, [18, 19, 20], 0);

  if (!Number.isFinite(price) || price <= 0) {
    return null;
  }

  return {
    symbol,
    price,
    volume: Number.isFinite(volume) ? volume : 0,
    volumePower: Number.isFinite(volumePower) ? volumePower : 0,
    tradeTime,
    receivedAt: new Date().toISOString(),
    raw
  };
}

function parseOrderBookPayload(payload: string, raw: string, fallbackSymbol: string): KisOrderBook | null {
  const fields = payload.split("^");
  if (fields.length < 10) {
    return null;
  }

  const symbol = fields[0] && fields[0].length > 0 ? fields[0] : fallbackSymbol;
  const tradeTime = fields[1] ?? "";

  // H0STASP0: [종목코드, 시각, 구분, 매도1호가, 매도1잔량, 매수1호가, 매수1잔량 ...]
  const asks: KisOrderBookLevel[] = [];
  const bids: KisOrderBookLevel[] = [];

  for (let level = 0; level < 10; level += 1) {
    const base = 3 + level * 4;
    const askPrice = pickNumber(fields, [base], 0);
    const askQty = pickNumber(fields, [base + 1], 0);
    const bidPrice = pickNumber(fields, [base + 2], 0);
    const bidQty = pickNumber(fields, [base + 3], 0);

    asks.push({ price: Math.max(0, askPrice), qty: Math.max(0, askQty) });
    bids.push({ price: Math.max(0, bidPrice), qty: Math.max(0, bidQty) });
  }

  const sumAsk = asks.reduce((acc, level) => acc + level.qty, 0);
  const sumBid = bids.reduce((acc, level) => acc + level.qty, 0);
  const totalAskDepth = pickNumber(fields, [43, 41], sumAsk);
  const totalBidDepth = pickNumber(fields, [44, 42], sumBid);

  return {
    symbol,
    asks,
    bids,
    totalAskDepth: Math.max(0, totalAskDepth),
    totalBidDepth: Math.max(0, totalBidDepth),
    tradeTime,
    receivedAt: new Date().toISOString(),
    raw
  };
}

function pickNumber(fields: string[], indices: number[], fallback = Number.NaN): number {
  for (const index of indices) {
    const raw = fields[index];
    const parsed = toNumber(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function toNumber(value: string | undefined): number {
  if (!value || value.length === 0) {
    return Number.NaN;
  }

  const normalized = value.includes(",") ? value.split(",").join("") : value;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function loadKisEnv(): KisEnv {
  return {
    appKey: requiredEnv("KIS_APP_KEY"),
    appSecret: requiredEnv("KIS_APP_SECRET"),
    wsUrl: requiredEnv("KIS_WS_URL"),
    restUrl: requiredEnv("KIS_REST_URL")
  };
}

function requiredEnv(name: "KIS_APP_KEY" | "KIS_APP_SECRET" | "KIS_WS_URL" | "KIS_REST_URL"): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`[KIS] 필수 환경변수 누락: ${name}`);
  }
  return value;
}

function sanitizeSymbol(symbol: string): string {
  const trimmed = symbol.trim();
  if (!trimmed) {
    return DEFAULT_SYMBOL;
  }

  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length >= 6) {
    return digits.slice(0, 6);
  }
  if (digits.length > 0) {
    return digits.padStart(6, "0");
  }

  return DEFAULT_SYMBOL;
}

function normalizeSymbolList(symbols: string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const raw of symbols) {
    const symbol = sanitizeSymbol(raw);
    if (seen.has(symbol)) {
      continue;
    }

    seen.add(symbol);
    deduped.push(symbol);
  }

  if (deduped.length === 0) {
    deduped.push(DEFAULT_SYMBOL);
  }

  return deduped;
}

function buildUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${normalizedBase}${path}`;
}

function toUtf8(rawData: WebSocket.RawData): string {
  if (typeof rawData === "string") {
    return rawData;
  }
  if (rawData instanceof Buffer) {
    return rawData.toString("utf8");
  }
  if (Array.isArray(rawData)) {
    return Buffer.concat(rawData).toString("utf8");
  }
  if (rawData instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(rawData)).toString("utf8");
  }
  return Buffer.from(rawData.buffer, rawData.byteOffset, rawData.byteLength).toString("utf8");
}

function decryptAes256CbcBase64(cipherText: string, key: string, iv: string): string {
  const algorithm = "aes-256-cbc";
  const keyBuf = Buffer.from(key, "utf8");
  const ivBuf = Buffer.from(iv, "utf8");
  const decipher = createDecipheriv(algorithm, keyBuf, ivBuf);
  let decoded = decipher.update(cipherText, "base64", "utf8");
  decoded += decipher.final("utf8");
  return decoded.trim();
}
