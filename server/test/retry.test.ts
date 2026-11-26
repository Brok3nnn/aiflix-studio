import { describe, expect, it } from 'vitest';
import { ContentPolicyError, ProviderError } from '../src/studio/providers/errors.ts';
import {
  DEFAULT_RETRY_POLICY,
  parseRetryAfter,
  planRetry,
  withRetry,
  type RetryPolicy,
} from '../src/studio/providers/retry.ts';

const policy: RetryPolicy = {
  maxRetries: 3,
  rateLimitMaxRetries: 5,
  baseDelayMs: 1_000,
  rateLimitDelayMs: 30_000,
  maxDelayMs: 60_000,
};

function failing(errors: Error[], result = 'ok'): { task: () => Promise<string>; calls: () => number } {
  let calls = 0;
  return {
    task: () => {
      const error = errors[calls];
      calls += 1;
      return error === undefined ? Promise.resolve(result) : Promise.reject(error);
    },
    calls: () => calls,
  };
}

const serverError = (status = 503): ProviderError =>
  new ProviderError(`HTTP ${String(status)}`, { provider: 'test', status, retryable: true });

describe('withRetry', () => {
  it('backs off exponentially on transient errors and reports each retry before waiting', async () => {
    const waits: number[] = [];
    const notices: string[] = [];
    const { task, calls } = failing([serverError(), serverError(), serverError(502)]);
    const result = await withRetry('Render scene 1', task, {
      policy,
      sleep: (ms) => {
        waits.push(ms);
        expect(notices).toHaveLength(waits.length);
        return Promise.resolve();
      },
      notify: (message) => {
        notices.push(message);
        return Promise.resolve();
      },
    });
    expect(result).toBe('ok');
    expect(calls()).toBe(4);
    expect(waits).toEqual([1_000, 2_000, 4_000]);
    expect(notices[0]).toBe('Render scene 1 failed (HTTP 503); retrying in 1s (1/3).');
  });

  it('waits for Retry-After on 429', async () => {
    const waits: number[] = [];
    const notices: string[] = [];
    const rateLimited = new ProviderError('HTTP 429', {
      provider: 'test',
      status: 429,
      retryable: true,
      retryAfterMs: 7_000,
    });
    const { task } = failing([rateLimited]);
    await withRetry('Story plan', task, {
      policy,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
      notify: (message) => {
        notices.push(message);
        return Promise.resolve();
      },
    });
    expect(waits).toEqual([7_000]);
    expect(notices).toEqual(['Rate limited during Story plan; retrying in 7s (1/5).']);
  });

  it('gives up after the retry budget and rethrows the last error', async () => {
    const errors = [serverError(), serverError(), serverError(), serverError()];
    const { task, calls } = failing(errors);
    await expect(withRetry('x', task, { policy, sleep: () => Promise.resolve() })).rejects.toBe(errors[3]);
    expect(calls()).toBe(4);
  });

  it('never retries a content-policy rejection', async () => {
    const rejection = new ContentPolicyError('refused', { provider: 'test', status: 422 });
    const { task, calls } = failing([rejection]);
    await expect(withRetry('x', task, { policy, sleep: () => Promise.resolve() })).rejects.toBe(rejection);
    expect(calls()).toBe(1);
  });

  it('retries network failures but not programming errors', async () => {
    const network = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
    });
    const { task: flaky } = failing([network]);
    await expect(withRetry('x', flaky, { policy, sleep: () => Promise.resolve() })).resolves.toBe('ok');

    const bug = new RangeError('bad index');
    const { task: broken, calls } = failing([bug]);
    await expect(withRetry('x', broken, { policy, sleep: () => Promise.resolve() })).rejects.toBe(bug);
    expect(calls()).toBe(1);
  });
});

describe('planRetry', () => {
  it('caps every wait, including server-requested ones', () => {
    const slow = new ProviderError('HTTP 429', {
      provider: 'test',
      status: 429,
      retryable: true,
      retryAfterMs: 3_600_000,
    });
    expect(planRetry(slow, 1, DEFAULT_RETRY_POLICY)?.delayMs).toBe(DEFAULT_RETRY_POLICY.maxDelayMs);
  });

  it('uses the rate-limit budget and default wait for 429 without Retry-After', () => {
    const rateLimited = new ProviderError('HTTP 429', { provider: 'test', status: 429, retryable: true });
    expect(planRetry(rateLimited, 5, policy)).toMatchObject({ delayMs: 30_000, rateLimited: true });
    expect(planRetry(rateLimited, 6, policy)).toBeNull();
  });
});

describe('parseRetryAfter', () => {
  it('accepts seconds and HTTP dates', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(parseRetryAfter('12', now)).toBe(12_000);
    expect(parseRetryAfter('1.5', now)).toBe(1_500);
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('Wed, 31 Dec 2025 23:59:00 GMT', now)).toBe(0);
  });

  it('ignores missing or malformed values', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });
});
