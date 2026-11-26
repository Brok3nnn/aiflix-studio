import { access, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { StudioError } from '../src/errors.ts';
import { MemoryFilmRepository } from '../src/store/memory.ts';
import { clipFile, SNAPSHOT_FILE } from '../src/studio/jobs/media.ts';
import { recoverInterruptedFilms } from '../src/studio/jobs/recovery.ts';
import { describeFailure } from '../src/studio/jobs/runner.ts';
import { FalVideoModel } from '../src/studio/providers/fal.ts';
import { ContentPolicyError } from '../src/studio/providers/errors.ts';
import type { FilmRecord } from '../src/studio/types.ts';
import { FakeEditor, makeBrief, makeStudio, ScriptedVideo, StubPoster, waitFor } from './helpers.ts';

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

async function getFilm(repo: MemoryFilmRepository, id: string): Promise<FilmRecord> {
  const film = await repo.get(id);
  if (!film) throw new Error(`film ${id} missing`);
  return film;
}

describe('a failed job and its resume', () => {
  it('keeps the requested runtime, and the resumed film contains every scene', async () => {
    // Regression test: a failure used to overwrite the runtime with the seconds rendered so
    // far, so a resumed job rendered the remaining scenes and then trimmed them off.
    const video = new ScriptedVideo({ failOnce: [2] });
    const editor = new FakeEditor();
    const { repo, runner, generatedDir } = await makeStudio({ video, editor });

    const created = await runner.create(makeBrief({ durationSeconds: 64 }));
    await runner.idle();

    const failed = await getFilm(repo, created.id);
    expect(failed.status).toBe('failed');
    expect(failed.brief.durationSeconds).toBe(64);
    expect(failed.clips.map((clip) => clip.sceneIndex)).toEqual([0, 1]);
    expect(failed.failure).toMatchObject({ kind: 'provider', sceneIndex: 2, resumable: true });
    expect(failed.failure?.message).toContain('Scene 3 of 5');

    await runner.resume(created.id);
    await runner.idle();

    const film = await getFilm(repo, created.id);
    expect(film.status).toBe('ready');
    expect(film.progress).toBe(100);
    expect(film.brief.durationSeconds).toBe(64);
    // Scenes 1 and 2 were reused from disk; only the failed scene and the rest were rendered.
    expect(video.calls.map((call) => call.scene.index)).toEqual([0, 1, 2, 2, 3, 4]);
    expect(film.clips).toHaveLength(5);
    expect(sum(film.clips.map((clip) => clip.durationSeconds))).toBe(64);

    const edit = editor.requests.at(-1);
    expect(edit?.runtimeSeconds).toBe(64);
    expect(edit?.clipPaths).toEqual(
      [0, 1, 2, 3, 4].map((index) => path.join(generatedDir, created.id, clipFile(index))),
    );
  });

  it('refuses to resume a film that has not failed', async () => {
    const { runner } = await makeStudio();
    const film = await runner.create(makeBrief({ durationSeconds: 8 }));
    await runner.idle();
    await expect(runner.resume(film.id)).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('content-policy rejections', () => {
  it('fail the job with a message that names the scene, and are not resumable', async () => {
    const video = new ScriptedVideo({ rejectByPolicy: [1] });
    const { repo, runner } = await makeStudio({ video });

    const created = await runner.create(makeBrief({ durationSeconds: 64 }));
    await runner.idle();

    const film = await getFilm(repo, created.id);
    expect(film.status).toBe('failed');
    expect(film.failure).toMatchObject({ kind: 'content_policy', sceneIndex: 1, resumable: false });
    expect(film.failure?.message).toBe(
      `Scene 2 ("${film.scenes[1]?.title ?? ''}") was rejected by fal.ai's content policy (flagged: violence). The studio does not rewrite prompts to get past a provider's safety filter; change the premise and start a new film.`,
    );
    expect(film.logs.at(-1)).toMatchObject({ level: 'error', message: film.failure?.message });

    // One attempt for the rejected scene, sent unmodified, and nothing after it.
    expect(video.calls.map((call) => call.scene.index)).toEqual([0, 1]);
    await expect(runner.resume(created.id)).rejects.toBeInstanceOf(StudioError);
    expect(video.calls).toHaveLength(2);
  });

  it('name the story plan when the director is refused', () => {
    const failure = describeFailure(new ContentPolicyError('declined', { provider: 'Gemini' }));
    expect(failure).toMatchObject({ kind: 'content_policy', sceneIndex: null, resumable: false });
    expect(failure.message).toMatch(/^The story plan was rejected by Gemini's content policy\./);
  });
});

describe('progress reporting', () => {
  it('writes retry notices to the job log before waiting', async () => {
    // Regression test: the retry status used to be written with a query that never ran.
    const repo = new MemoryFilmRepository();
    let filmId = '';
    const waits: number[] = [];
    const responses = [
      new Response(JSON.stringify({ detail: 'Rate limited' }), {
        status: 429,
        headers: { 'retry-after': '7' },
      }),
      new Response(JSON.stringify({ video: { url: 'https://files.example.test/1.mp4' } }), { status: 200 }),
      new Response('mp4', { status: 200 }),
    ];
    const video = new FalVideoModel({
      apiKey: 'test-key',
      fetch: () => Promise.resolve(responses.shift() ?? new Response('{}', { status: 200 })),
      sleep: async (ms) => {
        waits.push(ms);
        const film = await getFilm(repo, filmId);
        expect(film.logs.at(-1)).toMatchObject({
          level: 'warn',
          message: 'Rate limited during Render scene 1; retrying in 7s (1/8).',
        });
      },
    });
    const { runner } = await makeStudio({ repo, video });

    filmId = (await runner.create(makeBrief({ durationSeconds: 8 }))).id;
    await runner.idle();

    expect(waits).toEqual([7_000]);
    expect((await getFilm(repo, filmId)).status).toBe('ready');
  });

  it('records the story bible, cast and scene plan as soon as they exist', async () => {
    const { repo, runner } = await makeStudio();
    const film = await runner.create(makeBrief({ durationSeconds: 30 }));
    await runner.idle();
    const ready = await getFilm(repo, film.id);
    expect(ready.story?.synopsis).toBeTruthy();
    expect(ready.cast.length).toBeGreaterThanOrEqual(3);
    expect(ready.scenes.map((scene) => scene.durationSeconds)).toEqual([12, 18]);
    expect(ready.videoFile).toBe('final.mp4');
    expect(ready.posterFile).toBe('poster.png');
  });

  it('finishes without a poster when poster generation fails', async () => {
    const poster = new StubPoster();
    poster.renderPoster = () => Promise.reject(new Error('image model unavailable'));
    const { repo, runner } = await makeStudio({ poster });
    const film = await runner.create(makeBrief({ durationSeconds: 8 }));
    await runner.idle();
    const ready = await getFilm(repo, film.id);
    expect(ready.status).toBe('ready');
    expect(ready.posterFile).toBeNull();
    expect(
      ready.logs.some((log) => log.level === 'warn' && log.message.includes('image model unavailable')),
    ).toBe(true);
  });
});

describe('start-up recovery', () => {
  it('marks interrupted jobs as failed and resumable, and resuming reuses finished clips', async () => {
    const repo = new MemoryFilmRepository();
    const hanging = new ScriptedVideo({ hangOn: [1] });
    const first = await makeStudio({ repo, video: hanging });

    // The server "crashes" while scene 2 is rendering: the job never finishes.
    const film = await first.runner.create(makeBrief({ durationSeconds: 64 }));
    await waitFor(async () => (await getFilm(repo, film.id)).clips.length === 1);
    expect((await getFilm(repo, film.id)).status).toBe('generating');

    // A new process starts with the same store and media folder.
    expect(await recoverInterruptedFilms(repo)).toEqual([film.id]);
    const recovered = await getFilm(repo, film.id);
    expect(recovered.status).toBe('failed');
    expect(recovered.failure).toMatchObject({ kind: 'interrupted', resumable: true });
    expect(recovered.brief.durationSeconds).toBe(64);

    const video = new ScriptedVideo();
    const editor = new FakeEditor();
    const second = await makeStudio({ repo, video, editor, generatedDir: first.generatedDir });
    await second.runner.resume(film.id);
    await second.runner.idle();

    const finished = await getFilm(repo, film.id);
    expect(finished.status).toBe('ready');
    expect(video.calls.map((call) => call.scene.index)).toEqual([1, 2, 3, 4]);
    expect(editor.requests[0]?.runtimeSeconds).toBe(64);
  });

  it('leaves finished and failed films alone', async () => {
    const repo = new MemoryFilmRepository();
    const { runner } = await makeStudio({ repo });
    const film = await runner.create(makeBrief({ durationSeconds: 8 }));
    await runner.idle();
    expect(await recoverInterruptedFilms(repo)).toEqual([]);
    expect((await getFilm(repo, film.id)).status).toBe('ready');
  });
});

describe('cost guards', () => {
  it('runs one job at a time by default', async () => {
    const video = new ScriptedVideo({ hangOn: [0] });
    const { runner } = await makeStudio({ video });
    await runner.create(makeBrief({ durationSeconds: 8 }));
    await expect(runner.create(makeBrief({ durationSeconds: 8 }))).rejects.toMatchObject({ code: 'busy' });
    expect(runner.activeJobs).toBe(1);
    // Let the first job reach its (never-ending) render before the test folder is removed.
    await waitFor(() => Promise.resolve(video.calls.length === 1));
  });

  it('rejects runtimes that need more clips than the cap', async () => {
    const { runner, repo } = await makeStudio({ maxClipsPerJob: 4 });
    await expect(runner.create(makeBrief({ durationSeconds: 64 }))).rejects.toThrow(
      'A 64s film needs 5 clips, but this server allows at most 4 per job (STUDIO_MAX_CLIPS_PER_JOB).',
    );
    expect(await repo.list(10)).toEqual([]);
    expect(runner.activeJobs).toBe(0);
  });
});

describe('deleting a film', () => {
  it('removes the record and the media folder, but not while rendering', async () => {
    const { runner, repo, generatedDir } = await makeStudio();
    const film = await runner.create(makeBrief({ durationSeconds: 8 }));
    await expect(runner.delete(film.id)).rejects.toMatchObject({ code: 'conflict' });
    await runner.idle();

    const dir = path.join(generatedDir, film.id);
    await access(path.join(dir, SNAPSHOT_FILE));
    await runner.delete(film.id);
    expect(await repo.get(film.id)).toBeNull();
    await expect(access(dir)).rejects.toThrow();
    await expect(runner.delete(film.id)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('a new plan', () => {
  it('discards clips left over from a plan that can no longer be loaded', async () => {
    const video = new ScriptedVideo({ failOnce: [1] });
    const { repo, runner, generatedDir } = await makeStudio({ video });
    const film = await runner.create(makeBrief({ durationSeconds: 30 }));
    await runner.idle();

    await writeFile(path.join(generatedDir, film.id, SNAPSHOT_FILE), 'corrupted');
    await runner.resume(film.id);
    await runner.idle();

    expect((await getFilm(repo, film.id)).status).toBe('ready');
    // Scene 1 was rendered again for the new plan instead of reusing the old clip.
    expect(video.calls.map((call) => call.scene.index)).toEqual([0, 1, 0, 1]);
  });
});
