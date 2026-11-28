import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ApiError, type GenerateContentResponse } from '@google/genai';
import { describe, expect, it } from 'vitest';
import { ContentPolicyError, ProviderError } from '../src/studio/providers/errors.ts';
import { FAL_LTX_FAST_ENDPOINT, falError, FalVideoModel } from '../src/studio/providers/fal.ts';
import {
  GeminiDirector,
  GeminiPoster,
  modelChain,
  retryDelayMs,
  toProviderError,
  type GeminiClient,
} from '../src/studio/providers/gemini.ts';
import { makeBrief, tempDir } from './helpers.ts';

const noWait = (): Promise<void> => Promise.resolve();

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A fetch stand-in that replays canned responses (or transport errors) and records each request. */
function scriptedFetch(responses: (Response | Error)[]): {
  fetch: typeof fetch;
  requests: { url: string; body: unknown }[];
} {
  const requests: { url: string; body: unknown }[] = [];
  const fetchStub = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null;
    requests.push({ url: input instanceof Request ? input.url : input.toString(), body });
    const response = responses.shift();
    if (response instanceof Error) return Promise.reject(response);
    return response ? Promise.resolve(response) : Promise.reject(new Error('unexpected request'));
  };
  return { fetch: fetchStub, requests };
}

/** What fetch() rejects with when undici fails with `code`. */
const fetchFailed = (code: string): TypeError =>
  new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });

const clipRequest = (outputPath: string) => ({
  prompt: 'Scene 1 of 2. Generate exactly one 8-second cinematic film clip.',
  durationSeconds: 8,
  outputPath,
  scene: { index: 0, title: 'Cold Open' },
});

