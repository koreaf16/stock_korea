import axios from "axios";
import { load as loadHtml } from "cheerio";

import { runWithRetry } from "./zones/zone0/http-retry.js";

const NAVER_TIMEOUT_MS = Math.max(2_000, Number(process.env.SYMBOL_NAME_TIMEOUT_MS ?? 5_000));
const CACHE_TTL_MS = Math.max(300_000, Number(process.env.SYMBOL_NAME_CACHE_TTL_MS ?? 3_600_000));
const MAX_SYMBOL_BATCH = Math.max(1, Number(process.env.SYMBOL_NAME_MAX_BATCH ?? 40));

const NAVER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Referer: "https://finance.naver.com/"
};

interface CacheEntry {
  name: string;
  expiresAt: number;
}

const symbolNameCache = new Map<string, CacheEntry>();

export async function resolveSymbolNames(symbols: string[]): Promise<Record<string, string>> {
  const normalized = normalizeSymbolList(symbols).slice(0, MAX_SYMBOL_BATCH);
  const output: Record<string, string> = {};

  if (normalized.length === 0) {
    return output;
  }

  const now = Date.now();
  const misses: string[] = [];

  for (const symbol of normalized) {
    const cached = symbolNameCache.get(symbol);
    if (cached && cached.expiresAt > now) {
      output[symbol] = cached.name;
      continue;
    }
    misses.push(symbol);
  }

  await Promise.all(
    misses.map(async (symbol) => {
      try {
        const name = await runWithRetry(() => fetchNameFromNaver(symbol), {
          context: `symbol-name:${symbol}`
        });

        if (!name) {
          return;
        }

        output[symbol] = name;
        symbolNameCache.set(symbol, {
          name,
          expiresAt: Date.now() + CACHE_TTL_MS
        });
      } catch {
        // 네트워크 실패는 조용히 무시하고 코드만 표시하도록 폴백
      }
    })
  );

  return output;
}

async function fetchNameFromNaver(symbol: string): Promise<string | null> {
  const url = `https://finance.naver.com/item/main.naver?code=${encodeURIComponent(symbol)}`;
  const response = await axios.get<string>(url, {
    timeout: NAVER_TIMEOUT_MS,
    headers: NAVER_HEADERS,
    responseType: "text"
  });

  const $ = loadHtml(response.data);
  const title = $("title").first().text().trim();
  const ogTitle = $('meta[property="og:title"]').attr("content")?.trim() ?? "";

  const fromTitle = extractCompanyName(title);
  if (fromTitle) {
    return fromTitle;
  }

  const fromOgTitle = extractCompanyName(ogTitle);
  if (fromOgTitle) {
    return fromOgTitle;
  }

  return null;
}

function extractCompanyName(raw: string): string | null {
  const text = String(raw ?? "").trim();
  if (!text) {
    return null;
  }

  const head = text.split(":")[0]?.trim() ?? "";
  if (!head || head.length > 40) {
    return null;
  }

  if (/\d{6}/.test(head)) {
    return null;
  }

  return head;
}

function normalizeSymbolList(symbols: string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const raw of symbols) {
    const symbol = normalizeSymbol(raw);
    if (!symbol || seen.has(symbol)) {
      continue;
    }
    seen.add(symbol);
    deduped.push(symbol);
  }

  return deduped;
}

function normalizeSymbol(raw: string): string | null {
  const digits = String(raw ?? "").trim().replace(/[^\d]/g, "");
  if (digits.length < 6) {
    return null;
  }
  return digits.slice(0, 6);
}
