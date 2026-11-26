import type { StudioInfoDto } from '../../../shared/api.ts';
import { CLIP_STEP_SECONDS, maxRuntimeForClipCap, MIN_RUNTIME_SECONDS } from '../../../shared/planner.ts';
import { MAX_PREMISE_LENGTH, MIN_PREMISE_LENGTH } from './validation.ts';

export interface StudioInfoSource {
  providers: 'mock' | 'live';
  store: 'memory' | 'mongo';
  maxClipsPerJob: number;
  maxConcurrentJobs: number;
  endCardText: string;
  drawsText: boolean;
  activeJobs: () => number;
}

/** What the web client needs to know about this server: modes, limits and the end card. */
export function studioInfo(source: StudioInfoSource): StudioInfoDto {
  return {
    providers: source.providers,
    store: source.store,
    limits: {
      minRuntimeSeconds: MIN_RUNTIME_SECONDS,
      maxRuntimeSeconds: maxRuntimeForClipCap(source.maxClipsPerJob),
      runtimeStepSeconds: CLIP_STEP_SECONDS,
      maxClipsPerJob: source.maxClipsPerJob,
      maxConcurrentJobs: source.maxConcurrentJobs,
      minPremiseLength: MIN_PREMISE_LENGTH,
      maxPremiseLength: MAX_PREMISE_LENGTH,
    },
    endCard: { text: source.endCardText, drawsText: source.drawsText },
    activeJobs: source.activeJobs(),
  };
}
