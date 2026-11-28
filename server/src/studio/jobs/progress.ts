import type { Logger } from '../../logger.ts';
import type { FilmRepository } from '../../store/repository.ts';
import { errorMessage } from '../providers/errors.ts';
import type { FilmPatch, LogEntry } from '../types.ts';

/**
 * Writes a job's progress to the repository. Every write is awaited.
 *
 * Progress and log lines are best effort: if the store is briefly unavailable the job keeps
 * going and the problem is logged on the server. State the job depends on (`save`) is not
 * best effort: a failed write there fails the job, which can then be resumed.
 */
export class JobReporter {
  readonly #repo: FilmRepository;
  readonly #filmId: string;
  readonly #logger: Logger;
  readonly #now: () => Date;

  constructor(repo: FilmRepository, filmId: string, logger: Logger, now: () => Date = () => new Date()) {
    this.#repo = repo;
    this.#filmId = filmId;
    this.#logger = logger;
    this.#now = now;
  }

  /** Moves the progress bar, sets the status line and logs `message` (default: the status). */
  stage(progress: number, statusText: string, message = statusText): Promise<void> {
    return this.#tryWrite({ progress: Math.round(progress), statusText }, this.#entry('info', message));
  }

  warn(message: string): Promise<void> {
    return this.#tryWrite({}, this.#entry('warn', message));
  }

  /** Persists job state. Unlike the progress methods, a failure here propagates. */
  async save(patch: FilmPatch, message?: string): Promise<void> {
    const updated = await this.#repo.update(
      this.#filmId,
      patch,
      message === undefined ? undefined : this.#entry('info', message),
    );
    if (!updated) throw new Error(`Film ${this.#filmId} no longer exists.`);
  }

  async #tryWrite(patch: FilmPatch, log: LogEntry): Promise<void> {
    try {
      await this.#repo.update(this.#filmId, patch, log);
    } catch (error) {
      this.#logger.warn(`Could not record progress for ${this.#filmId}: ${errorMessage(error)}`);
    }
  }

  #entry(level: LogEntry['level'], message: string): LogEntry {
    return { at: this.#now().toISOString(), level, message };
  }
}
