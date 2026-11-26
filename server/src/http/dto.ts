import type { FilmDto } from '../../../shared/api.ts';
import type { FilmRecord } from '../studio/types.ts';

/** Media is served from `/media/<film id>/<file>`: relative URLs, so any host or port works. */
export function mediaUrl(filmId: string, file: string): string {
  return `/media/${encodeURIComponent(filmId)}/${encodeURIComponent(file)}`;
}

export function toFilmDto(film: FilmRecord): FilmDto {
  return {
    id: film.id,
    brief: film.brief,
    status: film.status,
    progress: film.progress,
    statusText: film.statusText,
    failure: film.failure,
    story: film.story,
    cast: film.cast,
    scenes: film.scenes,
    clips: film.clips.map((clip) => ({
      sceneIndex: clip.sceneIndex,
      durationSeconds: clip.durationSeconds,
      url: mediaUrl(film.id, clip.file),
    })),
    videoUrl: film.videoFile ? mediaUrl(film.id, film.videoFile) : null,
    posterUrl: film.posterFile ? mediaUrl(film.id, film.posterFile) : null,
    logs: film.logs,
    createdAt: film.createdAt,
    updatedAt: film.updatedAt,
  };
}
