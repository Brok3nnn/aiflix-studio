/** The six calls the studio makes to the local API. Types come from shared/api.ts. */
import type { ApiErrorBody, CreateFilmRequest, FilmDto, StudioInfoDto } from '../../shared/api.ts';

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
    });
  } catch {
    throw new Error('Cannot reach the studio server. Is `npm run dev` running?');
  }
  if (response.status === 204) return undefined as T;

  const body = (await response.json().catch(() => null)) as T | ApiErrorBody | null;
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'error' in body
        ? body.error
        : `Request failed (${String(response.status)}).`;
    throw new Error(message);
  }
  return body as T;
}

export const api = {
  studio: (): Promise<StudioInfoDto> => request('/studio'),
  listFilms: async (): Promise<FilmDto[]> => (await request<{ films: FilmDto[] }>('/films')).films,
  getFilm: async (id: string): Promise<FilmDto> =>
    (await request<{ film: FilmDto }>(`/films/${encodeURIComponent(id)}`)).film,
  createFilm: async (payload: CreateFilmRequest): Promise<FilmDto> =>
    (await request<{ film: FilmDto }>('/films', { method: 'POST', body: JSON.stringify(payload) })).film,
  resumeFilm: async (id: string): Promise<FilmDto> =>
    (await request<{ film: FilmDto }>(`/films/${encodeURIComponent(id)}/resume`, { method: 'POST' })).film,
  deleteFilm: (id: string): Promise<void> =>
    request(`/films/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
