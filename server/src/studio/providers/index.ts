import type { AppConfig } from '../../config.ts';
import type { PlaceholderRenderer } from '../editor/runner.ts';
import { FalVideoModel } from './fal.ts';
import {
  createGeminiClient,
  DEFAULT_POSTER_MODEL,
  DEFAULT_SCRIPT_MODEL,
  GeminiDirector,
  GeminiPoster,
  modelChain,
  POSTER_MODEL_FALLBACKS,
  SCRIPT_MODEL_FALLBACKS,
} from './gemini.ts';
import { MockDirector, MockPoster, MockVideo } from './mock.ts';
import type { StudioProviders } from './types.ts';

export function createProviders(config: AppConfig, renderer: PlaceholderRenderer): StudioProviders {
  if (config.providers === 'mock') {
    return {
      mode: 'mock',
      director: new MockDirector(),
      video: new MockVideo(renderer),
      poster: new MockPoster(renderer),
    };
  }

  const client = createGeminiClient(config.googleApiKey);
  return {
    mode: 'live',
    director: new GeminiDirector({
      client,
      models: modelChain(config.scriptModel, [DEFAULT_SCRIPT_MODEL, ...SCRIPT_MODEL_FALLBACKS]),
    }),
    video: new FalVideoModel({ apiKey: config.falKey }),
    poster: new GeminiPoster({
      client,
      models: modelChain(config.posterModel, [DEFAULT_POSTER_MODEL, ...POSTER_MODEL_FALLBACKS]),
    }),
  };
}
