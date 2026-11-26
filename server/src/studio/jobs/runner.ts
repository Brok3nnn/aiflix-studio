/**
 * Starts, resumes and deletes film jobs, and enforces the cost guards: a limit on jobs that
 * run at the same time, and a cap on clips (paid video calls) per job.
 */
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { planSceneCount } from '../../../../shared/planner.ts';
import { StudioError } from '../../errors.ts';
import type { Logger } from '../../logger.ts';
import type { FilmRepository } from '../../store/repository.ts';
import type { FilmEditor } from '../editor/runner.ts';
import { ContentPolicyError, errorMessage, ProviderError } from '../providers/errors.ts';
import type { StudioProviders } from '../providers/types.ts';
import type { FilmBrief, FilmFailure, FilmRecord } from '../types.ts';
import { filmDir } from './media.ts';
import { runFilmPipeline, SceneRenderError } from './pipeline.ts';

export interface JobRunnerOptions {
  repo: FilmRepository;
  providers: StudioProviders;
  editor: FilmEditor;
  generatedDir: string;
  endCardText: string;
  maxConcurrentJobs: number;
  maxClipsPerJob: number;
  logger: Logger;
  now?: () => Date;
}

export class JobRunner {
  readonly #options: JobRunnerOptions;
  readonly #now: () => Date;
  /** Jobs that hold a slot, including ones still being written to the store. */
  readonly #running = new Map<string, Promise<void>>();
  readonly #shutdown = new AbortController();

  constructor(options: JobRunnerOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  get activeJobs(): number {
    return this.#running.size;
  }

  isRunning(filmId: string): boolean {
    return this.#running.has(filmId);
  }

  async create(brief: FilmBrief): Promise<FilmRecord> {
    this.#assertWithinClipCap(brief.durationSeconds);
    const now = this.#now().toISOString();
    const film: FilmRecord = {
      id: newFilmId(this.#now()),
      brief,
      status: 'queued',
      progress: 0,
      statusText: 'Queued.',
      failure: null,
      story: null,
      cast: [],
      scenes: [],
      clips: [],
      videoFile: null,
      posterFile: null,
      logs: [{ at: now, level: 'info', message: 'Film queued.' }],
      createdAt: now,
      updatedAt: now,
    };
    const release = this.#reserve(film.id);
    try {
      await this.#options.repo.create(film);
    } catch (error) {
      release();
      throw error;
    }
    this.#launch(film, release);
    return film;
  }

  async resume(filmId: string): Promise<FilmRecord> {
    const film = await this.#options.repo.get(filmId);
    if (!film) throw new StudioError('not_found', 'Film not found.');
    if (this.isRunning(filmId) || film.status === 'queued' || film.status === 'generating') {
      throw new StudioError('conflict', 'This film is already rendering.');
    }
    if (film.status !== 'failed' || !film.failure?.resumable) {
      throw new StudioError('conflict', 'Only failed films that can be resumed can be resumed.');
    }
    this.#assertWithinClipCap(film.brief.durationSeconds);

    const release = this.#reserve(filmId);
    try {
      const updated = await this.#options.repo.update(
        filmId,
        { status: 'queued', failure: null, statusText: 'Resuming.' },
        { at: this.#now().toISOString(), level: 'info', message: 'Resume requested.' },
      );
      if (!updated) throw new StudioError('not_found', 'Film not found.');
      this.#launch(updated, release);
      return updated;
    } catch (error) {
      release();
      throw error;
    }
  }

  /** Deletes a film and its media folder. Refused while the film is rendering. */
  async delete(filmId: string): Promise<void> {
    if (this.isRunning(filmId)) {
      throw new StudioError('conflict', 'This film is rendering; wait for it to finish or fail.');
    }
    const deleted = await this.#options.repo.delete(filmId);
    if (!deleted) throw new StudioError('not_found', 'Film not found.');
    await rm(filmDir(this.#options.generatedDir, filmId), { recursive: true, force: true });
  }

  /** Waits for every running job to settle. Used by tests and on shutdown. */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.#running.values()]);
  }

  /** Cancels running jobs (they are recorded as failed and can be resumed later). */
  async stop(): Promise<void> {
    this.#shutdown.abort();
    await this.idle();
  }

  /**
   * Takes a job slot synchronously, before any await, so two requests that arrive together
   * cannot both pass the limit check.
   */
  #reserve(filmId: string): () => void {
    if (this.#running.size >= this.#options.maxConcurrentJobs) {
      throw new StudioError(
        'busy',
        `Another film is rendering. This server runs ${String(this.#options.maxConcurrentJobs)} job(s) at a time (STUDIO_MAX_CONCURRENT_JOBS).`,
      );
    }
    this.#running.set(filmId, Promise.resolve());
    return () => {
      this.#running.delete(filmId);
    };
  }

  #assertWithinClipCap(runtimeSeconds: number): void {
    const clips = planSceneCount(runtimeSeconds);
    if (clips > this.#options.maxClipsPerJob) {
      throw new StudioError(
        'invalid_request',
        `A ${String(runtimeSeconds)}s film needs ${String(clips)} clips, but this server allows at most ${String(this.#options.maxClipsPerJob)} per job (STUDIO_MAX_CLIPS_PER_JOB).`,
      );
    }
  }

  #launch(film: FilmRecord, release: () => void): void {
    const job = this.#execute(film).finally(release);
    this.#running.set(film.id, job);
  }

  async #execute(film: FilmRecord): Promise<void> {
    const { repo, logger } = this.#options;
    try {
      await repo.update(film.id, { status: 'generating' });
      await runFilmPipeline(film, { ...this.#options, signal: this.#shutdown.signal });
    } catch (error) {
      const failure = describeFailure(error, this.#shutdown.signal.aborted);
      logger.error(`Film ${film.id} failed: ${failure.message}`, error);
      try {
        await repo.update(
          film.id,
          { status: 'failed', statusText: 'Failed.', failure },
          { at: this.#now().toISOString(), level: 'error', message: failure.message },
        );
      } catch (writeError) {
        logger.error(`Could not record the failure of film ${film.id}.`, writeError);
      }
    }
  }
}

/**
 * Turns an error into the failure the user sees. Content-policy rejections name the scene and
 * cannot be resumed: resuming would only send the same prompt again.
 */
export function describeFailure(error: unknown, interrupted = false): FilmFailure {
  const scene = error instanceof SceneRenderError ? error : null;
  const cause = scene ? scene.cause : error;
  const sceneIndex = scene ? scene.sceneIndex : null;

  if (interrupted) {
    return {
      kind: 'interrupted',
      message: 'The server stopped while this film was rendering. Resume to continue.',
      sceneIndex,
      resumable: true,
    };
  }
  if (cause instanceof ContentPolicyError) {
    const subject = scene
      ? `Scene ${String(scene.sceneIndex + 1)} ("${scene.sceneTitle}")`
      : 'The story plan';
    const flagged = cause.categories.length > 0 ? ` (flagged: ${cause.categories.join(', ')})` : '';
    return {
      kind: 'content_policy',
      message: `${subject} was rejected by ${cause.provider}'s content policy${flagged}. The studio does not rewrite prompts to get past a provider's safety filter; change the premise and start a new film.`,
      sceneIndex,
      resumable: false,
    };
  }
  return {
    kind: cause instanceof ProviderError ? 'provider' : 'internal',
    message: errorMessage(error),
    sceneIndex,
    resumable: true,
  };
}

function newFilmId(now: Date): string {
  return `film-${now.getTime().toString(36)}-${randomBytes(3).toString('hex')}`;
}
