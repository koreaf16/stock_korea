import type { AxiosError } from "axios";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_CODES = new Set(["ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"]);

export interface RetryOptions {
  context: string;
  maxAttempts?: number;
  baseDelayMs?: number;
}

export async function runWithRetry<T>(task: () => Promise<T>, options: RetryOptions): Promise<T> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const baseDelayMs = Math.max(50, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);

  let attempt = 0;
  let lastError: unknown;

  while (attempt < maxAttempts) {
    attempt += 1;

    try {
      return await task();
    } catch (error) {
      lastError = error;
      const retryable = isRetryableError(error);
      const exhausted = attempt >= maxAttempts;

      if (!retryable || exhausted) {
        throw error;
      }

      const waitMs = baseDelayMs * attempt;
      console.warn(`[zone0][retry] ${options.context} failed (attempt ${attempt}/${maxAttempts}), retrying in ${waitMs}ms`);
      await sleep(waitMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${options.context} failed`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const maybeAxiosError = error as Partial<AxiosError> & { code?: string };
  const code = String(maybeAxiosError.code ?? "").trim().toUpperCase();
  if (RETRYABLE_CODES.has(code)) {
    return true;
  }

  const status = Number(maybeAxiosError.response?.status);
  if (Number.isFinite(status) && RETRYABLE_STATUS.has(status)) {
    return true;
  }

  return false;
}
