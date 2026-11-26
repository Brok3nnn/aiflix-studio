import type {
  CastMember,
  FilmBrief,
  FilmFailure,
  FilmStatus,
  LogEntry,
  SceneSummary,
  StorySummary,
} from '../../../shared/api.ts';

export type {
  CastMember,
  FailureKind,
  FilmBrief,
  FilmFailure,
  FilmStatus,
  Look,
  LogEntry,
  SceneSummary,
  StorySummary,
} from '../../../shared/api.ts';

/** One character in the director's story bible. */
export interface CharacterPlan {
  characterId: string;
  name: string;
  roleType: 'main' | 'supporting';
  storyRole: string;
  ageDescriptor: string;
  personality: string;
  motivation: string;
  appearance: string;
  wardrobe: string;
  visualSignature: string;
}

/** One scene of the director's timeline. Each scene becomes exactly one video clip. */
export interface ScenePlan {
  index: number;
  title: string;
  beat: string;
  sceneObjective: string;
  storyPurpose: string;
  conflict: string;
  turningPoint: string;
  carryOverFromPrevious: string;
  consequenceForNext: string;
  primaryLocation: string;
  timeMarker: string;
  characterIds: string[];
  dialoguePurpose: string;
  dialogueLines: string[];
  /** 1-5: how much of the runtime this scene deserves. */
  durationWeight: number;
  shotPrompt: string;
  continuityAnchor: string;
}

/** The validated story bible written by the director model. */
export interface StoryPlan {
  synopsis: string;
  premise: string;
  theme: string;
  castStrategy: string;
  storyBible: string;
  continuityRules: string[];
  relationshipMap: string[];
  locationBible: string[];
  masterTimeline: string[];
  styleMedium: string;
  styleNegative: string[];
  visualStyle: string;
  posterPrompt: string;
  characters: CharacterPlan[];
  scenes: ScenePlan[];
}

/** Output of the locked second pass: copy that may only use facts from the plan. */
export interface LockedCanon {
  description: string;
  posterDirection: string;
}

export interface ClipRecord {
  sceneIndex: number;
  /** File name inside the film's media folder, e.g. `clip-01.mp4`. */
  file: string;
  durationSeconds: number;
}

/** A film as stored by the repository. */
export interface FilmRecord {
  id: string;
  brief: FilmBrief;
  status: FilmStatus;
  progress: number;
  statusText: string;
  failure: FilmFailure | null;
  story: StorySummary | null;
  cast: CastMember[];
  scenes: SceneSummary[];
  clips: ClipRecord[];
  /** File names inside the film's media folder. */
  videoFile: string | null;
  posterFile: string | null;
  logs: LogEntry[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Fields a running job may change. The brief (and with it the requested runtime) is
 * deliberately absent: it is fixed when the film is created.
 */
export type FilmPatch = Partial<
  Pick<
    FilmRecord,
    | 'status'
    | 'progress'
    | 'statusText'
    | 'failure'
    | 'story'
    | 'cast'
    | 'scenes'
    | 'clips'
    | 'videoFile'
    | 'posterFile'
  >
>;
