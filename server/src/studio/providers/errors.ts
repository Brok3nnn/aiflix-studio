export interface ProviderErrorOptions {
  provider: string;
  status?: number | null;
  retryable: boolean;
  /** Server-requested wait before retrying (from Retry-After or an equivalent field). */
  retryAfterMs?: number | null;
  cause?: unknown;
}

/** A failed call to an external model provider, classified for the retry logic. */
export class ProviderError extends Error {
  readonly provider: string;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly retryAfterMs: number | null;

  constructor(message: string, options: ProviderErrorOptions) {
    super(message, { cause: options.cause });
    this.name = 'ProviderError';
    this.provider = options.provider;
    this.status = options.status ?? null;
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }

  get rateLimited(): boolean {
    return this.status === 429;
  }
}

/**
 * The provider refused the request under its content policy. It is never retried, and the
 * studio never rewrites a prompt to get past a provider's safety filter.
 */
export class ContentPolicyError extends ProviderError {
  readonly categories: string[];

  constructor(
    message: string,
    options: { provider: string; status?: number | null; categories?: string[]; cause?: unknown },
  ) {
    super(message, { ...options, retryable: false });
    this.name = 'ContentPolicyError';
    this.categories = options.categories ?? [];
  }
}

const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/** True for transport failures (DNS, connection resets, timeouts) that are worth retrying. */
export function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && NETWORK_ERROR_CODES.has(code)) return true;
  // fetch() rejects with `TypeError: fetch failed` and puts the system error in `cause`.
  if (error instanceof TypeError && error.message === 'fetch failed') return true;
  return error.cause !== undefined && error.cause !== error && isNetworkError(error.cause);
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'Unknown error';
}
