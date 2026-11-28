/**
 * Gemini: the director (JSON mode) and the poster (image output), each with a model
 * fallback chain. Every model gets its own retries first; the next model is tried only for
 * availability problems, never for a content-policy refusal or an auth error.
 */
import { writeFile } from 'node:fs/promises';
import {
  ApiError,
  GoogleGenAI,
  type GenerateContentParameters,
  type GenerateContentResponse,
} from '@google/genai';
import {
  ContentPolicyError,
  errorMessage,
  isAbortError,
  isNetworkError,
  ProviderError,
  RETRYABLE_STATUSES,
} from './errors.ts';
import { withRetry, type RetryPolicy, type Sleep } from './retry.ts';
import type {
  CallContext,
  CanonRequest,
  DirectorModel,
  PosterModel,
  PosterRequest,
  StoryPlanRequest,
} from './types.ts';

const PROVIDER = 'Gemini';

// Stable model IDs from Google's models and deprecations pages, checked on 2026-11-28. Each
// fallback is priced like the model before it or lower.
export const DEFAULT_SCRIPT_MODEL = 'gemini-3.8-flash';
export const SCRIPT_MODEL_FALLBACKS = ['gemini-3.6-flash'];
export const DEFAULT_POSTER_MODEL = 'gemini-3.1-flash-image';
export const POSTER_MODEL_FALLBACKS = ['gemini-3.1-flash-lite-image'];
// No temperature or other sampling parameters, per Google: https://aistudio.google.com/docs/whats-new-gemini-3.6

/** Statuses where another model may succeed: overloaded, rate limited or retired models. */
const FALLBACK_STATUSES = new Set([404, ...RETRYABLE_STATUSES]);
const BLOCKING_FINISH_REASONS = new Set([
  'SAFETY',
  'PROHIBITED_CONTENT',
  'BLOCKLIST',
  'SPII',
  'IMAGE_SAFETY',
  'IMAGE_PROHIBITED_CONTENT',
]);

/** The one SDK method the studio uses; tests substitute a fake. */
export interface GeminiClient {
  generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse>;
}

export function createGeminiClient(apiKey: string): GeminiClient {
  const ai = new GoogleGenAI({ apiKey });
  return { generateContent: (params) => ai.models.generateContent(params) };
}

/** The configured model first, then the defaults, without duplicates. */
export function modelChain(preferred: string, defaults: readonly string[]): string[] {
  return [...new Set([preferred, ...defaults].map((model) => model.trim()).filter(Boolean))];
}

interface GeminiOptions {
  client: GeminiClient;
  models: string[];
  retryPolicy?: RetryPolicy;
  sleep?: Sleep;
}

export class GeminiDirector implements DirectorModel {
  readonly #options: GeminiOptions;

  constructor(options: GeminiOptions) {
    this.#options = options;
  }

  writeStoryPlan(request: StoryPlanRequest, context: CallContext = {}): Promise<unknown> {
    return this.#generateJson('Story plan', request.prompt, context);
  }

  lockCanon(request: CanonRequest, context: CallContext = {}): Promise<unknown> {
    return this.#generateJson('Story lock', request.prompt, context);
  }

  #generateJson(label: string, prompt: string, context: CallContext): Promise<unknown> {
    return tryModels(this.#options.models, label, context, async (model) => {
      const response = await withRetry(
        `${label} (${model})`,
        () =>
          call(this.#options.client, {
            model,
            contents: prompt,
            config: { responseMimeType: 'application/json', abortSignal: context.signal },
          }),
        { ...context, policy: this.#options.retryPolicy, sleep: this.#options.sleep },
      );
      return parseModelJson(responseText(response, label), label);
    });
  }
}

export class GeminiPoster implements PosterModel {
  readonly #options: GeminiOptions;

  constructor(options: GeminiOptions) {
    this.#options = options;
  }

  async renderPoster(request: PosterRequest, context: CallContext = {}): Promise<void> {
    const image = await tryModels(this.#options.models, 'Poster', context, async (model) => {
      const response = await withRetry(
        `Poster (${model})`,
        () =>
          call(this.#options.client, {
            model,
            contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
            config: { responseModalities: ['IMAGE'], abortSignal: context.signal },
          }),
        { ...context, policy: this.#options.retryPolicy, sleep: this.#options.sleep },
      );
      return responseImage(response);
    });
    await writeFile(request.outputPath, image);
  }
}

