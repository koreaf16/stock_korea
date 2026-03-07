import axios, { type AxiosInstance } from "axios";
import { load as loadHtml } from "cheerio";

import { runWithRetry } from "./http-retry.js";

const NAVER_OPENAPI_ENDPOINT = "https://openapi.naver.com/v1/search/news.json";
const NAVER_FINANCE_BASE_URL = "https://finance.naver.com";
const NAVER_MAIN_NEWS_URL = `${NAVER_FINANCE_BASE_URL}/news/mainnews.naver`;
const NAVER_SYMBOL_NEWS_URL = `${NAVER_FINANCE_BASE_URL}/item/news_news.naver`;
const NAVER_CRAWL_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Referer: `${NAVER_FINANCE_BASE_URL}/`
};

const MAX_SEEN_LINKS = 50_000;
const MAX_KEYWORDS_PER_CALL = 15;
const MAX_SYMBOL_CODES_PER_CALL = 4;
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
  crawlEnabled?: boolean;
}

export class NaverNewsClient {
  private readonly enabled: boolean;
  private readonly openApiEnabled: boolean;
  private readonly crawlEnabled: boolean;
  private readonly fetchCount: number;
  private readonly openApiHttp: AxiosInstance;
  private readonly crawlHttp: AxiosInstance;
  private readonly seenLinks = new Set<string>();
  private readonly seenQueue: string[] = [];

  constructor(options: NaverNewsClientOptions = {}) {
    const clientId = (options.clientId ?? process.env.NAVER_CLIENT_ID ?? "").trim();
    const clientSecret = (options.clientSecret ?? process.env.NAVER_CLIENT_SECRET ?? "").trim();
    this.openApiEnabled = Boolean(clientId && clientSecret);
    this.crawlEnabled = options.crawlEnabled ?? parseBool(process.env.ZONE0_NAVER_NEWS_CRAWL_ENABLED, true);
    this.enabled = this.openApiEnabled || this.crawlEnabled;
    this.fetchCount = Math.max(1, Math.min(100, options.fetchCount ?? DEFAULT_FETCH_COUNT));
    const timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    this.openApiHttp = axios.create({
      baseURL: NAVER_OPENAPI_ENDPOINT,
      timeout: timeoutMs,
      headers: {
        "Content-Type": "application/json",
        "X-Naver-Client-Id": clientId,
        "X-Naver-Client-Secret": clientSecret
      }
    });
    this.crawlHttp = axios.create({
      timeout: timeoutMs,
      headers: NAVER_CRAWL_HEADERS
    });
  }

  public get isEnabled(): boolean {
    return this.enabled;
  }

  public async fetchLatestByKeywords(keywords: string[]): Promise<NaverNewsArticle[]> {
    if (!this.enabled) {
      return [];
    }

    const uniqueKeywords = normalizeKeywords(keywords).slice(0, MAX_KEYWORDS_PER_CALL);
    if (uniqueKeywords.length === 0) {
      return [];
    }

    const collected: NaverNewsArticle[] = [];

    if (this.openApiEnabled) {
      for (const keyword of uniqueKeywords) {
        const articles = await this.fetchByKeywordFromOpenApi(keyword);
        collected.push(...articles);
      }
    }

    if (this.crawlEnabled) {
      const crawled = await this.fetchByCrawl(uniqueKeywords);
      collected.push(...crawled);
    }

    return this.takeFreshArticles(collected);
  }

