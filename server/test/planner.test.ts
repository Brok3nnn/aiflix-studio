import { describe, expect, it } from 'vitest';
import {
  allocateSceneDurations,
  assertValidRuntime,
  MAX_CLIP_SECONDS,
  MAX_RUNTIME_SECONDS,
  maxRuntimeForClipCap,
  MIN_CLIP_SECONDS,
  MIN_RUNTIME_SECONDS,
  normalizeDurationWeight,
  planSceneCount,
  previewSceneDurations,
  sceneCountRange,
} from '../../shared/planner.ts';

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

function allRuntimes(): number[] {
  const runtimes: number[] = [];
  for (let runtime = MIN_RUNTIME_SECONDS; runtime <= MAX_RUNTIME_SECONDS; runtime += 2) {
    runtimes.push(runtime);
  }
  return runtimes;
}

describe('planSceneCount', () => {
  it('is round(runtime / 14), clamped to what 6-20 second clips can fill', () => {
    expect(planSceneCount(8)).toBe(1);
    expect(planSceneCount(20)).toBe(1);
    expect(planSceneCount(22)).toBe(2);
    expect(planSceneCount(64)).toBe(5);
    expect(planSceneCount(140)).toBe(10);
    expect(planSceneCount(480)).toBe(34);
  });

  it('never needs a clip shorter than 6 or longer than 20 seconds', () => {
    for (const runtime of allRuntimes()) {
      const count = planSceneCount(runtime);
      expect(count * MIN_CLIP_SECONDS).toBeLessThanOrEqual(runtime);
      expect(count * MAX_CLIP_SECONDS).toBeGreaterThanOrEqual(runtime);
    }
  });

  it('rejects odd, fractional and out-of-range runtimes', () => {
    for (const runtime of [7, 9, 63, 6, 482, 10.5, Number.NaN]) {
      expect(() => planSceneCount(runtime)).toThrow(RangeError);
    }
  });
});

describe('allocateSceneDurations', () => {
  it('hits every valid runtime exactly with valid clip lengths', () => {
    for (const runtime of allRuntimes()) {
      const durations = previewSceneDurations(runtime);
      expect(sum(durations)).toBe(runtime);
      for (const seconds of durations) {
        expect(seconds % 2).toBe(0);
        expect(seconds).toBeGreaterThanOrEqual(MIN_CLIP_SECONDS);
        expect(seconds).toBeLessThanOrEqual(MAX_CLIP_SECONDS);
      }
    }
  });

  it('stays exact and bounded for any mix of weights', () => {
    const weightSets = [[1], [5], [1, 5], [5, 1, 1, 1, 5], [3, 3, 3, 3, 3], [2, 4, 1, 5, 3, 2, 4]];
    for (const runtime of allRuntimes()) {
      const { min, max } = sceneCountRange(runtime);
      for (const base of weightSets) {
        for (const count of [min, planSceneCount(runtime), max]) {
          const weights = Array.from({ length: count }, (_, index) => base[index % base.length]);
          const durations = allocateSceneDurations(runtime, weights);
          expect(sum(durations)).toBe(runtime);
          expect(Math.min(...durations)).toBeGreaterThanOrEqual(MIN_CLIP_SECONDS);
          expect(Math.max(...durations)).toBeLessThanOrEqual(MAX_CLIP_SECONDS);
        }
      }
    }
  });

  it('starts every scene at 6 seconds and shares the rest out by weight', () => {
    // 64s over 5 scenes: 30s of 6s minimums, 34s (17 units of 2s) shared out.
    expect(allocateSceneDurations(64, [2, 3, 4, 3, 5])).toEqual([10, 12, 14, 12, 16]);
    expect(allocateSceneDurations(64, [3, 3, 3, 3, 3])).toEqual([14, 14, 12, 12, 12]);
  });

  it('gives a heavier scene at least as much time as a lighter one', () => {
    const durations = allocateSceneDurations(100, [1, 5, 1, 5, 1, 5, 1]);
    for (let index = 0; index < durations.length - 1; index += 2) {
      expect(durations[index + 1]).toBeGreaterThanOrEqual(durations[index] ?? 0);
    }
  });

  it('caps scenes at 20 seconds even when one weight dominates', () => {
    expect(allocateSceneDurations(60, [5, 1, 1])).toEqual([20, 20, 20]);
    expect(allocateSceneDurations(46, [5, 1, 1])).toEqual([20, 14, 12]);
  });

  it('handles the shortest and longest runtimes', () => {
    expect(allocateSceneDurations(8, [3])).toEqual([8]);
    expect(allocateSceneDurations(20, [1])).toEqual([20]);
    const longest = previewSceneDurations(480);
    expect(longest).toHaveLength(34);
    expect(sum(longest)).toBe(480);
  });

  it('treats missing or invalid weights as the default weight', () => {
    expect(allocateSceneDurations(30, ['heavy', null])).toEqual(allocateSceneDurations(30, [3, 3]));
  });

  it('rejects a scene count that cannot fill the runtime', () => {
    expect(() => allocateSceneDurations(64, [3, 3])).toThrow(/needs 4 to 10 scenes/);
    expect(() => allocateSceneDurations(64, new Array<number>(11).fill(3))).toThrow(RangeError);
    expect(() => allocateSceneDurations(64, [])).toThrow(RangeError);
  });
});

describe('normalizeDurationWeight', () => {
  it('rounds and clamps to 1-5', () => {
    expect(normalizeDurationWeight(0)).toBe(1);
    expect(normalizeDurationWeight(2.6)).toBe(3);
    expect(normalizeDurationWeight('4')).toBe(4);
    expect(normalizeDurationWeight(99)).toBe(5);
    expect(normalizeDurationWeight(undefined)).toBe(3);
    expect(normalizeDurationWeight('x', 2)).toBe(2);
  });
});

describe('maxRuntimeForClipCap', () => {
  it('returns the longest runtime whose plan fits the cap', () => {
    expect(maxRuntimeForClipCap(12)).toBe(174);
    expect(planSceneCount(174)).toBe(12);
    expect(planSceneCount(176)).toBe(13);
    expect(maxRuntimeForClipCap(34)).toBe(480);
    expect(maxRuntimeForClipCap(1)).toBe(20);
  });
});

describe('assertValidRuntime', () => {
  it('names the accepted range in its message', () => {
    expect(() => {
      assertValidRuntime(9);
    }).toThrow('Runtime must be an even number of seconds from 8 to 480; got 9.');
  });
});
