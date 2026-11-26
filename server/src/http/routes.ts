import { Router } from 'express';
import type { StudioInfoDto } from '../../../shared/api.ts';
import { StudioError } from '../errors.ts';
import type { FilmRepository } from '../store/repository.ts';
import type { JobRunner } from '../studio/jobs/runner.ts';
import { toFilmDto } from './dto.ts';
import { parseCreateFilm, parseFilmId, toBrief } from './validation.ts';

const LIST_LIMIT = 100;

export interface ApiDeps {
  repo: FilmRepository;
  runner: JobRunner;
  studioInfo: () => StudioInfoDto;
}

export function apiRouter({ repo, runner, studioInfo }: ApiDeps): Router {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/studio', (_req, res) => {
    res.json(studioInfo());
  });

  router.get('/films', async (_req, res) => {
    const films = await repo.list(LIST_LIMIT);
    res.json({ films: films.map(toFilmDto) });
  });

  router.get('/films/:id', async (req, res) => {
    const film = await repo.get(parseFilmId(req.params.id));
    if (!film) throw new StudioError('not_found', 'Film not found.');
    res.json({ film: toFilmDto(film) });
  });

  router.post('/films', async (req, res) => {
    const input = parseCreateFilm(req.body);
    const film = await runner.create(toBrief(input));
    res.status(202).json({ film: toFilmDto(film) });
  });

  router.post('/films/:id/resume', async (req, res) => {
    const film = await runner.resume(parseFilmId(req.params.id));
    res.status(202).json({ film: toFilmDto(film) });
  });

  router.delete('/films/:id', async (req, res) => {
    await runner.delete(parseFilmId(req.params.id));
    res.status(204).end();
  });

  return router;
}
