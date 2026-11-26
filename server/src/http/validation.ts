import { z } from 'zod';
import { MAX_RUNTIME_SECONDS, MIN_RUNTIME_SECONDS } from '../../../shared/planner.ts';
import { StudioError } from '../errors.ts';
import { isFilmId } from '../studio/jobs/media.ts';
import type { FilmBrief } from '../studio/types.ts';

export const MIN_PREMISE_LENGTH = 12;
export const MAX_PREMISE_LENGTH = 2_000;

const RUNTIME_MESSAGE = `Runtime must be an even number of seconds from ${String(MIN_RUNTIME_SECONDS)} to ${String(MAX_RUNTIME_SECONDS)}.`;

export const createFilmSchema = z.strictObject({
  premise: z
    .string({ error: 'premise is required and must be text.' })
    .trim()
    .min(MIN_PREMISE_LENGTH, `Premise must be at least ${String(MIN_PREMISE_LENGTH)} characters.`)
    .max(MAX_PREMISE_LENGTH, `Premise must be at most ${String(MAX_PREMISE_LENGTH)} characters.`),
  look: z.enum(['realistic', 'animated'], { error: 'look must be "realistic" or "animated".' }),
  durationSeconds: z
    .number({ error: RUNTIME_MESSAGE })
    .int(RUNTIME_MESSAGE)
    .min(MIN_RUNTIME_SECONDS, RUNTIME_MESSAGE)
    .max(MAX_RUNTIME_SECONDS, RUNTIME_MESSAGE)
    .multipleOf(2, RUNTIME_MESSAGE),
  title: z.string().trim().max(120, 'Title must be at most 120 characters.').optional(),
  genres: z
    .array(z.string().trim().min(1).max(40), { error: 'genres must be a list of names.' })
    .max(6, 'At most 6 genres.')
    .optional(),
  minMainCharacters: z.number().int().min(1).max(6).optional(),
  minSupportingCharacters: z.number().int().min(0).max(12).optional(),
});

export type CreateFilmInput = z.infer<typeof createFilmSchema>;

/** Validates a request body; throws a 400 StudioError that lists every problem. */
export function parseCreateFilm(body: unknown): CreateFilmInput {
  const result = createFilmSchema.safeParse(body ?? {});
  if (!result.success) {
    throw new StudioError('invalid_request', formatIssues(result.error));
  }
  return result.data;
}

export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => (issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message))
    .join(' ');
}

export function toBrief(input: CreateFilmInput): FilmBrief {
  const genres = input.genres?.filter(Boolean) ?? [];
  return {
    title: input.title || titleFromPremise(input.premise),
    premise: input.premise,
    genres: genres.length > 0 ? genres : ['Drama'],
    look: input.look,
    durationSeconds: input.durationSeconds,
    minMainCharacters: input.minMainCharacters ?? 2,
    minSupportingCharacters: input.minSupportingCharacters ?? 2,
  };
}

/** The first five words of the premise, used when no title is given. */
export function titleFromPremise(premise: string): string {
  const words = premise.replace(/\s+/g, ' ').trim().split(' ').slice(0, 5).join(' ');
  return words.replace(/[.,;:!?]+$/, '') || 'Untitled';
}

export function parseFilmId(value: unknown): string {
  if (typeof value !== 'string' || !isFilmId(value)) {
    throw new StudioError('not_found', 'Film not found.');
  }
  return value;
}
