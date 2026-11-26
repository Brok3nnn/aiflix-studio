import type { FilmBrief, StoryPlan } from '../types.ts';

/** Per-call hooks: progress lines for the job log and cancellation. */
export interface CallContext {
  /** Receives retry and fallback notices for the job log. Must not throw. */
  notify?: (message: string) => Promise<void>;
  signal?: AbortSignal;
}

export interface StoryPlanRequest {
  /** Fully built prompt (see director.ts). Live models send it; the mock reads the brief. */
  prompt: string;
  brief: FilmBrief;
  sceneCount: number;
}

export interface CanonRequest {
  prompt: string;
  brief: FilmBrief;
  plan: StoryPlan;
}

/** The text model behind the director. Returns raw JSON; director.ts validates it. */
export interface DirectorModel {
  writeStoryPlan(request: StoryPlanRequest, context?: CallContext): Promise<unknown>;
  lockCanon(request: CanonRequest, context?: CallContext): Promise<unknown>;
}

export interface ClipRequest {
  prompt: string;
  durationSeconds: number;
  /** Where to write the finished MP4. */
  outputPath: string;
  scene: { index: number; title: string };
}

/** Text-to-video model: one call per scene. */
export interface VideoModel {
  /** Human-readable name for logs. */
  readonly label: string;
  renderClip(request: ClipRequest, context?: CallContext): Promise<void>;
}

export interface PosterRequest {
  prompt: string;
  /** Where to write the PNG. */
  outputPath: string;
  title: string;
}

export interface PosterModel {
  renderPoster(request: PosterRequest, context?: CallContext): Promise<void>;
}

export interface StudioProviders {
  mode: 'mock' | 'live';
  director: DirectorModel;
  video: VideoModel;
  poster: PosterModel;
}