  private async fetchByKeywordFromOpenApi(keyword: string): Promise<NaverNewsArticle[]> {
    try {
      const response = await runWithRetry(
        () =>
          this.openApiHttp.get<NaverNewsApiResponse>("", {
            params: {
              query: keyword,
              display: this.fetchCount,
              sort: "date"
            }
          }),
        {
          context: `naver-news:openapi:${keyword}`
        }
      );

      const items = Array.isArray(response.data.items) ? response.data.items : [];
      return items
        .map((item) => ({
          keyword,
          title: normalizeWhitespace(stripTags(item.title ?? "")),
          description: normalizeWhitespace(stripTags(item.description ?? "")),
          link: normalizeLink(item.link),
          originallink: normalizeLink(item.originallink),
          publishedAt: toIso(item.pubDate)
        }))
        .filter((item) => Boolean(item.title && (item.link || item.originallink)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[zone0][naver-news] openapi fetch failed keyword="${keyword}": ${message}`);
      return [];
    }
  }

  private async fetchByCrawl(keywords: string[]): Promise<NaverNewsArticle[]> {
    const textKeywords = keywords.filter((keyword) => !isSymbolCode(keyword));
    const symbolCodes = keywords.filter(isSymbolCode).slice(0, MAX_SYMBOL_CODES_PER_CALL);
    const collected: NaverNewsArticle[] = [];

    const mainNewsHtml = await this.fetchHtmlPage(NAVER_MAIN_NEWS_URL, "naver-news:crawl:mainnews");
    if (mainNewsHtml) {
      collected.push(...parseMainNewsPage(mainNewsHtml, textKeywords));
    }

    for (const symbolCode of symbolCodes) {
      const symbolUrl = `${NAVER_SYMBOL_NEWS_URL}?code=${encodeURIComponent(symbolCode)}&page=1`;
      const symbolHtml = await this.fetchHtmlPage(symbolUrl, `naver-news:crawl:item:${symbolCode}`);
      if (!symbolHtml) {
        continue;
      }
      collected.push(...parseSymbolNewsPage(symbolHtml, symbolCode, textKeywords));
    }

    return collected;
  }

  private async fetchHtmlPage(url: string, context: string): Promise<string | null> {
    try {
      const response = await runWithRetry(
        () =>
          this.crawlHttp.get<string>(url, {
            responseType: "text"
          }),
        {
          context
        }
      );
      return response.data;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[zone0][naver-news] crawl failed (${context}): ${message}`);
      return null;
    }
  }

  private takeFreshArticles(articles: NaverNewsArticle[]): NaverNewsArticle[] {
    const fresh: NaverNewsArticle[] = [];

    for (const article of articles) {
      const link = normalizeLink(article.link || article.originallink);
      const originallink = normalizeLink(article.originallink || link);
      if (!link) {
        continue;
      }
      if (this.isDuplicateLink(link)) {
        continue;
      }

      fresh.push({
        keyword: article.keyword,
        title: normalizeWhitespace(article.title),
        description: normalizeWhitespace(article.description),
        link,
        originallink,
        publishedAt: toIso(article.publishedAt)
      });
    }

    fresh.sort((a, b) => toTimeMs(b.publishedAt) - toTimeMs(a.publishedAt));
    return fresh;
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

function parseMainNewsPage(html: string, textKeywords: string[]): NaverNewsArticle[] {
  const $ = loadHtml(html);
  const rows = $("li.block1").toArray();
  const articles: NaverNewsArticle[] = [];

  for (const row of rows) {
    const anchor = $(row).find("dd.articleSubject a").first();
    if (anchor.length === 0) {
      continue;
    }

    const title = normalizeWhitespace(anchor.text());
    if (!title) {
      continue;
    }

    const link = toAbsoluteNaverLink(anchor.attr("href"));
    if (!link) {
      continue;
    }

    const summaryNode = $(row).find("dd.articleSummary").first().clone();
    const dateText = normalizeWhitespace(summaryNode.find("span.wdate").first().text());
    summaryNode.find("span").remove();
    const description = normalizeWhitespace(stripTags(summaryNode.text()));
    const sourceText = `${title} ${description}`.trim();
    const matchedKeyword = findMatchedKeyword(sourceText, textKeywords);
    if (textKeywords.length > 0 && !matchedKeyword) {
      continue;
    }

    articles.push({
      keyword: matchedKeyword ?? "MAINNEWS",
      title,
      description,
      link,
      originallink: link,
      publishedAt: parseNaverDate(dateText)
    });
  }

  // 선택자가 바뀌는 경우를 대비한 fallback.
  if (articles.length > 0) {
    return articles;
  }

  const fallbackAnchors = $("a[href*='/news/news_read.naver?']").toArray();
  for (const element of fallbackAnchors) {
    const anchor = $(element);
    const title = normalizeWhitespace(anchor.text());
    if (!title) {
      continue;
    }

    const link = toAbsoluteNaverLink(anchor.attr("href"));
    if (!link) {
      continue;
    }

    const matchedKeyword = findMatchedKeyword(title, textKeywords);
    if (textKeywords.length > 0 && !matchedKeyword) {
      continue;
    }

    articles.push({
      keyword: matchedKeyword ?? "MAINNEWS",
      title,
      description: "",
      link,
      originallink: link,
      publishedAt: new Date().toISOString()
    });
  }

  return articles;
}

function parseSymbolNewsPage(html: string, symbolCode: string, textKeywords: string[]): NaverNewsArticle[] {
  const $ = loadHtml(html);
  const rows = $("table.type5 tr").toArray();
  const articles: NaverNewsArticle[] = [];

  for (const row of rows) {
    const anchor = $(row).find("td.title a").first();
    if (anchor.length === 0) {
      continue;
    }

    const title = normalizeWhitespace(anchor.text());
    if (!title) {
      continue;
    }

    const link = toAbsoluteNaverLink(anchor.attr("href"));
    if (!link) {
      continue;
    }

    const firstCellText = normalizeWhitespace($(row).find("td").first().text());
    const trimmedBody = firstCellText.startsWith(title)
      ? normalizeWhitespace(firstCellText.slice(title.length))
      : firstCellText;
    const press = normalizeWhitespace($(row).find("td.info").first().text());
    const description = trimmedBody || press;
    const dateText = normalizeWhitespace($(row).find("td.date").first().text());
    const sourceText = `${title} ${description}`.trim();
    const matchedKeyword = findMatchedKeyword(sourceText, textKeywords);
    if (textKeywords.length > 0 && !matchedKeyword) {
      continue;
    }

    articles.push({
      keyword: matchedKeyword ?? symbolCode,
      title,
      description,
      link,
      originallink: link,
      publishedAt: parseNaverDate(dateText)
    });
  }

  return articles;
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

function findMatchedKeyword(sourceText: string, keywords: string[]): string | null {
  const haystack = normalizeWhitespace(sourceText).toLowerCase();
  if (!haystack) {
    return null;
  }

  for (const keyword of keywords) {
    const needle = keyword.toLowerCase().trim();
    if (!needle) {
      continue;
    }
    if (haystack.includes(needle)) {
      return keyword;
    }
  }
  return null;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, "");
}

function normalizeLink(link: string): string {
  const trimmed = String(link ?? "").trim();
  return trimmed || "";
}

function toAbsoluteNaverLink(href: string | undefined): string {
  const raw = normalizeLink(href ?? "");
  if (!raw) {
    return "";
  }
  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    return raw;
  }
  if (raw.startsWith("//")) {
    return `https:${raw}`;
  }
  if (raw.startsWith("/")) {
    return `${NAVER_FINANCE_BASE_URL}${raw}`;
  }
  return `${NAVER_FINANCE_BASE_URL}/${raw}`;
}

function parseNaverDate(value: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return new Date().toISOString();
  }

  const asNumber = Number(raw);
  if (Number.isFinite(asNumber) && asNumber > 0) {
    const millis = asNumber > 10_000_000_000 ? asNumber : asNumber * 1_000;
    return new Date(millis).toISOString();
  }

  const normalized = raw.replace(/\./g, "-").replace(/\//g, "-").replace(/\s+/g, " ");
  const isoCandidate = normalized.includes("T") ? normalized : normalized.replace(" ", "T");
  const parsed = new Date(isoCandidate);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return new Date().toISOString();
}

function normalizeWhitespace(value: string): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function toIso(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }
  return parsed.toISOString();
}

function toTimeMs(value: string): number {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function isSymbolCode(value: string): boolean {
  return /^\d{6}$/.test(value.trim());
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) {
    return fallback;
  }

  const normalized = String(raw).trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}
