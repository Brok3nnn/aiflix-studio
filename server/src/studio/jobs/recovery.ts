import type { FilmRepository } from '../../store/repository.ts';
import type { FilmFailure } from '../types.ts';

/**
 * Jobs run inside the server process, so a crash or restart kills them. On start-up, before
 * any new job can start, every film still marked queued or generating is an orphan: mark it
 * failed and resumable. Resuming reuses the saved plan and the clips already on disk.
 */
export async function recoverInterruptedFilms(
  repo: FilmRepository,
  now: () => Date = () => new Date(),
): Promise<string[]> {
  const orphans = await repo.listByStatus(['queued', 'generating']);
  const failure: FilmFailure = {
    kind: 'interrupted',
    message: 'The server stopped while this film was rendering. Resume to continue.',
    sceneIndex: null,
    resumable: true,
  };
  for (const film of orphans) {
    await repo.update(
      film.id,
      { status: 'failed', statusText: 'Interrupted.', failure },
      { at: now().toISOString(), level: 'warn', message: failure.message },
    );
  }
  return orphans.map((film) => film.id);
}
