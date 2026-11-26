import { describe, expect, it } from 'vitest';
import { parseStoryPlan } from '../src/studio/director.ts';
import {
  buildCharacterLock,
  buildShotPrompt,
  buildStyleLock,
  fitToBudget,
  SHOT_PROMPT_BUDGET,
} from '../src/studio/prompts.ts';
import type { StoryPlan } from '../src/studio/types.ts';
import { makeBrief } from './helpers.ts';

const long = (label: string, length = 5_000): string => `${label} `.repeat(length).slice(0, length);

/** A plan where every free-text field is far longer than any section allows. */
function oversizedPlan(): StoryPlan {
  const brief = makeBrief();
  const characters = ['Mara Quinn', 'Theo Vance', 'Iris Calder'].map((name) => ({
    name,
    roleType: 'main',
    visualSignature: long('signature'),
    wardrobe: long('wardrobe'),
  }));
  const scene = Object.fromEntries(
    [
      'title',
      'beat',
      'sceneObjective',
      'storyPurpose',
      'conflict',
      'turningPoint',
      'carryOverFromPrevious',
      'consequenceForNext',
      'primaryLocation',
      'timeMarker',
      'dialoguePurpose',
      'shotPrompt',
      'continuityAnchor',
    ].map((field) => [field, long(field)]),
  );
  return parseStoryPlan(
    {
      synopsis: long('synopsis'),
      styleMedium: long('medium'),
      visualStyle: long('visual'),
      styleNegative: [long('negative')],
      continuityRules: [long('rule')],
      characters,
      scenes: [
        {
          ...scene,
          characterNames: characters.map((c) => c.name),
          dialogueLines: [long('a'), long('b'), long('c'), long('d')],
        },
      ],
    },
    1,
    brief,
  );
}

describe('buildShotPrompt', () => {
  it('stays within the 5,000-character budget for oversized plans', () => {
    const plan = oversizedPlan();
    const scene = plan.scenes[0];
    if (!scene) throw new Error('missing scene');
    const prompt = buildShotPrompt({
      plan,
      scene,
      brief: makeBrief({ title: long('title') }),
      clipSeconds: 14,
    });
    expect(prompt.length).toBeLessThanOrEqual(SHOT_PROMPT_BUDGET);
  });

  it('always keeps the style lock, the character lock, the dialogue and the direction', () => {
    const plan = oversizedPlan();
    const scene = plan.scenes[0];
    if (!scene) throw new Error('missing scene');
    const prompt = buildShotPrompt({ plan, scene, brief: makeBrief(), clipSeconds: 14 });
    expect(prompt).toContain(buildStyleLock(plan));
    expect(prompt).toContain('Character lock');
    expect(prompt).toContain('Mara Quinn (main)');
    expect(prompt).toContain('Iris Calder (main)');
    expect(prompt).toContain('Required spoken dialogue:');
    expect(prompt).toContain('Scene direction:');
    expect(prompt).toContain('Audio: natural ambience');
    // Low-priority context was dropped to make room.
    expect(prompt).not.toContain('Continuity anchor:');
  });

  it('keeps everything when the plan is small', () => {
    const brief = makeBrief();
    const plan = parseStoryPlan({ characters: [{ name: 'Mara', roleType: 'main' }] }, 2, brief);
    const scene = plan.scenes[1];
    if (!scene) throw new Error('missing scene');
    const prompt = buildShotPrompt({ plan, scene, brief, clipSeconds: 10 });
    expect(prompt).toMatch(/^Scene 2 of 2\. Generate exactly one 10-second cinematic film clip/);
    expect(prompt).toContain('Continuity anchor:');
    expect(prompt).toContain(`Film: ${brief.title}.`);
    expect(prompt).toContain('Continue seamlessly');
  });

  it('opens the first scene with an establishing introduction', () => {
    const brief = makeBrief();
    const plan = parseStoryPlan({}, 2, brief);
    const scene = plan.scenes[0];
    if (!scene) throw new Error('missing scene');
    expect(buildShotPrompt({ plan, scene, brief, clipSeconds: 8 })).toContain('establishing introduction');
  });
});

describe('locks', () => {
  it('describes everyone on screen in the character lock', () => {
    const plan = parseStoryPlan(
      { characters: [{ name: 'Mara', roleType: 'main', visualSignature: 'red scarf', wardrobe: 'oilskin' }] },
      1,
      makeBrief({ minSupportingCharacters: 0, minMainCharacters: 1 }),
    );
    expect(buildCharacterLock(plan.characters)).toContain('Mara (main): red scarf; wardrobe: oilskin');
    expect(buildCharacterLock([])).toContain("keep the established lead's face");
  });

  it('bans the configured style drift', () => {
    const plan = parseStoryPlan({ styleNegative: ['No anime'] }, 1, makeBrief());
    expect(buildStyleLock(plan)).toContain('Never: No anime.');
  });
});

describe('fitToBudget', () => {
  it('drops the highest drop-priority sections first, later ones first on ties', () => {
    const sections = [
      { text: 'required-1' },
      { text: 'optional-a', dropPriority: 1 },
      { text: 'optional-b', dropPriority: 2 },
      { text: 'optional-c', dropPriority: 2 },
      { text: 'required-2' },
    ];
    const full = sections.map((section) => section.text).join('\n');
    expect(fitToBudget(sections, full.length)).toBe(full);
    expect(fitToBudget(sections, full.length - 1)).toBe('required-1\noptional-a\noptional-b\nrequired-2');
    expect(fitToBudget(sections, 33)).toBe('required-1\noptional-a\nrequired-2');
    expect(fitToBudget(sections, 21)).toBe('required-1\nrequired-2');
  });

  it('truncates as a last resort when required sections alone are too long', () => {
    const result = fitToBudget([{ text: 'x'.repeat(50) }], 20);
    expect(result).toHaveLength(20);
    expect(result.endsWith('...')).toBe(true);
  });
});
