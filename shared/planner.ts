/**
 * Exact-runtime planner.
 *
 * The video model renders clips of 6 to 20 seconds in 2-second steps. The planner splits a
 * requested runtime into that many scenes so that the clips add up to the runtime exactly:
 *
 * 1. The scene count is round(runtime / 14), kept inside the range where every scene can be
 *    between 6 and 20 seconds long.
 * 2. Every scene starts at 6 seconds.
 * 3. The remaining seconds are shared out in 2-second units, in proportion to each scene's
 *    `durationWeight` (1 to 5, chosen by the director).
 * 4. No scene goes over 20 seconds: a capped scene's excess is shared among the others, and
 *    fractional shares are rounded with the largest-remainder method.
 *
 * Pure functions only: the server uses them to plan a film, the web client to preview one.
 */

export const MIN_CLIP_SECONDS = 6;
export const MAX_CLIP_SECONDS = 20;
export const CLIP_STEP_SECONDS = 2;
export const TARGET_SCENE_SECONDS = 14;

export const MIN_RUNTIME_SECONDS = 8;
export const MAX_RUNTIME_SECONDS = 480;

export const MIN_DURATION_WEIGHT = 1;
export const MAX_DURATION_WEIGHT = 5;
export const DEFAULT_DURATION_WEIGHT = 3;

export function isValidRuntime(runtimeSeconds: number): boolean {
  return (
    Number.isInteger(runtimeSeconds) &&
    runtimeSeconds % CLIP_STEP_SECONDS === 0 &&
    runtimeSeconds >= MIN_RUNTIME_SECONDS &&
    runtimeSeconds <= MAX_RUNTIME_SECONDS
  );
}

export function assertValidRuntime(runtimeSeconds: number): void {
  if (!isValidRuntime(runtimeSeconds)) {
    throw new RangeError(
      `Runtime must be an even number of seconds from ${String(MIN_RUNTIME_SECONDS)} to ${String(MAX_RUNTIME_SECONDS)}; got ${String(runtimeSeconds)}.`,
    );
  }
}

/** The smallest and largest scene count that can fill the runtime with 6-20 second clips. */
export function sceneCountRange(runtimeSeconds: number): { min: number; max: number } {
  assertValidRuntime(runtimeSeconds);
  return {
    min: Math.ceil(runtimeSeconds / MAX_CLIP_SECONDS),
    max: Math.floor(runtimeSeconds / MIN_CLIP_SECONDS),
  };
}

/** Number of scenes, and therefore of paid video clips, for a runtime: round(runtime / 14). */
export function planSceneCount(runtimeSeconds: number): number {
  const { min, max } = sceneCountRange(runtimeSeconds);
  return clamp(Math.round(runtimeSeconds / TARGET_SCENE_SECONDS), min, max);
}

/** Coerces a director-supplied weight to an integer from 1 to 5. */
export function normalizeDurationWeight(value: unknown, fallback = DEFAULT_DURATION_WEIGHT): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(parsed)) return fallback;
  return clamp(Math.round(parsed), MIN_DURATION_WEIGHT, MAX_DURATION_WEIGHT);
}

/**
 * Splits `runtimeSeconds` into one clip length per weight. The result always sums to the
 * runtime exactly, and every entry is a valid clip length (6-20 seconds, even).
 */
export function allocateSceneDurations(runtimeSeconds: number, weights: readonly unknown[]): number[] {
  const { min, max } = sceneCountRange(runtimeSeconds);
  const sceneCount = weights.length;
  if (sceneCount < min || sceneCount > max) {
    throw new RangeError(
      `A ${String(runtimeSeconds)}s runtime needs ${String(min)} to ${String(max)} scenes; got ${String(sceneCount)}.`,
    );
  }

  const normalized = weights.map((weight) => normalizeDurationWeight(weight));
  const spareUnits = (runtimeSeconds - sceneCount * MIN_CLIP_SECONDS) / CLIP_STEP_SECONDS;
  const maxUnitsPerScene = (MAX_CLIP_SECONDS - MIN_CLIP_SECONDS) / CLIP_STEP_SECONDS;

  const shares = cappedShares(spareUnits, normalized, maxUnitsPerScene);
  const units = shares.map((share) => Math.floor(share));
  const leftover = spareUnits - units.reduce((sum, value) => sum + value, 0);

  // Largest remainder: the leftover units go to the largest fractional parts; on a tie the
  // heavier scene wins, then the earlier one. Only shares below the cap have a fractional
  // part, so no scene can go over the cap here.
  const order = shares
    .map((share, index) => ({ index, remainder: share - Math.floor(share) }))
    .sort(
      (a, b) =>
        b.remainder - a.remainder ||
        (normalized[b.index] ?? 0) - (normalized[a.index] ?? 0) ||
        a.index - b.index,
    );
  for (const { index } of order.slice(0, Math.round(leftover))) {
    units[index] = (units[index] ?? 0) + 1;
  }

  return units.map((value) => MIN_CLIP_SECONDS + value * CLIP_STEP_SECONDS);
}

/**
 * Splits `total` in proportion to `weights` with no share above `cap`. A share that would
 * exceed the cap is fixed at the cap and the rest is split again among the other scenes.
 */
function cappedShares(total: number, weights: readonly number[], cap: number): number[] {
  const shares = weights.map(() => 0);
  let open = weights.map((_, index) => index);
  let remaining = total;
  while (open.length > 0) {
    const openWeight = open.reduce((sum, index) => sum + (weights[index] ?? 0), 0);
    const share = (index: number): number => (remaining * (weights[index] ?? 0)) / openWeight;
    const capped = open.filter((index) => share(index) >= cap);
    if (capped.length === 0) {
      for (const index of open) shares[index] = share(index);
      break;
    }
    for (const index of capped) shares[index] = cap;
    remaining -= capped.length * cap;
    open = open.filter((index) => !capped.includes(index));
  }
  return shares;
}

/** Scene lengths for a runtime before the director has weighted the scenes. */
export function previewSceneDurations(runtimeSeconds: number): number[] {
  const count = planSceneCount(runtimeSeconds);
  return allocateSceneDurations(runtimeSeconds, new Array<number>(count).fill(DEFAULT_DURATION_WEIGHT));
}

/** The longest valid runtime whose plan stays within `maxClips` clips. */
export function maxRuntimeForClipCap(maxClips: number): number {
  for (let runtime = MAX_RUNTIME_SECONDS; runtime >= MIN_RUNTIME_SECONDS; runtime -= CLIP_STEP_SECONDS) {
    if (planSceneCount(runtime) <= maxClips) return runtime;
  }
  return MIN_RUNTIME_SECONDS;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
