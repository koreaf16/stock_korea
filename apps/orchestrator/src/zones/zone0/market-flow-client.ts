import axios, { type AxiosRequestConfig } from "axios";

import { runWithRetry } from "./http-retry.js";

type MarketFlowProvider = "AUTO" | "KOSCOM" | "KRX";
type MarketFlowSource = "KOSCOM" | "KRX";

const DEFAULT_TIMEOUT_MS = 8_000;

export interface MarketFlowSnapshot {
  symbol: string;
  foreignNetBuyQty: number;
  institutionalNetBuyQty: number;
  shortBalanceQty: number;
  source: MarketFlowSource;
  fetchedAt: string;
}

export interface MarketFlowClientOptions {
  provider?: MarketFlowProvider;
  timeoutMs?: number;
  koscomUrl?: string;
  koscomApiKey?: string;
  krxUrl?: string;
  krxApiKey?: string;
  krxBld?: string;
  krxUsePost?: boolean;
}

export class MarketFlowClient {
  private readonly provider: MarketFlowProvider;
  private readonly timeoutMs: number;
  private readonly koscomUrl: string;
  private readonly koscomApiKey: string;
  private readonly krxUrl: string;
  private readonly krxApiKey: string;
  private readonly krxBld: string;
  private readonly krxUsePost: boolean;

  constructor(options: MarketFlowClientOptions = {}) {
    this.provider = normalizeProvider(options.provider ?? process.env.ZONE0_MARKET_FLOW_PROVIDER);
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? Number(process.env.ZONE0_MARKET_FLOW_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS));
    this.koscomUrl = String(options.koscomUrl ?? process.env.KOSCOM_MARKET_FLOW_URL ?? "").trim();
    this.koscomApiKey = String(options.koscomApiKey ?? process.env.KOSCOM_API_KEY ?? "").trim();
    this.krxUrl = String(options.krxUrl ?? process.env.KRX_MARKET_FLOW_URL ?? "").trim();
    this.krxApiKey = String(options.krxApiKey ?? process.env.KRX_API_KEY ?? "").trim();
    this.krxBld = String(options.krxBld ?? process.env.KRX_MARKET_FLOW_BLD ?? "").trim();
    this.krxUsePost = parseBool(options.krxUsePost, process.env.KRX_MARKET_FLOW_USE_POST, true);
  }

  public get isEnabled(): boolean {
    if (this.provider === "KOSCOM") {
      return Boolean(this.koscomUrl);
    }
    if (this.provider === "KRX") {
      return Boolean(this.krxUrl);
    }
    return Boolean(this.koscomUrl || this.krxUrl);
  }

  public async fetchSymbol(symbol: string): Promise<MarketFlowSnapshot | null> {
    const normalized = sanitizeSymbol(symbol);
    if (!normalized || !this.isEnabled) {
      return null;
    }

    if (this.provider === "KOSCOM") {
      return this.fetchFromKoscom(normalized);
    }

    if (this.provider === "KRX") {
      return this.fetchFromKrx(normalized);
    }

    const koscom = await this.fetchFromKoscom(normalized).catch(() => null);
    if (koscom) {
      return koscom;
    }

    return this.fetchFromKrx(normalized).catch(() => null);
  }

  private async fetchFromKoscom(symbol: string): Promise<MarketFlowSnapshot | null> {
    if (!this.koscomUrl) {
      return null;
    }

    const headers: Record<string, string> = {};
    if (this.koscomApiKey) {
      headers["X-API-KEY"] = this.koscomApiKey;
      headers.Authorization = `Bearer ${this.koscomApiKey}`;
    }

    const payload = await runWithRetry(
      async () => {
        const config: AxiosRequestConfig = {
          timeout: this.timeoutMs,
          params: {
            symbol
          },
          headers
        };
        const response = await axios.get<unknown>(this.koscomUrl, config);
        return response.data;
      },
      {
        context: `market-flow:koscom:${symbol}`
      }
    );

    return parseMarketFlowPayload(payload, symbol, "KOSCOM");
  }

  private async fetchFromKrx(symbol: string): Promise<MarketFlowSnapshot | null> {
    if (!this.krxUrl) {
      return null;
    }

    const headers: Record<string, string> = {
      Accept: "application/json, text/plain, */*"
    };
    if (this.krxApiKey) {
      headers["X-API-KEY"] = this.krxApiKey;
      headers.Authorization = `Bearer ${this.krxApiKey}`;
    }

    const payload = await runWithRetry(
      async () => {
        if (this.krxUsePost) {
          const body = new URLSearchParams();
          body.set("symbol", symbol);
          if (this.krxBld) {
            body.set("bld", this.krxBld);
          }

          const response = await axios.post<unknown>(this.krxUrl, body.toString(), {
            timeout: this.timeoutMs,
            headers: {
              ...headers,
              "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
            }
          });
          return response.data;
        }

        const response = await axios.get<unknown>(this.krxUrl, {
          timeout: this.timeoutMs,
          headers,
          params: {
            symbol,
            bld: this.krxBld || undefined
          }
        });
        return response.data;
      },
      {
        context: `market-flow:krx:${symbol}`
      }
    );

    return parseMarketFlowPayload(payload, symbol, "KRX");
  }
}