async function tryModels<T>(
  models: readonly string[],
  label: string,
  context: CallContext,
  attempt: (model: string) => Promise<T>,
): Promise<T> {
  let lastError: unknown = null;
  for (const [index, model] of models.entries()) {
    try {
      return await attempt(model);
    } catch (error) {
      if (!canFallBack(error)) throw error;
      lastError = error;
      const next = models[index + 1];
      if (next) {
        await context.notify?.(`${label}: ${model} failed (${errorMessage(error)}); trying ${next}.`);
      }
    }
  }
  throw new ProviderError(`${label}: every model failed. Last error: ${errorMessage(lastError)}`, {
    provider: PROVIDER,
    retryable: false,
    cause: lastError,
  });
}

function canFallBack(error: unknown): boolean {
  if (!(error instanceof ProviderError) || error instanceof ContentPolicyError) return false;
  return error.status === null || FALLBACK_STATUSES.has(error.status);
}

async function call(
  client: GeminiClient,
  params: GenerateContentParameters,
): Promise<GenerateContentResponse> {
  try {
    return await client.generateContent(params);
  } catch (error) {
    throw toProviderError(error);
  }
}

/** Maps SDK and transport errors onto ProviderError so the retry logic can classify them. */
export function toProviderError(error: unknown): unknown {
  if (error instanceof ProviderError || isAbortError(error)) return error;
  if (error instanceof ApiError) {
    return new ProviderError(`Gemini returned HTTP ${String(error.status)}: ${apiErrorText(error)}`, {
      provider: PROVIDER,
      status: error.status,
      retryable: RETRYABLE_STATUSES.has(error.status),
      retryAfterMs: retryDelayMs(error.message),
      cause: error,
    });
  }
  if (isNetworkError(error)) {
    return new ProviderError(`Could not reach Gemini: ${errorMessage(error)}`, {
      provider: PROVIDER,
      retryable: true,
      cause: error,
    });
  }
  return error;
}

/** The SDK puts the JSON error body in `message`; prefer its human-readable part. */
function apiErrorText(error: ApiError): string {
  try {
    const body = JSON.parse(error.message) as { error?: { message?: unknown } };
    if (typeof body.error?.message === 'string') return body.error.message;
  } catch {
    // Not JSON: fall through to the raw message.
  }
  return error.message;
}

/** Reads google.rpc.RetryInfo (`"retryDelay": "37s"`), Gemini's equivalent of Retry-After. */
export function retryDelayMs(message: string): number | null {
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message);
  return match?.[1] ? Math.ceil(Number.parseFloat(match[1]) * 1000) : null;
}

function blockedBy(response: GenerateContentResponse): string | null {
  const blockReason = response.promptFeedback?.blockReason;
  if (blockReason) return blockReason;
  const finishReason = response.candidates?.[0]?.finishReason;
  return finishReason && BLOCKING_FINISH_REASONS.has(finishReason) ? finishReason : null;
}

function responseText(response: GenerateContentResponse, label: string): string {
  const blocked = blockedBy(response);
  if (blocked) {
    throw new ContentPolicyError(
      `${label}: Gemini declined the request under its content policy (${blocked}).`,
      {
        provider: PROVIDER,
      },
    );
  }
  const text = response.text;
  if (!text?.trim()) {
    throw new ProviderError(`${label}: Gemini returned no text.`, { provider: PROVIDER, retryable: false });
  }
  return text;
}

function responseImage(response: GenerateContentResponse): Buffer {
  const blocked = blockedBy(response);
  if (blocked) {
    throw new ContentPolicyError(
      `Poster: Gemini declined the request under its content policy (${blocked}).`,
      {
        provider: PROVIDER,
      },
    );
  }
  for (const part of response.candidates?.[0]?.content?.parts ?? []) {
    if (part.inlineData?.data) return Buffer.from(part.inlineData.data, 'base64');
  }
  throw new ProviderError('Poster: Gemini returned no image.', { provider: PROVIDER, retryable: false });
}

/** Parses model JSON, tolerating a Markdown code fence around it. */
export function parseModelJson(text: string, label: string): unknown {
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(unfenced) as unknown;
  } catch (error) {
    throw new ProviderError(`${label}: the model returned invalid JSON.`, {
      provider: PROVIDER,
      retryable: false,
      cause: error,
    });
  }
}
