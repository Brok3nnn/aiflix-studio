import { setTimeout as delay } from 'node:timers/promises';
import { errorMessage, isAbortError, isNetworkError, ProviderError } from './errors.ts';

export interface RetryPolicy {
  /** Retries for transient failures: 5xx responses and network errors. */
  maxRetries: number;
  /** Retries for 429 responses, which usually clear once the quota window resets. */
  rateLimitMaxRetries: number;
  /** First backoff delay; doubles on every retry. */
  baseDelayMs: number;
  /** Wait on a 429 that carries no Retry-After. */
  rateLimitDelayMs: number;
  /** Upper bound for any single wait, including server-requested ones. */
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  rateLimitMaxRetries: 8,
  baseDelayMs: 2_000,
  rateLimitDelayMs: 30_000,
  maxDelayMs: 120_000,
};

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const sleep: Sleep = async (ms, signal) => {
  await delay(ms, undefined, { signal });
};

export interface RetryOptions {
  policy?: RetryPolicy;
  /** Receives a human-readable line for the job log before each wait. Must not throw. */
  notify?: (message: string) => Promise<void>;
  sleep?: Sleep;
  signal?: AbortSignal;
}

/**
 * Runs `task`, retrying retryable failures with exponential backoff. A 429 waits for the
 * server's Retry-After when it sends one. Content-policy rejections and other non-retryable
 * errors are rethrown immediately.
 */
export async function withRetry<T>(
  label: string,
  task: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const policy = options.policy ?? DEFAULT_RETRY_POLICY;
  const wait = options.sleep ?? sleep;

  for (let retry = 1; ; retry += 1) {
    try {
      return await task();
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) throw error;
      const plan = planRetry(error, retry, policy);
      if (!plan) throw error;

      const seconds = Math.round(plan.delayMs / 1000);
      const message = plan.rateLimited
        ? `Rate limited during ${label}; retrying in ${String(seconds)}s (${String(retry)}/${String(plan.maxRetries)}).`
        : `${label} failed (${plan.reason}); retrying in ${String(seconds)}s (${String(retry)}/${String(plan.maxRetries)}).`;
      await options.notify?.(message);
      await wait(plan.delayMs, options.signal);
    }
  }
}

interface RetryPlan {
  delayMs: number;
  maxRetries: number;
  rateLimited: boolean;
  reason: string;
}

/** Decides whether the `retry`-th retry should happen, and after how long. */
export function planRetry(error: unknown, retry: number, policy: RetryPolicy): RetryPlan | null {
  if (error instanceof ProviderError) {
    if (!error.retryable) return null;
    const maxRetries = error.rateLimited ? policy.rateLimitMaxRetries : policy.maxRetries;
    if (retry > maxRetries) return null;
    const fallbackMs = error.rateLimited ? policy.rateLimitDelayMs : policy.baseDelayMs * 2 ** (retry - 1);
    return {
      delayMs: Math.min(policy.maxDelayMs, error.retryAfterMs ?? fallbackMs),
      maxRetries,
      rateLimited: error.rateLimited,
      reason: error.status === null ? errorMessage(error) : `HTTP ${String(error.status)}`,
    };
  }
  if (isNetworkError(error)) {
    if (retry > policy.maxRetries) return null;
    return {
      delayMs: Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (retry - 1)),
      maxRetries: policy.maxRetries,
      rateLimited: false,
      reason: 'network error',
    };
  }
  return null;
}

/**
 * Parses an HTTP Retry-After header: either a number of seconds or an HTTP date.
 * Returns milliseconds, or null when the header is missing or unparseable.
 */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.ceil(Number.parseFloat(trimmed) * 1000);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - now);
}
