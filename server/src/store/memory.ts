import type { FilmPatch, FilmRecord, FilmStatus, LogEntry } from '../studio/types.ts';
import { definedFields, MAX_LOG_ENTRIES, type FilmRepository } from './repository.ts';

/**
 * Keeps films in a Map. Used by the tests and by the default demo, so nothing needs MongoDB;
 * films are lost when the server stops (the media stays on disk). Records are copied on the
 * way in and out so callers can never mutate stored state by accident.
 */
export class MemoryFilmRepository implements FilmRepository {
  readonly kind = 'memory';
  readonly #films = new Map<string, FilmRecord>();
  readonly #now: () => Date;

  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  create(film: FilmRecord): Promise<void> {
    if (this.#films.has(film.id)) {
      return Promise.reject(new Error(`Film ${film.id} already exists.`));
    }
    this.#films.set(film.id, structuredClone(film));
    return Promise.resolve();
  }

  get(id: string): Promise<FilmRecord | null> {
    const film = this.#films.get(id);
    return Promise.resolve(film ? structuredClone(film) : null);
  }

  list(limit: number): Promise<FilmRecord[]> {
    const films = [...this.#films.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
    return Promise.resolve(structuredClone(films));
  }

  listByStatus(statuses: readonly FilmStatus[]): Promise<FilmRecord[]> {
    const films = [...this.#films.values()].filter((film) => statuses.includes(film.status));
    return Promise.resolve(structuredClone(films));
  }

  update(id: string, patch: FilmPatch, log?: LogEntry): Promise<FilmRecord | null> {
    const film = this.#films.get(id);
    if (!film) return Promise.resolve(null);
    const logs = log ? [...film.logs, log].slice(-MAX_LOG_ENTRIES) : film.logs;
    const next: FilmRecord = {
      ...film,
      ...structuredClone(definedFields(patch)),
      logs,
      updatedAt: this.#now().toISOString(),
    };
    this.#films.set(id, next);
    return Promise.resolve(structuredClone(next));
  }

  delete(id: string): Promise<boolean> {
    return Promise.resolve(this.#films.delete(id));
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}
