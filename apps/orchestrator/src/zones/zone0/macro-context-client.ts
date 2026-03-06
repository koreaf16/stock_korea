import type { GlobalMacroContext } from "@stock/contracts";
import axios, { AxiosError } from "axios";

import { runWithRetry } from "./http-retry.js";

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_USDKRW_URL = "https://open.er-api.com/v6/latest/USD";
const DEFAULT_US10Y_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10";

export interface MacroContextClientOptions {
  timeoutMs?: number;
  usdKrwUrl?: string;
  us10yUrl?: string;
}

export class MacroContextClient {
  private readonly timeoutMs: number;
  private readonly usdKrwUrl: string;
  private readonly us10yUrl: string;

  constructor(options: MacroContextClientOptions = {}) {
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? Number(process.env.ZONE0_MACRO_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS));
    this.usdKrwUrl = String(options.usdKrwUrl ?? process.env.ZONE0_USDKRW_URL ?? DEFAULT_USDKRW_URL).trim();
    this.us10yUrl = String(options.us10yUrl ?? process.env.ZONE0_US10Y_URL ?? DEFAULT_US10Y_URL).trim();
  }

  public get isEnabled(): boolean {
    return Boolean(this.usdKrwUrl && this.us10yUrl);
  }

  public async fetchLatest(): Promise<GlobalMacroContext | null> {
    if (!this.isEnabled) {
      return null;
    }

    const [usdKrw, us10yYield] = await Promise.all([this.fetchUsdKrw(), this.fetchUs10yYield()]);
    if (!Number.isFinite(usdKrw) || !Number.isFinite(us10yYield)) {
      return null;
    }

    return {
      usdKrw,
      us10yYield,
      updatedAt: new Date().toISOString(),
      usdKrwSource: this.usdKrwUrl,
      us10ySource: this.us10yUrl
    };
  }

  private async fetchUsdKrw(): Promise<number> {
    const payload = await runWithRetry(
      async () => {
        const response = await axios.get<unknown>(this.usdKrwUrl, {
          timeout: this.timeoutMs
        });
        return response.data;
      },
      {
        context: "macro:usdkrw"
      }
    );

    const parsed = parseUsdKrw(payload);
    if (!Number.isFinite(parsed)) {
      throw new Error("USD/KRW parsing failed");
    }
    return parsed;
  }

  private async fetchUs10yYield(): Promise<number> {
    return runWithRetry(
      async () => {
        try {
          const response = await axios.get<unknown>(this.us10yUrl, {
            timeout: this.timeoutMs
          });
          const parsed = parseUs10y(response.data);
          if (!Number.isFinite(parsed)) {
            throw new Error("US10Y parsing failed");
          }
          return parsed;
        } catch (error) {
          if (error instanceof AxiosError && typeof error.response?.data === "string") {
            const parsed = parseUs10y(error.response.data);
            if (Number.isFinite(parsed)) {
              return parsed;
            }
          }
          throw error;
        }
      },
      {
        context: "macro:us10y"
      }
    );
  }
}

function parseUsdKrw(payload: unknown): number {
  if (!payload || typeof payload !== "object") {
    return Number.NaN;
  }

  const data = payload as Record<string, unknown>;
  const fromRates = readNestedNumber(data, ["rates", "KRW"]);
  if (Number.isFinite(fromRates)) {
    return fromRates;
  }

  const fromConversionRates = readNestedNumber(data, ["conversion_rates", "KRW"]);
  if (Number.isFinite(fromConversionRates)) {
    return fromConversionRates;
  }

  return Number.NaN;
}

function parseUs10y(payload: unknown): number {
  if (typeof payload === "number" && Number.isFinite(payload)) {
    return payload;
  }

  if (typeof payload === "string") {
    return parseUs10yFromString(payload);
  }

  if (!payload || typeof payload !== "object") {
    return Number.NaN;
  }

  const data = payload as Record<string, unknown>;
  const direct = readNumberCandidates(data, ["us10yYield", "yield10y", "DGS10", "dgs10", "value"]);
  if (Number.isFinite(direct)) {
    return direct;
  }

  const observations = data.observations;
  if (Array.isArray(observations)) {
    for (let idx = observations.length - 1; idx >= 0; idx -= 1) {
      const item = observations[idx];
      if (!item || typeof item !== "object") {
        continue;
      }
      const value = readNumberCandidates(item as Record<string, unknown>, ["value", "close", "yield"]);
      if (Number.isFinite(value)) {
        return value;
      }
    }
  }

  return Number.NaN;
}

function parseUs10yFromString(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) {
    return Number.NaN;
  }

  const lines = trimmed.split(/\r?\n/).map((line) => line.trim());
  for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
    const line = lines[idx];
    if (!line || line.startsWith("#")) {
      continue;
    }

    if (line.includes(",")) {
      const cols = line.split(",");
      const last = cols[cols.length - 1]?.trim() ?? "";
      const parsed = parseMaybeNumber(last);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
      continue;
    }

    const parsed = parseMaybeNumber(line);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return Number.NaN;
}

function readNestedNumber(source: Record<string, unknown>, path: string[]): number {
  let cursor: unknown = source;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object" || !(key in (cursor as Record<string, unknown>))) {
      return Number.NaN;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }

  if (typeof cursor === "number" && Number.isFinite(cursor)) {
    return cursor;
  }
  return parseMaybeNumber(String(cursor ?? ""));
}

function readNumberCandidates(source: Record<string, unknown>, keys: string[]): number {
  for (const key of keys) {
    if (!(key in source)) {
      continue;
    }
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    const parsed = parseMaybeNumber(String(value ?? ""));
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Number.NaN;
}

function parseMaybeNumber(text: string): number {
  const normalized = text.replace(/,/g, "").trim();
  if (!normalized || normalized === ".") {
    return Number.NaN;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
