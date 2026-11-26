import { describe, expect, it } from 'vitest';
import {
  buildCanonPrompt,
  buildDirectorPrompt,
  fallbackCanon,
  lookDefaults,
  MAX_CHARACTERS_PER_SCENE,
  parseCanon,
  parseStoryPlan,
} from '../src/studio/director.ts';
import { parseModelJson } from '../src/studio/providers/gemini.ts';
import { ProviderError } from '../src/studio/providers/errors.ts';
import { makeBrief } from './helpers.ts';

describe('parseStoryPlan', () => {
  const brief = makeBrief({ minMainCharacters: 2, minSupportingCharacters: 1 });

  it('fills a completely empty answer with a usable plan', () => {
    const plan = parseStoryPlan({}, 3, brief);
    expect(plan.scenes).toHaveLength(3);
    expect(plan.synopsis).toBe(brief.premise);
    expect(plan.characters.filter((c) => c.roleType === 'main')).toHaveLength(2);
    expect(plan.characters.filter((c) => c.roleType === 'supporting')).toHaveLength(1);
    expect(plan.styleMedium).toBe(lookDefaults('realistic').styleMedium);
    expect(plan.styleNegative.length).toBeGreaterThan(0);
    expect(plan.scenes.map((scene) => scene.title)).toEqual(['Scene 1', 'Scene 2', 'Scene 3']);
    // First scene lighter, last scene heavier, by default.
    expect(plan.scenes.map((scene) => scene.durationWeight)).toEqual([2, 3, 4]);
    for (const scene of plan.scenes) {
      expect(scene.characterIds.length).toBeGreaterThan(0);
      expect(scene.dialogueLines.length).toBeGreaterThan(0);
    }
  });

  it('survives values of the wrong type', () => {
    const plan = parseStoryPlan(
      { synopsis: 42, characters: 'nobody', scenes: [null, 'x', { title: ['no'] }], styleNegative: [1, ' '] },
      3,
      brief,
    );
    expect(plan.synopsis).toBe(brief.premise);
    expect(plan.scenes[2]?.title).toBe('Scene 3');
    expect(plan.styleNegative).toEqual(lookDefaults('realistic').styleNegative);
  });

  it('keeps the director’s choices and normalises them', () => {
    const plan = parseStoryPlan(
      {
        synopsis: '  A keeper   decodes the storm.  ',
        characters: [
          { name: 'Mara Quinn', roleType: 'MAIN', characterId: 'Mara Quinn!', wardrobe: 'yellow oilskin' },
          { name: 'Theo Vance', roleType: 'main' },
          { name: 'Iris Calder', roleType: 'villain' },
          { name: '', roleType: 'main' },
        ],
        scenes: [
          {
            title: 'Cold Open',
            characterNames: ['Mara Quinn', 'theo vance', 'Nobody', 'iris-calder'],
            durationWeight: 9,
            dialogueLines: ['MARA: One.', 'THEO: Two.', 'MARA: Three.', 'THEO: Four.', 'MARA: Five.'],
          },
          { title: 'The Storm', characterIds: ['mara-quinn'], durationWeight: '1' },
        ],
      },
      2,
      brief,
    );

    expect(plan.synopsis).toBe('A keeper decodes the storm.');
    expect(plan.characters.map((c) => [c.characterId, c.roleType])).toEqual([
      ['mara-quinn', 'main'],
      ['theo-vance', 'main'],
      ['iris-calder', 'supporting'],
    ]);
    expect(plan.characters[0]?.wardrobe).toBe('yellow oilskin');

    const [first, second] = plan.scenes;
    expect(first?.characterIds).toEqual(['mara-quinn', 'theo-vance', 'iris-calder']);
    expect(first?.durationWeight).toBe(5);
    expect(first?.dialogueLines).toHaveLength(4);
    expect(second?.characterIds).toEqual(['mara-quinn']);
    expect(second?.durationWeight).toBe(1);
  });

  it('caps on-screen characters per scene', () => {
    const names = ['A One', 'B Two', 'C Three', 'D Four', 'E Five'];
    const plan = parseStoryPlan(
      {
        characters: names.map((name) => ({ name, roleType: 'main' })),
        scenes: [{ characterNames: names }],
      },
      1,
      brief,
    );
    expect(plan.scenes[0]?.characterIds).toHaveLength(MAX_CHARACTERS_PER_SCENE);
  });

  it('gives duplicate character ids a suffix', () => {
    const plan = parseStoryPlan(
      {
        characters: [
          { name: 'Kai', roleType: 'main' },
          { name: 'Kai', roleType: 'main' },
        ],
      },
      1,
      makeBrief({ minMainCharacters: 1, minSupportingCharacters: 0 }),
    );
    expect(plan.characters.map((c) => c.characterId)).toEqual(['kai', 'kai-2']);
  });

  it('pads and truncates the scene list to the planned count', () => {
    const scenes = Array.from({ length: 6 }, (_, index) => ({ title: `S${String(index + 1)}` }));
    expect(parseStoryPlan({ scenes }, 4, brief).scenes.map((s) => s.title)).toEqual(['S1', 'S2', 'S3', 'S4']);
    expect(parseStoryPlan({ scenes: scenes.slice(0, 1) }, 3, brief).scenes.map((s) => s.title)).toEqual([
      'S1',
      'Scene 2',
      'Scene 3',
    ]);
  });

  it('uses the animated defaults for the animated look', () => {
    const plan = parseStoryPlan({}, 1, makeBrief({ look: 'animated' }));
    expect(plan.styleMedium).toBe('stylized feature animation');
  });
});

describe('parseModelJson', () => {
  it('accepts bare JSON and JSON inside a Markdown fence', () => {
    expect(parseModelJson('{"a":1}', 'Plan')).toEqual({ a: 1 });
    expect(parseModelJson('```json\n{"a":1}\n```', 'Plan')).toEqual({ a: 1 });
  });

  it('turns invalid JSON into a non-retryable provider error', () => {
    expect(() => parseModelJson('not json', 'Plan')).toThrow(ProviderError);
  });
});

describe('locked second pass', () => {
  const brief = makeBrief();
  const plan = parseStoryPlan({ synopsis: 'Mara decodes the storm.' }, 2, brief);

  it('keeps model output within the length limits', () => {
    const canon = parseCanon(
      { description: 'x'.repeat(1000), posterDirection: 'y'.repeat(1000) },
      plan,
      brief,
    );
    expect(canon.description.length).toBeLessThanOrEqual(260);
    expect(canon.posterDirection.length).toBeLessThanOrEqual(420);
  });

  it('falls back to plan facts when the answer is unusable', () => {
    expect(parseCanon(null, plan, brief)).toEqual(fallbackCanon(plan, brief));
    expect(fallbackCanon(plan, brief).description).toBe('Mara decodes the storm.');
  });

  it('only gives the model facts from the plan', () => {
    const prompt = buildCanonPrompt(plan, brief);
    expect(prompt).toContain('Use only facts that are explicitly present');
    expect(prompt).toContain(plan.synopsis);
  });
});

describe('buildDirectorPrompt', () => {
  it('states the scene count, the clip limits and the chosen look', () => {
    const prompt = buildDirectorPrompt(makeBrief({ look: 'animated' }), 5);
    expect(prompt).toContain('exactly 5 scenes');
    expect(prompt).toContain('6 to 20 seconds');
    expect(prompt).toContain('stylized feature animation');
  });
});