function parseMarketFlowPayload(payload: unknown, symbol: string, source: MarketFlowSource): MarketFlowSnapshot | null {
  const record = findBestRecord(payload, symbol);
  if (!record) {
    return null;
  }

  const foreignNetBuyQty = readNumber(record, [
    "foreignNetBuyQty",
    "foreign_net_buy_qty",
    "frgnNetBuyQty",
    "frgn_ntby_qty",
    "FRGN_NTBY_QTY",
    "frgn_ntby_trdvol",
    "FRGN_NTBY_TRDVOL",
    "frgn_net_buy",
    "FRGN_NET_BUY"
  ]);
  const institutionalNetBuyQty = readNumber(record, [
    "institutionalNetBuyQty",
    "institution_net_buy_qty",
    "instNetBuyQty",
    "orgn_ntby_qty",
    "ORGN_NTBY_QTY",
    "inst_ntby_qty",
    "INST_NTBY_QTY",
    "기관순매수",
    "기관순매수량"
  ]);
  const shortBalanceQty = readNumber(record, [
    "shortBalanceQty",
    "short_balance_qty",
    "shortBalance",
    "short_balance",
    "shortSellingBalance",
    "short_selling_balance",
    "공매도잔고",
    "공매도잔고수량"
  ]);

  if (!Number.isFinite(foreignNetBuyQty) || !Number.isFinite(institutionalNetBuyQty) || !Number.isFinite(shortBalanceQty)) {
    return null;
  }

  return {
    symbol,
    foreignNetBuyQty,
    institutionalNetBuyQty,
    shortBalanceQty,
    source,
    fetchedAt: new Date().toISOString()
  };
}

function findBestRecord(payload: unknown, symbol: string): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const direct = payload as Record<string, unknown>;
  if (hasMarketFields(direct)) {
    return direct;
  }

  const candidates = [
    direct.output,
    direct.data,
    direct.result,
    direct.results,
    direct.list,
    direct.rows,
    direct.block1,
    direct.OutBlock_1
  ];

  for (const candidate of candidates) {
    const record = pickRecord(candidate, symbol);
    if (record) {
      return record;
    }
  }

  return null;
}

function pickRecord(candidate: unknown, symbol: string): Record<string, unknown> | null {
  if (!candidate) {
    return null;
  }

  if (Array.isArray(candidate)) {
    for (const item of candidate) {
      if (!item || typeof item !== "object") {
        continue;
      }
      const record = item as Record<string, unknown>;
      const recordSymbol = String(
        record.symbol ?? record.isuCd ?? record.ISU_CD ?? record.code ?? record.item_code ?? record["종목코드"] ?? ""
      ).trim();

      if (!recordSymbol || recordSymbol === symbol) {
        if (hasMarketFields(record)) {
          return record;
        }
      }
    }

    for (const item of candidate) {
      if (item && typeof item === "object" && hasMarketFields(item as Record<string, unknown>)) {
        return item as Record<string, unknown>;
      }
    }
    return null;
  }

  if (typeof candidate === "object" && hasMarketFields(candidate as Record<string, unknown>)) {
    return candidate as Record<string, unknown>;
  }

  return null;
}

function hasMarketFields(record: Record<string, unknown>): boolean {
  return (
    hasAnyKey(record, ["foreignNetBuyQty", "foreign_net_buy_qty", "frgn_ntby_qty", "FRGN_NTBY_QTY", "frgn_net_buy"]) &&
    hasAnyKey(record, ["institutionalNetBuyQty", "institution_net_buy_qty", "orgn_ntby_qty", "ORGN_NTBY_QTY", "inst_ntby_qty"]) &&
    hasAnyKey(record, ["shortBalanceQty", "short_balance_qty", "short_balance", "short_selling_balance", "공매도잔고"])
  );
}

function hasAnyKey(record: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => key in record);
}

function readNumber(record: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    if (!(key in record)) {
      continue;
    }

    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }

    const text = String(value ?? "")
      .replace(/,/g, "")
      .trim();
    const parsed = Number(text);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Number.NaN;
}

function parseBool(primary: boolean | undefined, raw: string | undefined, fallback: boolean): boolean {
  if (typeof primary === "boolean") {
    return primary;
  }

  const normalized = String(raw ?? "")
    .trim()
    .toLowerCase();

  if (normalized === "true" || normalized === "1" || normalized === "yes") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no") {
    return false;
  }
  return fallback;
}

function sanitizeSymbol(symbol: string): string {
  return String(symbol).trim();
}

function normalizeProvider(raw?: string): MarketFlowProvider {
  const normalized = String(raw ?? "AUTO")
    .trim()
    .toUpperCase();

  if (normalized === "KOSCOM" || normalized === "KRX") {
    return normalized;
  }
  return "AUTO";
}
