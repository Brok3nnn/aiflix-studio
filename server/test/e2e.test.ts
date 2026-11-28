/**
 * The whole pipeline with the offline mock providers, the in-memory store and the real
 * ffmpeg: plan, clips, edit, end card and poster. Skipped when ffmpeg is not installed.
 */
import { spawnSync } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FONT_FILE } from '../src/config.ts';
import { silentLogger } from '../src/logger.ts';
import { MemoryFilmRepository } from '../src/store/memory.ts';
import { OUTPUT_FPS } from '../src/studio/editor/commands.ts';
import { Ffmpeg } from '../src/studio/editor/runner.ts';
import { JobRunner } from '../src/studio/jobs/runner.ts';
import { MockDirector, MockPoster, MockVideo } from '../src/studio/providers/mock.ts';
import { makeBrief, tempDir } from './helpers.ts';

const ffmpegFound =
  spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const title = ffmpegFound
  ? 'renders a frame-exact film offline with mock providers'
  : 'renders a frame-exact film offline with mock providers (skipped: ffmpeg/ffprobe not found on PATH)';

/** Decoded frame count and duration of the first video stream. */
function videoStream(file: string): { frames: number; durationSeconds: number } {
  const probe = spawnSync(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-count_frames',
      '-show_entries',
      'stream=nb_read_frames,duration',
      '-of',
      'json',
      file,
    ],
    { encoding: 'utf8' },
  );
  const { streams } = JSON.parse(probe.stdout) as { streams: { nb_read_frames: string; duration: string }[] };
  return { frames: Number(streams[0]?.nb_read_frames), durationSeconds: Number(streams[0]?.duration) };
}

describe('end to end', () => {
  it.skipIf(!ffmpegFound)(title, async () => {
    const generatedDir = await tempDir();
    const repo = new MemoryFilmRepository();
    const ffmpeg = new Ffmpeg({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe', fontFile: FONT_FILE });
    const runner = new JobRunner({
      repo,
      providers: {
        mode: 'mock',
        director: new MockDirector(),
        video: new MockVideo(ffmpeg, { width: 320, height: 180 }),
        poster: new MockPoster(ffmpeg),
      },
      editor: ffmpeg,
      generatedDir,
      endCardText: 'AIFLIX Studio',
      maxConcurrentJobs: 1,
      maxClipsPerJob: 12,
      logger: silentLogger,
    });

    const created = await runner.create(makeBrief({ durationSeconds: 40, look: 'animated' }));
    await runner.idle();

    const film = await repo.get(created.id);
    expect(film?.failure).toBeNull();
    expect(film?.status).toBe('ready');
    // Three clips: two scene cuts, where a frame used to go missing.
    expect(film?.scenes.map((scene) => scene.durationSeconds)).toEqual([10, 14, 16]);
    expect(film?.cast.length).toBeGreaterThan(0);
    expect(film?.story?.synopsis).toBeTruthy();

    const dir = path.join(generatedDir, created.id);
    const final = await ffmpeg.probe(path.join(dir, 'final.mp4'));
    expect(final).toMatchObject({ width: 320, height: 180, hasAudio: true });
    expect(videoStream(path.join(dir, 'final.mp4'))).toEqual({
      frames: 40 * OUTPUT_FPS,
      durationSeconds: 40,
    });
    await access(path.join(dir, 'poster.png'));

    const drawsText = await ffmpeg.hasDrawtext();
    const warnedAboutText = film?.logs.some((log) => log.message.includes('no drawtext filter'));
    expect(warnedAboutText).toBe(!drawsText);
  });
});
