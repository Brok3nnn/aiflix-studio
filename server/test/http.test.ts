import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, hostName } from '../src/http/app.ts';
import { studioInfo } from '../src/http/info.ts';
import { createFilmSchema, titleFromPremise, toBrief } from '../src/http/validation.ts';
import { silentLogger } from '../src/logger.ts';
import { makeStudio, ScriptedVideo, waitFor, type TestStudio } from './helpers.ts';

const valid = {
  premise: 'A lighthouse keeper finds a letter that predicts the next storm.',
  look: 'realistic',
  durationSeconds: 30,
};

describe('createFilmSchema', () => {
  const issue = (body: unknown): string | undefined => {
    const result = createFilmSchema.safeParse(body);
    return result.success ? undefined : result.error.issues[0]?.message;
  };

  it('accepts a minimal request and fills in defaults', () => {
    const brief = toBrief(createFilmSchema.parse(valid));
    expect(brief).toEqual({
      title: 'A lighthouse keeper finds a',
      premise: valid.premise,
      genres: ['Drama'],
      look: 'realistic',
      durationSeconds: 30,
      minMainCharacters: 2,
      minSupportingCharacters: 2,
    });
  });

  it('requires an even runtime from 8 to 480 seconds', () => {
    const message = 'Runtime must be an even number of seconds from 8 to 480.';
    for (const durationSeconds of [9, 63, 6, 482, 10.5, '30']) {
      expect(issue({ ...valid, durationSeconds })).toBe(message);
    }
    for (const durationSeconds of [8, 64, 480]) {
      expect(issue({ ...valid, durationSeconds })).toBeUndefined();
    }
  });

  it('checks the premise length and the look', () => {
    expect(issue({ ...valid, premise: '  too short ' })).toBe('Premise must be at least 12 characters.');
    expect(issue({ ...valid, premise: 'x'.repeat(2_001) })).toBe('Premise must be at most 2000 characters.');
    expect(issue({ ...valid, look: 'noir' })).toBe('look must be "realistic" or "animated".');
  });

  it('rejects unknown fields', () => {
    expect(issue({ ...valid, videoModel: 'other' })).toMatch(/Unrecognized key/);
  });

  it('derives a title from the premise', () => {
    expect(titleFromPremise('Rain.')).toBe('Rain');
  });
});

describe('HTTP API', () => {
  let server: Server | undefined;
  let studio: TestStudio;
  let base = '';

  async function start(video = new ScriptedVideo()): Promise<void> {
    studio = await makeStudio({ video });
    const app = createApp({
      repo: studio.repo,
      runner: studio.runner,
      host: '127.0.0.1',
      generatedDir: studio.generatedDir,
      logger: silentLogger,
      studioInfo: () =>
        studioInfo({
          providers: 'mock',
          store: 'memory',
          maxClipsPerJob: 12,
          maxConcurrentJobs: 1,
          endCardText: 'AIFLIX Studio',
          drawsText: true,
          activeJobs: () => studio.runner.activeJobs,
        }),
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server?.once('listening', resolve));
    base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  }

  afterEach(async () => {
    const running = server;
    server = undefined;
    if (!running) return;
    running.closeAllConnections();
    await new Promise((resolve) => running.close(resolve));
  });

  const post = (url: string, body: string): Promise<Response> =>
    fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });

  it('answers invalid requests with 400 and a clear message', async () => {
    await start();
    const odd = await post('/api/films', JSON.stringify({ ...valid, durationSeconds: 63 }));
    expect(odd.status).toBe(400);
    expect(await odd.json()).toEqual({
      error: 'durationSeconds: Runtime must be an even number of seconds from 8 to 480.',
    });

    const broken = await post('/api/films', '{"premise":');
    expect(broken.status).toBe(400);
    expect(await broken.json()).toEqual({ error: 'The request body must be valid JSON.' });
  });

  it('starts a film, refuses a second one while it renders, and serves it afterwards', async () => {
    const video = new ScriptedVideo({ hangOn: [1] });
    await start(video);
    const created = await post('/api/films', JSON.stringify(valid));
    expect(created.status).toBe(202);
    const { film } = (await created.json()) as { film: { id: string; status: string } };
    expect(film.status).toBe('queued');

    const second = await post('/api/films', JSON.stringify(valid));
    expect(second.status).toBe(409);

    const info = (await (await fetch(`${base}/api/studio`)).json()) as {
      activeJobs: number;
      limits: { maxRuntimeSeconds: number };
    };
    expect(info.activeJobs).toBe(1);
    expect(info.limits.maxRuntimeSeconds).toBe(174);

    const removing = await fetch(`${base}/api/films/${film.id}`, { method: 'DELETE' });
    expect(removing.status).toBe(409);

    await waitFor(() => Promise.resolve(video.calls.length === 2));
    const fetched = await fetch(`${base}/api/films/${film.id}`);
    const body = (await fetched.json()) as { film: { status: string; clips: { url: string }[] } };
    expect(body.film.status).toBe('generating');
    expect(body.film.clips[0]?.url).toBe(`/media/${film.id}/clip-01.mp4`);

    const clip = await fetch(`${base}/media/${film.id}/clip-01.mp4`);
    expect(clip.status).toBe(200);
  });

  it('returns 404 for unknown films and routes', async () => {
    await start();
    expect((await fetch(`${base}/api/films/film-zzzz-000000`)).status).toBe(404);
    expect((await fetch(`${base}/api/films/../../etc`)).status).toBe(404);
    expect((await fetch(`${base}/api/nothing`)).status).toBe(404);
    expect((await fetch(`${base}/media/none.mp4`)).status).toBe(404);
  });

  it('refuses requests addressed to other host names', async () => {
    await start();
    const { request } = await import('node:http');
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${base}/api/health`, { headers: { host: 'attacker.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
    expect(hostName('[::1]:3001')).toBe('[::1]');
    expect(hostName('localhost:5173')).toBe('localhost');
  });
});
