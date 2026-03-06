import axios from "axios";

import { runWithRetry } from "./http-retry.js";

const DART_LIST_ENDPOINT = "https://opendart.fss.or.kr/api/list.json";
const MAX_SEEN_RECEIPTS = 20_000;
const DEFAULT_TIMEOUT_MS = 10_000;
const IMPACT_KEYWORDS = ["영업실적", "유상증자", "공급계약"];

interface DartDisclosureApiRow {
  corp_code: string;
  corp_name: string;
  report_nm: string;
  rcept_no: string;
  rcept_dt: string;
  flr_nm?: string;
}

interface DartDisclosureApiResponse {
  status?: string;
  message?: string;
  list?: DartDisclosureApiRow[];
}

export interface DartImpactDisclosure {
  corpCode: string;
  corpName: string;
  reportName: string;
  receiptNo: string;
  receiptDate: string;
  filerName: string;
  link: string;
  impactKeywords: string[];
  impactScore: number;
}

interface DartDisclosureClientOptions {
  apiKey?: string;
  timeoutMs?: number;
}

export class DartDisclosureClient {
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly enabled: boolean;
  private readonly seenReceipts = new Set<string>();
  private readonly seenQueue: string[] = [];

  constructor(options: DartDisclosureClientOptions = {}) {
    this.apiKey = (options.apiKey ?? process.env.DART_API_KEY ?? "").trim();
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.enabled = Boolean(this.apiKey);
  }

  public get isEnabled(): boolean {
    return this.enabled;
  }

  public async fetchRecentImpactDisclosures(withinHours = 1): Promise<DartImpactDisclosure[]> {
    if (!this.enabled) {
      return [];
    }

    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - Math.max(1, withinHours) * 60 * 60 * 1000);
    const bgnDate = formatYmd(oneHourAgo);
    const endDate = formatYmd(now);

    try {
      const response = await runWithRetry(
        () =>
          axios.get<DartDisclosureApiResponse>(DART_LIST_ENDPOINT, {
            timeout: this.timeoutMs,
            params: {
              crtfc_key: this.apiKey,
              bgn_de: bgnDate,
              end_de: endDate,
              page_count: 100
            }
          }),
        {
          context: "dart-disclosure"
        }
      );

      const status = response.data.status ?? "";
      if (status !== "000") {
        const message = response.data.message ?? "unknown";
        console.warn(`[zone0][dart] API 응답 비정상 status=${status} message=${message}`);
        return [];
      }

      const rows = Array.isArray(response.data.list) ? response.data.list : [];
      const parsed: DartImpactDisclosure[] = [];

      for (const row of rows) {
        const reportName = String(row.report_nm ?? "").trim();
        const receiptNo = String(row.rcept_no ?? "").trim();
        if (!reportName || !receiptNo || this.isDuplicateReceipt(receiptNo)) {
          continue;
        }

        const matchedKeywords = IMPACT_KEYWORDS.filter((keyword) => reportName.includes(keyword));
        if (matchedKeywords.length === 0) {
          continue;
        }

        parsed.push({
          corpCode: String(row.corp_code ?? "").trim(),
          corpName: String(row.corp_name ?? "").trim(),
          reportName,
          receiptNo,
          receiptDate: parseReceiptDate(row.rcept_dt),
          filerName: String(row.flr_nm ?? "").trim(),
          link: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${encodeURIComponent(receiptNo)}`,
          impactKeywords: matchedKeywords,
          impactScore: scoreImpact(matchedKeywords)
        });
      }

      parsed.sort((a, b) => {
        if (b.impactScore !== a.impactScore) {
          return b.impactScore - a.impactScore;
        }
        return b.receiptDate.localeCompare(a.receiptDate);
      });

      return parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[zone0][dart] fetch failed: ${message}`);
      return [];
    }
  }

  private isDuplicateReceipt(receiptNo: string): boolean {
    if (this.seenReceipts.has(receiptNo)) {
      return true;
    }

    this.seenReceipts.add(receiptNo);
    this.seenQueue.push(receiptNo);
    if (this.seenQueue.length > MAX_SEEN_RECEIPTS) {
      const oldest = this.seenQueue.shift();
      if (oldest) {
        this.seenReceipts.delete(oldest);
      }
    }
    return false;
  }
}

function formatYmd(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function parseReceiptDate(rawDate: string): string {
  const text = String(rawDate ?? "").trim();
  if (text.length === 8) {
    const yyyy = text.slice(0, 4);
    const mm = text.slice(4, 6);
    const dd = text.slice(6, 8);
    return new Date(`${yyyy}-${mm}-${dd}T00:00:00+09:00`).toISOString();
  }
  return new Date().toISOString();
}

function scoreImpact(keywords: string[]): number {
  let score = 0;
  for (const keyword of keywords) {
    if (keyword === "유상증자") {
      score += 4;
    } else if (keyword === "공급계약") {
      score += 3;
    } else {
      score += 2;
    }
  }
  return score;
}
