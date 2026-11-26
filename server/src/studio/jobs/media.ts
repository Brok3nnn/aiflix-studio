import path from 'node:path';

/** Every film keeps its files in `<GENERATED_DIR>/<film id>/`. */
export const FILM_FILE = 'final.mp4';
export const SNAPSHOT_FILE = 'plan-snapshot.json';

const FILM_ID_PATTERN = /^film-[a-z0-9]+-[a-f0-9]{6}$/;

export function isFilmId(value: string): boolean {
  return FILM_ID_PATTERN.test(value);
}

export function filmDir(generatedDir: string, filmId: string): string {
  if (!isFilmId(filmId)) throw new Error(`Invalid film id: ${filmId}`);
  return path.join(generatedDir, filmId);
}

export function clipFile(sceneIndex: number): string {
  return `clip-${String(sceneIndex + 1).padStart(2, '0')}.mp4`;
}

/** Clips are rendered under this name and renamed when complete, so partial files never count. */
export function partialClipFile(sceneIndex: number): string {
  return `clip-${String(sceneIndex + 1).padStart(2, '0')}.partial.mp4`;
}
