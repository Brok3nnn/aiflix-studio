/**
 * Types shared by the HTTP API and the web client. Type-only: nothing here exists at runtime.
 */

export type Look = 'realistic' | 'animated';

export type FilmStatus = 'queued' | 'generating' | 'ready' | 'failed';

export type FailureKind = 'content_policy' | 'provider' | 'interrupted' | 'internal';

export interface FilmBrief {
  title: string;
  premise: string;
  genres: string[];
  look: Look;
  /** The runtime the user asked for. Never changed after the film is created. */
  durationSeconds: number;
  minMainCharacters: number;
  minSupportingCharacters: number;
}

export interface FilmFailure {
  kind: FailureKind;
  message: string;
  /** Zero-based index of the scene that failed, when the failure belongs to one scene. */
  sceneIndex: number | null;
  /** Whether "Resume" can continue the job from where it stopped. */
  resumable: boolean;
}

export interface LogEntry {
  at: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface CastMember {
  characterId: string;
  name: string;
  roleType: 'main' | 'supporting';
  storyRole: string;
  appearance: string;
  wardrobe: string;
  visualSignature: string;
}

export interface SceneSummary {
  index: number;
  title: string;
  beat: string;
  location: string;
  timeMarker: string;
  characterIds: string[];
  durationSeconds: number;
}

export interface StorySummary {
  synopsis: string;
  theme: string;
  styleMedium: string;
  visualStyle: string;
  locations: string[];
  continuityRules: string[];
  relationships: string[];
  timeline: string[];
}

export interface ClipDto {
  sceneIndex: number;
  durationSeconds: number;
  url: string;
}

export interface FilmDto {
  id: string;
  brief: FilmBrief;
  status: FilmStatus;
  progress: number;
  statusText: string;
  failure: FilmFailure | null;
  story: StorySummary | null;
  cast: CastMember[];
  scenes: SceneSummary[];
  clips: ClipDto[];
  videoUrl: string | null;
  posterUrl: string | null;
  logs: LogEntry[];
  createdAt: string;
  updatedAt: string;
}

export interface StudioInfoDto {
  providers: 'mock' | 'live';
  store: 'memory' | 'mongo';
  limits: {
    minRuntimeSeconds: number;
    maxRuntimeSeconds: number;
    runtimeStepSeconds: number;
    maxClipsPerJob: number;
    maxConcurrentJobs: number;
    minPremiseLength: number;
    maxPremiseLength: number;
  };
  endCard: {
    text: string;
    /** False when the local ffmpeg has no `drawtext` filter: the end card is then text-free. */
    drawsText: boolean;
  };
  activeJobs: number;
}

export interface CreateFilmRequest {
  premise: string;
  look: Look;
  durationSeconds: number;
  title?: string;
  genres?: string[];
  minMainCharacters?: number;
  minSupportingCharacters?: number;
}

export interface ApiErrorBody {
  error: string;
}
