import axios, { type AxiosInstance } from "axios";

import { runWithRetry } from "./http-retry.js";

const NAVER_NEWS_ENDPOINT = "https://openapi.naver.com/v1/search/news.json";
const MAX_SEEN_LINKS = 50_000;
const DEFAULT_FETCH_COUNT = 20;
const DEFAULT_TIMEOUT_MS = 10_000;

interface NaverNewsApiItem {
  title: string;
  originallink: string;
  link: string;
  description: string;
  pubDate: string;
}

interface NaverNewsApiResponse {
  lastBuildDate?: string;
  total?: number;
  start?: number;
  display?: number;
  items?: NaverNewsApiItem[];
}

export interface NaverNewsArticle {
  keyword: string;
  title: string;
  description: string;
  link: string;
  originallink: string;
  publishedAt: string;
}

interface NaverNewsClientOptions {
  clientId?: string;
  clientSecret?: string;
  timeoutMs?: number;
  fetchCount?: number;
}

export class NaverNewsClient {
  private readonly enabled: boolean;
  private readonly fetchCount: number;
  private readonly http: AxiosInstance;
  private readonly seenLinks = new Set<string>();
  private readonly seenQueue: string[] = [];

  constructor(options: NaverNewsClientOptions = {}) {
    const clientId = (options.clientId ?? process.env.NAVER_CLIENT_ID ?? "").trim();
    const clientSecret = (options.clientSecret ?? process.env.NAVER_CLIENT_SECRET ?? "").trim();
    this.enabled = Boolean(clientId && clientSecret);
    this.fetchCount = Math.max(1, Math.min(100, options.fetchCount ?? DEFAULT_FETCH_COUNT));

    this.http = axios.create({
      baseURL: NAVER_NEWS_ENDPOINT,
      timeout: Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/json",
        "X-Naver-Client-Id": clientId,
        "X-Naver-Client-Secret": clientSecret
      }
    });
  }

  public get isEnabled(): boolean {
    return this.enabled;
  }

  public async fetchLatestByKeywords(keywords: string[]): Promise<NaverNewsArticle[]> {
    if (!this.enabled) {
      return [];
    }

    const uniqueKeywords = normalizeKeywords(keywords);
    if (uniqueKeywords.length === 0) {
      return [];
    }

    const collected: NaverNewsArticle[] = [];

    for (const keyword of uniqueKeywords) {
      const articles = await this.fetchByKeyword(keyword);
      for (const article of articles) {
        if (this.isDuplicateLink(article.link)) {
          continue;
        }
        collected.push(article);
      }
    }

    return collected;
  }

  private async fetchByKeyword(keyword: string): Promise<NaverNewsArticle[]> {
    try {
      const response = await runWithRetry(
        () =>
          this.http.get<NaverNewsApiResponse>("", {
            params: {
              query: keyword,
              display: this.fetchCount,
              sort: "date"
            }
          }),
        {
          context: `naver-news:${keyword}`
        }
      );

      const items = Array.isArray(response.data.items) ? response.data.items : [];
      return items
        .map((item) => ({
          keyword,
          title: stripTags(item.title ?? "").trim(),
          description: stripTags(item.description ?? "").trim(),
          link: normalizeLink(item.link),
          originallink: normalizeLink(item.originallink),
          publishedAt: toIso(item.pubDate)
        }))
        .filter((item) => Boolean(item.title && item.link));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[zone0][naver-news] fetch failed keyword="${keyword}": ${message}`);
      return [];
    }
  }

  private isDuplicateLink(link: string): boolean {
    if (!link) {
      return true;
    }

    if (this.seenLinks.has(link)) {
      return true;
    }

    this.seenLinks.add(link);
    this.seenQueue.push(link);
    if (this.seenQueue.length > MAX_SEEN_LINKS) {
      const oldest = this.seenQueue.shift();
      if (oldest) {
        this.seenLinks.delete(oldest);
      }
    }
    return false;
  }
}

function normalizeKeywords(keywords: string[]): string[] {
  const set = new Set<string>();
  for (const keyword of keywords) {
    const trimmed = String(keyword ?? "").trim();
    if (trimmed) {
      set.add(trimmed);
    }
  }
  return [...set];
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, "");
}

function normalizeLink(link: string): string {
  const trimmed = String(link ?? "").trim();
  if (!trimmed) {
    return "";
  }
  return trimmed;
}

function toIso(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }
  return parsed.toISOString();
}
