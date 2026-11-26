import type { FilmPatch, FilmRecord, FilmStatus, LogEntry } from '../studio/types.ts';

/** Oldest log entries are dropped beyond this many, so a long job cannot grow without bound. */
export const MAX_LOG_ENTRIES = 500;

/** Persistence for films. MongoDB in real runs; an in-memory map in tests and the demo. */
export interface FilmRepository {
  readonly kind: 'memory' | 'mongo';
  create(film: FilmRecord): Promise<void>;
  get(id: string): Promise<FilmRecord | null>;
  /** Newest first. */
  list(limit: number): Promise<FilmRecord[]>;
  listByStatus(statuses: readonly FilmStatus[]): Promise<FilmRecord[]>;
  /**
   * Applies `patch`, appends `log` when given and bumps `updatedAt`, in one write.
   * Returns the updated film, or null when it does not exist.
   */
  update(id: string, patch: FilmPatch, log?: LogEntry): Promise<FilmRecord | null>;
  delete(id: string): Promise<boolean>;
  close(): Promise<void>;
}

/** Drops keys whose value is `undefined`, so a patch can never erase a field by accident. */
export function definedFields(patch: FilmPatch): FilmPatch {
  const defined: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch) as [string, unknown][]) {
    if (value !== undefined) defined[key] = value;
  }
  return defined;
}
