import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import { silentLogger } from '../src/logger.ts';
import { MemoryFilmRepository } from '../src/store/memory.ts';
import type { AssembleRequest, FilmEditor } from '../src/studio/editor/runner.ts';
import { JobRunner } from '../src/studio/jobs/runner.ts';
import { ContentPolicyError, ProviderError } from '../src/studio/providers/errors.ts';
import { MockDirector } from '../src/studio/providers/mock.ts';
import type {
  ClipRequest,
  PosterModel,
  PosterRequest,
  StudioProviders,
  VideoModel,
} from '../src/studio/providers/types.ts';
import type { FilmBrief } from '../src/studio/types.ts';

export function makeBrief(overrides: Partial<FilmBrief> = {}): FilmBrief {
  return {
    title: 'The Lighthouse Letter',
    premise: 'A lighthouse keeper finds a letter that predicts the next storm.',
    genres: ['Drama', 'Mystery'],
    look: 'realistic',
    durationSeconds: 64,
    minMainCharacters: 2,
    minSupportingCharacters: 1,
    ...overrides,
  };
}

const tempDirs: string[] = [];

/** A fresh temporary folder, removed after the current test. */
export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'aiflix-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Video model that writes a stub file per scene and can be told to fail or hang. */
export class ScriptedVideo implements VideoModel {
  readonly label = 'scripted test video';
  readonly calls: ClipRequest[] = [];
  readonly #failOnce = new Set<number>();
  readonly #rejectByPolicy = new Set<number>();
  readonly #hangOn = new Set<number>();

  constructor(options: { failOnce?: number[]; rejectByPolicy?: number[]; hangOn?: number[] } = {}) {
    for (const index of options.failOnce ?? []) this.#failOnce.add(index);
    for (const index of options.rejectByPolicy ?? []) this.#rejectByPolicy.add(index);
    for (const index of options.hangOn ?? []) this.#hangOn.add(index);
  }

  async renderClip(request: ClipRequest): Promise<void> {
    this.calls.push(request);
    const { index } = request.scene;
    if (this.#hangOn.has(index)) {
      await new Promise<never>(() => undefined);
    }
    if (this.#rejectByPolicy.has(index)) {
      throw new ContentPolicyError(
        'fal.ai rejected the prompt under its content policy (flagged: violence).',
        {
          provider: 'fal.ai',
          status: 422,
          categories: ['violence'],
        },
      );
    }
    if (this.#failOnce.delete(index)) {
      throw new ProviderError('fal.ai request failed (HTTP 500): upstream error', {
        provider: 'fal.ai',
        status: 500,
        retryable: false,
      });
    }
    await writeFile(request.outputPath, `clip ${String(index)}`);
  }
}

export class StubPoster implements PosterModel {
  readonly calls: PosterRequest[] = [];

  async renderPoster(request: PosterRequest): Promise<void> {
    this.calls.push(request);
    await writeFile(request.outputPath, 'poster');
  }
}

/** Records what the pipeline asked for and writes a stub film. */
export class FakeEditor implements FilmEditor {
  readonly requests: AssembleRequest[] = [];

  async assemble(request: AssembleRequest): Promise<{ textDrawn: boolean }> {
    this.requests.push(request);
    await writeFile(request.outputPath, 'film');
    return { textDrawn: true };
  }
}

export interface TestStudio {
  repo: MemoryFilmRepository;
  runner: JobRunner;
  video: VideoModel;
  editor: FilmEditor;
  generatedDir: string;
}

export async function makeStudio(
  options: {
    video?: VideoModel;
    editor?: FilmEditor;
    poster?: PosterModel;
    repo?: MemoryFilmRepository;
    generatedDir?: string;
    maxConcurrentJobs?: number;
    maxClipsPerJob?: number;
  } = {},
): Promise<TestStudio> {
  const repo = options.repo ?? new MemoryFilmRepository();
  const video = options.video ?? new ScriptedVideo();
  const editor = options.editor ?? new FakeEditor();
  const generatedDir = options.generatedDir ?? (await tempDir());
  const providers: StudioProviders = {
    mode: 'mock',
    director: new MockDirector(),
    video,
    poster: options.poster ?? new StubPoster(),
  };
  const runner = new JobRunner({
    repo,
    providers,
    editor,
    generatedDir,
    endCardText: 'AIFLIX Studio',
    maxConcurrentJobs: options.maxConcurrentJobs ?? 1,
    maxClipsPerJob: options.maxClipsPerJob ?? 40,
    logger: silentLogger,
  });
  return { repo, runner, video, editor, generatedDir };
}

/** Polls `check` until it returns true or the timeout expires. */
export async function waitFor(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition.');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
