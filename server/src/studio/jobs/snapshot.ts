/**
 * The plan snapshot: the validated story plan, the scene lengths and the locked canon, saved
 * next to the clips before the first paid video call. Resuming a job reloads it, so the
 * remaining scenes are rendered from the same plan instead of a new one.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isValidRuntime, MAX_CLIP_SECONDS, MIN_CLIP_SECONDS } from '../../../../shared/planner.ts';
import { parseCanon, parseStoryPlan } from '../director.ts';
import { asRecord } from '../text.ts';
import type { FilmBrief, LockedCanon, StoryPlan } from '../types.ts';
import { SNAPSHOT_FILE } from './media.ts';

const SNAPSHOT_VERSION = 1;

export interface PlanSnapshot {
  plan: StoryPlan;
  sceneDurations: number[];
  canon: LockedCanon;
}

export async function saveSnapshot(dir: string, snapshot: PlanSnapshot): Promise<void> {
  const file = path.join(dir, SNAPSHOT_FILE);
  const payload = { version: SNAPSHOT_VERSION, savedAt: new Date().toISOString(), ...snapshot };
  await writeFile(`${file}.tmp`, JSON.stringify(payload, null, 2), 'utf8');
  await rename(`${file}.tmp`, file);
}

/** Loads the snapshot for `brief`, or returns null when it is missing or does not match. */
export async function loadSnapshot(dir: string, brief: FilmBrief): Promise<PlanSnapshot | null> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path.join(dir, SNAPSHOT_FILE), 'utf8')) as unknown;
  } catch {
    return null;
  }

  const payload = asRecord(raw);
  const durations = payload.sceneDurations;
  if (payload.version !== SNAPSHOT_VERSION || !isPlanFor(durations, brief.durationSeconds)) {
    return null;
  }
  const plan = parseStoryPlan(payload.plan, durations.length, brief);
  return { plan, sceneDurations: durations, canon: parseCanon(payload.canon, plan, brief) };
}

/** True when `value` is a list of valid clip lengths that adds up to the runtime. */
function isPlanFor(value: unknown, runtimeSeconds: number): value is number[] {
  if (!Array.isArray(value) || value.length === 0 || !isValidRuntime(runtimeSeconds)) return false;
  const valid = value.every(
    (seconds) =>
      typeof seconds === 'number' &&
      Number.isInteger(seconds) &&
      seconds % 2 === 0 &&
      seconds >= MIN_CLIP_SECONDS &&
      seconds <= MAX_CLIP_SECONDS,
  );
  return valid && (value as number[]).reduce((sum, seconds) => sum + seconds, 0) === runtimeSeconds;
}
