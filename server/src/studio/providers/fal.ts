/**
 * fal.ai text-to-video (LTX 2.3 fast): one synchronous request per scene, then a download of
 * the rendered MP4.
 */
import { writeFile } from 'node:fs/promises';
import { asRecord } from '../text.ts';
import { ContentPolicyError, errorMessage, isAbortError, isNetworkError, ProviderError } from './errors.ts';
import { parseRetryAfter, withRetry, type RetryPolicy, type Sleep } from './retry.ts';
import type { CallContext, ClipRequest, VideoModel } from './types.ts';

const PROVIDER = 'fal.ai';

export const FAL_LTX_FAST_ENDPOINT = 'https://fal.run/fal-ai/ltx-2.3/text-to-video/fast';
export const CLIP_FPS = 25;

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export interface FalVideoOptions {
  apiKey: string;
  endpoint?: string;
  fetch?: typeof fetch;
  retryPolicy?: RetryPolicy;
  sleep?: Sleep;
}

export class FalVideoModel implements VideoModel {
  readonly label = 'LTX 2.3 Fast (fal.ai)';
  readonly #apiKey: string;
  readonly #endpoint: string;
  readonly #fetch: typeof fetch;
  readonly #retryPolicy: RetryPolicy | undefined;
  readonly #sleep: Sleep | undefined;

  constructor(options: FalVideoOptions) {
    this.#apiKey = options.apiKey;
    this.#endpoint = options.endpoint ?? FAL_LTX_FAST_ENDPOINT;
    this.#fetch = options.fetch ?? fetch;
    this.#retryPolicy = options.retryPolicy;
    this.#sleep = options.sleep;
  }

  async renderClip(request: ClipRequest, context: CallContext = {}): Promise<void> {
    const scene = `scene ${String(request.scene.index + 1)}`;
    const retry = { ...context, policy: this.#retryPolicy, sleep: this.#sleep };
    const videoUrl = await withRetry(
      `Render ${scene}`,
      () => this.#requestClip(request, context.signal),
      retry,
    );
    await withRetry(
      `Download ${scene}`,
      () => this.#download(videoUrl, request.outputPath, context.signal),
      retry,
    );
  }

  async #requestClip(request: ClipRequest, signal?: AbortSignal): Promise<string> {
    const response = await this.#send(this.#endpoint, {
      method: 'POST',
      headers: { Authorization: `Key ${this.#apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: request.prompt,
        duration: request.durationSeconds,
        resolution: '1080p',
        aspect_ratio: '16:9',
        fps: CLIP_FPS,
        generate_audio: true,
        // The provider's default; sent explicitly so the intent is visible. Never disabled.
        enable_safety_checker: true,
      }),
      signal,
    });
    const body = await readJson(response);
    if (!response.ok) throw falError(response.status, response.headers, body);

    const url = asRecord(asRecord(body).video).url;
    if (typeof url !== 'string' || !url) {
      throw new ProviderError('fal.ai returned no video URL.', { provider: PROVIDER, retryable: false });
    }
    return url;
  }

  async #download(url: string, outputPath: string, signal?: AbortSignal): Promise<void> {
    const response = await this.#send(url, { signal });
    if (!response.ok) {
      throw new ProviderError(`Clip download failed with HTTP ${String(response.status)}.`, {
        provider: PROVIDER,
        status: response.status,
        retryable: RETRYABLE_STATUSES.has(response.status),
        retryAfterMs: parseRetryAfter(response.headers.get('retry-after')),
      });
    }
    await writeFile(outputPath, Buffer.from(await response.arrayBuffer()));
  }

  async #send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.#fetch(url, init);
    } catch (error) {
      if (isAbortError(error) || !isNetworkError(error)) throw error;
      throw new ProviderError(`Could not reach fal.ai: ${errorMessage(error)}`, {
        provider: PROVIDER,
        retryable: true,
        cause: error,
      });
    }
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { detail: text.slice(0, 500) };
  }
}

/**
 * Classifies a fal.ai error response. Model errors carry a `detail` array whose items have a
 * machine-readable `type`; `content_policy_violation` (HTTP 422) means the request was
 * refused by the provider's moderation and must not be retried.
 */
export function falError(status: number, headers: Headers, body: unknown): ProviderError {
  const payload = asRecord(body);
  const details = Array.isArray(payload.detail) ? payload.detail.map(asRecord) : [];
  const policy = details.find((item) => item.type === 'content_policy_violation');
  if (policy) {
    const categories = Array.isArray(policy.categories)
      ? policy.categories.filter((entry): entry is string => typeof entry === 'string')
      : [];
    return new ContentPolicyError(
      `fal.ai rejected the prompt under its content policy${categories.length > 0 ? ` (flagged: ${categories.join(', ')})` : ''}.`,
      { provider: PROVIDER, status, categories },
    );
  }

  const messages = details
    .map((item) => (typeof item.msg === 'string' ? item.msg : null))
    .filter((message): message is string => message !== null);
  const summary =
    messages.join('; ') ||
    (typeof payload.detail === 'string' ? payload.detail : '') ||
    `HTTP ${String(status)}`;
  return new ProviderError(`fal.ai request failed (HTTP ${String(status)}): ${summary.slice(0, 500)}`, {
    provider: PROVIDER,
    status,
    retryable: RETRYABLE_STATUSES.has(status),
    retryAfterMs: parseRetryAfter(headers.get('retry-after')),
  });
}
