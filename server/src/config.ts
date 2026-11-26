import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DEFAULT_POSTER_MODEL, DEFAULT_SCRIPT_MODEL } from './studio/providers/gemini.ts';

/** The bundled OFL font used for the end card and placeholder text. */
export const FONT_FILE = fileURLToPath(
  new URL('../../assets/fonts/DMSerifDisplay-Regular.ttf', import.meta.url),
);

export interface AppConfig {
  host: string;
  port: number;
  /** Null means the in-memory store. */
  mongoUri: string | null;
  /** Absolute path of the folder that holds generated media. */
  generatedDir: string;
  providers: 'mock' | 'live';
  googleApiKey: string;
  falKey: string;
  scriptModel: string;
  posterModel: string;
  maxConcurrentJobs: number;
  maxClipsPerJob: number;
  endCardText: string;
  ffmpegPath: string;
  ffprobePath: string;
  fontFile: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** `KEY=` in .env means "use the default". */
const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const text = (fallback: string) => z.preprocess(blankToUndefined, z.string().trim().default(fallback));
const integer = (min: number, fallback: number) =>
  z.preprocess(blankToUndefined, z.coerce.number().int().min(min).default(fallback));

const envSchema = z.object({
  HOST: text('127.0.0.1'),
  PORT: z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(65_535).default(3001)),
  MONGO_URI: text(''),
  GENERATED_DIR: text('generated'),
  STUDIO_PROVIDERS: z.preprocess(blankToUndefined, z.enum(['mock', 'live']).default('mock')),
  GOOGLE_API_KEY: text(''),
  FAL_KEY: text(''),
  STUDIO_SCRIPT_MODEL: text(DEFAULT_SCRIPT_MODEL),
  STUDIO_POSTER_MODEL: text(DEFAULT_POSTER_MODEL),
  STUDIO_MAX_CONCURRENT_JOBS: integer(1, 1),
  STUDIO_MAX_CLIPS_PER_JOB: integer(1, 12),
  STUDIO_END_CARD_TEXT: text('AIFLIX Studio'),
  FFMPEG_PATH: text('ffmpeg'),
  FFPROBE_PATH: text('ffprobe'),
});

/** Reads and validates the environment. Throws ConfigError with every problem listed. */
export function loadConfig(env: NodeJS.ProcessEnv, cwd = process.cwd()): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigError(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  const values = result.data;

  if (values.STUDIO_PROVIDERS === 'live') {
    const missing = [
      values.GOOGLE_API_KEY ? null : 'GOOGLE_API_KEY',
      values.FAL_KEY ? null : 'FAL_KEY',
    ].filter((name): name is string => name !== null);
    if (missing.length > 0) {
      throw new ConfigError(
        `STUDIO_PROVIDERS=live needs ${missing.join(' and ')}. Set them in .env, or leave STUDIO_PROVIDERS empty to use the offline mock providers.`,
      );
    }
  }

  return {
    host: values.HOST,
    port: values.PORT,
    mongoUri: values.MONGO_URI || null,
    generatedDir: path.resolve(cwd, values.GENERATED_DIR),
    providers: values.STUDIO_PROVIDERS,
    googleApiKey: values.GOOGLE_API_KEY,
    falKey: values.FAL_KEY,
    scriptModel: values.STUDIO_SCRIPT_MODEL,
    posterModel: values.STUDIO_POSTER_MODEL,
    maxConcurrentJobs: values.STUDIO_MAX_CONCURRENT_JOBS,
    maxClipsPerJob: values.STUDIO_MAX_CLIPS_PER_JOB,
    endCardText: values.STUDIO_END_CARD_TEXT,
    ffmpegPath: values.FFMPEG_PATH,
    ffprobePath: values.FFPROBE_PATH,
    fontFile: FONT_FILE,
  };
}