describe('FalVideoModel', () => {
  it('requests a 1080p clip with audio, keeps the safety checker on and downloads the result', async () => {
    const { fetch, requests } = scriptedFetch([
      json(200, { video: { url: 'https://files.example.test/clip.mp4' } }),
      new Response('mp4-bytes', { status: 200 }),
    ]);
    const output = path.join(await tempDir(), 'clip.mp4');
    await new FalVideoModel({ apiKey: 'test-key', fetch, sleep: noWait }).renderClip(clipRequest(output));

    expect(requests[0]?.url).toBe('https://fal.run/fal-ai/ltx-2.3/text-to-video/fast');
    expect(requests[0]?.body).toEqual({
      prompt: clipRequest(output).prompt,
      duration: 8,
      resolution: '1080p',
      aspect_ratio: '16:9',
      fps: 25,
      generate_audio: true,
      enable_safety_checker: true,
    });
    expect(await readFile(output, 'utf8')).toBe('mp4-bytes');
  });

  it('fails a content-policy rejection at once, without retrying or rewriting the prompt', async () => {
    const { fetch, requests } = scriptedFetch([
      json(422, {
        detail: [
          {
            loc: ['body', 'prompt'],
            msg: 'The content could not be processed because it contained material flagged by a content checker.',
            type: 'content_policy_violation',
            categories: ['violence'],
          },
        ],
      }),
    ]);
    const model = new FalVideoModel({ apiKey: 'test-key', fetch, sleep: noWait });
    const error: unknown = await model
      .renderClip(clipRequest(path.join(await tempDir(), 'c.mp4')))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ContentPolicyError);
    expect((error as ContentPolicyError).categories).toEqual(['violence']);
    expect(requests).toHaveLength(1);
  });

  it('retries a 429 after the Retry-After delay', async () => {
    const waits: number[] = [];
    const { fetch, requests } = scriptedFetch([
      json(429, { detail: 'Too many requests' }, { 'retry-after': '3' }),
      json(200, { video: { url: 'https://files.example.test/clip.mp4' } }),
      new Response('mp4', { status: 200 }),
    ]);
    const model = new FalVideoModel({
      apiKey: 'test-key',
      fetch,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    await model.renderClip(clipRequest(path.join(await tempDir(), 'c.mp4')));
    expect(waits).toEqual([3_000]);
    expect(requests).toHaveLength(3);
  });

  it('never sends a paid render twice after a server error or a timeout', async () => {
    // fal.ai may already be rendering (and billing) the clip: the scene fails instead, and the
    // film can be resumed.
    for (const failure of [json(503, { detail: 'busy' }), fetchFailed('UND_ERR_HEADERS_TIMEOUT')]) {
      const { fetch, requests } = scriptedFetch([failure]);
      const model = new FalVideoModel({ apiKey: 'test-key', fetch, sleep: noWait });
      const error: unknown = await model
        .renderClip(clipRequest(path.join(await tempDir(), 'c.mp4')))
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect(requests).toHaveLength(1);
    }
  });

  it('sends a render again when the connection could not be opened', async () => {
    const waits: number[] = [];
    const { fetch, requests } = scriptedFetch([
      fetchFailed('ECONNREFUSED'),
      json(200, { video: { url: 'https://files.example.test/clip.mp4' } }),
      new Response('mp4', { status: 200 }),
    ]);
    const model = new FalVideoModel({
      apiKey: 'test-key',
      fetch,
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    await model.renderClip(clipRequest(path.join(await tempDir(), 'c.mp4')));
    expect(waits).toEqual([2_000]);
    expect(requests.map((request) => request.url)).toEqual([
      FAL_LTX_FAST_ENDPOINT,
      FAL_LTX_FAST_ENDPOINT,
      'https://files.example.test/clip.mp4',
    ]);
  });

  it('retries the free download after a server error', async () => {
    const { fetch, requests } = scriptedFetch([
      json(200, { video: { url: 'https://files.example.test/clip.mp4' } }),
      new Response('', { status: 503 }),
      new Response('mp4', { status: 200 }),
    ]);
    const output = path.join(await tempDir(), 'c.mp4');
    await new FalVideoModel({ apiKey: 'test-key', fetch, sleep: noWait }).renderClip(clipRequest(output));
    expect(requests.map((request) => request.url)).toEqual([
      FAL_LTX_FAST_ENDPOINT,
      'https://files.example.test/clip.mp4',
      'https://files.example.test/clip.mp4',
    ]);
    expect(await readFile(output, 'utf8')).toBe('mp4');
  });

  it('does not retry other validation errors', () => {
    const error = falError(422, new Headers(), {
      detail: [{ type: 'less_than_equal', msg: 'duration too long' }],
    });
    expect(error).not.toBeInstanceOf(ContentPolicyError);
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('duration too long');
    expect(falError(503, new Headers(), {}).retryable).toBe(true);
  });
});

/** A Gemini client stand-in that replays canned results per call. */
function scriptedGemini(results: (GenerateContentResponse | Error)[]): {
  client: GeminiClient;
  models: string[];
  configs: unknown[];
} {
  const models: string[] = [];
  const configs: unknown[] = [];
  const client: GeminiClient = {
    generateContent: (params) => {
      models.push(params.model);
      configs.push(params.config);
      const result = results.shift();
      if (!result) return Promise.reject(new Error('unexpected call'));
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  };
  return { client, models, configs };
}

const textResponse = (text: string): GenerateContentResponse =>
  ({ text, candidates: [{ finishReason: 'STOP' }] }) as unknown as GenerateContentResponse;

describe('Gemini providers', () => {
  const request = { prompt: 'Write the plan.', brief: makeBrief(), sceneCount: 2 };

  it('falls back to the next model when one is overloaded', async () => {
    const overloaded = new ApiError({
      status: 503,
      message: '{"error":{"message":"The model is overloaded."}}',
    });
    const { client, models, configs } = scriptedGemini([overloaded, textResponse('{"synopsis":"ok"}')]);
    const notices: string[] = [];
    const director = new GeminiDirector({
      client,
      models: ['model-a', 'model-b'],
      retryPolicy: {
        maxRetries: 0,
        rateLimitMaxRetries: 0,
        baseDelayMs: 1,
        rateLimitDelayMs: 1,
        maxDelayMs: 1,
      },
      sleep: noWait,
    });
    const plan = await director.writeStoryPlan(request, {
      notify: (message) => {
        notices.push(message);
        return Promise.resolve();
      },
    });
    expect(plan).toEqual({ synopsis: 'ok' });
    expect(models).toEqual(['model-a', 'model-b']);
    // Gemini 3 sampling parameters stay at the model defaults.
    for (const config of configs) expect(config).not.toHaveProperty('temperature');
    expect(notices[0]).toContain(
      'model-a failed (Gemini returned HTTP 503: The model is overloaded.); trying model-b',
    );
  });

  it('reports a blocked prompt as a content-policy error and does not try other models', async () => {
    const blocked = { promptFeedback: { blockReason: 'SAFETY' } } as unknown as GenerateContentResponse;
    const { client, models } = scriptedGemini([blocked]);
    const director = new GeminiDirector({ client, models: ['model-a', 'model-b'], sleep: noWait });
    await expect(director.writeStoryPlan(request)).rejects.toBeInstanceOf(ContentPolicyError);
    expect(models).toEqual(['model-a']);
  });

  it('stops on authentication errors instead of trying every model', async () => {
    const { client, models } = scriptedGemini([new ApiError({ status: 403, message: 'forbidden' })]);
    const director = new GeminiDirector({ client, models: ['model-a', 'model-b'], sleep: noWait });
    await expect(director.writeStoryPlan(request)).rejects.toMatchObject({ status: 403 });
    expect(models).toEqual(['model-a']);
  });

  it('writes the poster image from inline data', async () => {
    const image = {
      candidates: [{ content: { parts: [{ inlineData: { data: Buffer.from('png').toString('base64') } }] } }],
    } as unknown as GenerateContentResponse;
    const { client, configs } = scriptedGemini([image]);
    const output = path.join(await tempDir(), 'poster.png');
    await new GeminiPoster({ client, models: ['image-model'], sleep: noWait }).renderPoster({
      prompt: 'Poster',
      outputPath: output,
      title: 'T',
    });
    expect(await readFile(output, 'utf8')).toBe('png');
    expect(configs[0]).not.toHaveProperty('temperature');
  });

  it('maps SDK errors and reads RetryInfo delays', () => {
    const rateLimited = toProviderError(
      new ApiError({ status: 429, message: '{"error":{"details":[{"retryDelay":"37s"}]}}' }),
    );
    expect(rateLimited).toBeInstanceOf(ProviderError);
    expect(rateLimited).toMatchObject({ status: 429, retryable: true, retryAfterMs: 37_000 });
    expect(retryDelayMs('no delay here')).toBeNull();
  });

  it('builds model chains without duplicates', () => {
    expect(modelChain('gemini-3.8-flash', ['gemini-3.8-flash', 'gemini-3.6-flash'])).toEqual([
      'gemini-3.8-flash',
      'gemini-3.6-flash',
    ]);
    expect(modelChain(' custom ', ['b'])).toEqual(['custom', 'b']);
  });
});
