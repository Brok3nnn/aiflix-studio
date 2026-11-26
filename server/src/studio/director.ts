/**
 * The director: the story-bible prompt, validation of the model's JSON with sensible
 * defaults, and the locked second pass that keeps the synopsis and poster direction faithful
 * to the plan.
 */
import { MAX_CLIP_SECONDS, MIN_CLIP_SECONDS, normalizeDurationWeight } from '../../../shared/planner.ts';
import { asRecord, asString, asStringArray, slugify, truncate } from './text.ts';
import type {
  CastMember,
  CharacterPlan,
  FilmBrief,
  LockedCanon,
  Look,
  SceneSummary,
  ScenePlan,
  StoryPlan,
  StorySummary,
} from './types.ts';

/** Prompt-only consistency gets unreliable with crowds, so scenes are capped at three. */
export const MAX_CHARACTERS_PER_SCENE = 3;
const MAX_DIALOGUE_LINES = 4;
const MAX_DIALOGUE_LINE_LENGTH = 140;
const DESCRIPTION_MAX_LENGTH = 260;
const POSTER_DIRECTION_MAX_LENGTH = 420;

interface LookDefaults {
  styleMedium: string;
  visualStyle: string;
  styleNegative: string[];
}

export function lookDefaults(look: Look): LookDefaults {
  if (look === 'animated') {
    return {
      styleMedium: 'stylized feature animation',
      visualStyle:
        'single-medium premium animated feature look with consistent stylized character design, unified shading model, coherent texture simplification, stable color scripting, and one continuous animation pipeline across every scene',
      styleNegative: [
        'Do not switch to live-action photorealism',
        'Do not switch to gritty handheld realism',
        'Do not switch to painterly concept art',
        'Do not switch to comic-book panels or mixed-media looks',
      ],
    };
  }
  return {
    styleMedium: 'live-action photorealistic cinema',
    visualStyle:
      'single-medium premium live-action cinematic look with consistent lensing, grounded texture treatment, natural light behavior, stable production design, and one continuous photoreal pipeline across every scene',
    styleNegative: [
      'Do not switch to cartoon or anime styling',
      'Do not switch to painterly illustration or concept art',
      'Do not switch to toy-like CGI or game-cinematic rendering',
      'Do not switch to low-detail stylized 3D',
    ],
  };
}

export function buildDirectorPrompt(brief: FilmBrief, sceneCount: number): string {
  const look = lookDefaults(brief.look);
  return [
    'You are the director, showrunner, casting director and continuity supervisor of an AI short-film pipeline.',
    `Write a complete plan for a film told in exactly ${String(sceneCount)} scenes.`,
    `Each scene becomes one video clip of ${String(MIN_CLIP_SECONDS)} to ${String(MAX_CLIP_SECONDS)} seconds. Give heavier dramatic scenes a higher durationWeight so they receive longer clips, and lighter bridge scenes a lower one.`,
    'The user provides the premise and minimum cast counts. You design everything else.',
    'Scene 1 opens with an atmospheric establishing introduction (tone, world, place, tension) before the main action begins.',
    `Minimum main characters: ${String(brief.minMainCharacters)}.`,
    `Minimum supporting characters: ${String(brief.minSupportingCharacters)}.`,
    `Required visual medium: ${look.styleMedium} (the user chose a ${brief.look} look).`,
    'Add characters only when they materially improve the story. Keep the cast lean.',
    `Each scene may feature at most ${String(MAX_CHARACTERS_PER_SCENE)} named on-screen characters, because consistency relies on text prompts alone.`,
    'Write the cast first, then the story structure, then the scenes, as a tightly causal outline rather than loose summaries.',
    'Use third-person cinematic language only: no first-person, bodycam or selfie framing, and no prompt-engineering jargon.',
    'Every character needs a distinct visual identity and wardrobe that can stay stable across scenes.',
    'Return JSON only, with exactly this shape:',
    '{',
    '  "synopsis": string,',
    '  "premise": string,',
    '  "theme": string,',
    '  "castStrategy": string,',
    '  "storyBible": string,',
    '  "continuityRules": string[],',
    '  "relationshipMap": string[],',
    '  "locationBible": string[],',
    '  "masterTimeline": string[],',
    '  "styleMedium": string, // exactly one visual medium',
    '  "styleNegative": string[], // alternate looks that must never appear',
    '  "visualStyle": string,',
    '  "posterPrompt": string,',
    '  "characters": [{',
    '    "characterId": string, "name": string, "roleType": "main" | "supporting",',
    '    "storyRole": string, "ageDescriptor": string, "personality": string, "motivation": string,',
    '    "appearance": string, "wardrobe": string, "visualSignature": string',
    '  }],',
    '  "scenes": [{',
    '    "title": string, "beat": string, "sceneObjective": string, "storyPurpose": string,',
    '    "conflict": string, "turningPoint": string, "carryOverFromPrevious": string,',
    '    "consequenceForNext": string, "primaryLocation": string, "timeMarker": string,',
    '    "characterNames": string[], "dialoguePurpose": string,',
    '    "dialogueLines": string[], // 2 to 4 short lines, "NAME: line"',
    '    "durationWeight": integer, // 1 to 5; 5 means the scene deserves more runtime',
    '    "shotPrompt": string, "continuityAnchor": string',
    '  }]',
    '}',
    'Requirements:',
    '- meet or exceed the minimum main and supporting character counts; extra characters need an explicit dramatic function',
    '- characterNames lists the named characters actually visible in that scene',
    '- the whole film uses exactly one visual medium and finish; visualStyle describes one unified look, not a blend',
    '- styleNegative bans the most likely style drift for this project',
    '- each scene is caused by the previous one: state what it carries over and what consequence it creates for the next',
    '- dialogue is concise, plot-driving and specific; no filler, exposition dumps or catchphrases',
    `Title: ${brief.title}`,
    `Premise: ${brief.premise}`,
    `Genres: ${brief.genres.join(', ')}`,
    `Target runtime: ${String(brief.durationSeconds)} seconds`,
    `Scene count: ${String(sceneCount)}`,
  ].join('\n');
}

/**
 * Validates the director's JSON and fills every gap with a usable default, so a sloppy or
 * partial answer still yields a complete plan with exactly `sceneCount` scenes.
 */
export function parseStoryPlan(raw: unknown, sceneCount: number, brief: FilmBrief): StoryPlan {
  const payload = asRecord(raw);
  const look = lookDefaults(brief.look);

  const characters = ensureMinimumCast(parseCharacters(payload.characters), brief);
  const lookup = buildCharacterLookup(characters);
  const rawScenes = Array.isArray(payload.scenes) ? payload.scenes : [];
  const scenes = Array.from({ length: sceneCount }, (_, index) =>
    parseScene(rawScenes[index], index, sceneCount, brief, characters, lookup),
  );
  const styleNegative = asStringArray(payload.styleNegative);

  return {
    synopsis: asString(payload.synopsis, brief.premise),
    premise: asString(payload.premise, brief.premise),
    theme: asString(payload.theme, 'Identity, pressure and change under escalating stakes.'),
    castStrategy: asString(payload.castStrategy, 'A lean cast with only the characters the story needs.'),
    storyBible: asString(
      payload.storyBible,
      `Story world: ${brief.premise}. Keep continuity tight and character arcs visible.`,
    ),
    continuityRules: asStringArray(payload.continuityRules),
    relationshipMap: asStringArray(payload.relationshipMap),
    locationBible: asStringArray(payload.locationBible),
    masterTimeline: asStringArray(payload.masterTimeline),
    styleMedium: asString(payload.styleMedium, look.styleMedium),
    styleNegative: styleNegative.length > 0 ? styleNegative : look.styleNegative,
    visualStyle: asString(payload.visualStyle, look.visualStyle),
    posterPrompt: asString(payload.posterPrompt, `A cinematic film poster for: ${brief.premise}`),
    characters,
    scenes,
  };
}

function parseCharacters(value: unknown): CharacterPlan[] {
  const entries = Array.isArray(value) ? value : [];
  const usedIds = new Set<string>();
  const characters: CharacterPlan[] = [];

  entries.forEach((entry, index) => {
    const source = asRecord(entry);
    const name = asString(source.name);
    if (!name) return;
    const roleType = asString(source.roleType).toLowerCase() === 'main' ? 'main' : 'supporting';
    const appearance = asString(
      source.appearance,
      'distinct features, consistent proportions, readable silhouette',
    );
    const wardrobe = asString(source.wardrobe, 'signature wardrobe that fits the story world');
    characters.push({
      characterId: uniqueId(
        slugify(asString(source.characterId, name), `character-${String(index + 1)}`),
        usedIds,
      ),
      name,
      roleType,
      storyRole: asString(
        source.storyRole,
        roleType === 'main' ? 'Central dramatic lead' : 'Supporting dramatic role',
      ),
      ageDescriptor: asString(source.ageDescriptor, 'adult'),
      personality: asString(source.personality, 'emotionally readable and grounded'),
      motivation: asString(source.motivation, 'Drives or complicates the central conflict.'),
      appearance,
      wardrobe,
      visualSignature: asString(source.visualSignature, `${appearance}; ${wardrobe}`),
    });
  });

  return characters;
}

/** Tops the cast up with placeholder characters until the requested minimums are met. */
function ensureMinimumCast(characters: CharacterPlan[], brief: FilmBrief): CharacterPlan[] {
  const cast = [...characters];
  const usedIds = new Set(cast.map((character) => character.characterId));
  const count = (role: CharacterPlan['roleType']): number =>
    cast.filter((character) => character.roleType === role).length;

  for (const [role, minimum] of [
    ['main', brief.minMainCharacters],
    ['supporting', brief.minSupportingCharacters],
  ] as const) {
    while (count(role) < minimum) {
      const ordinal = count(role) + 1;
      const name = role === 'main' ? `Lead ${String(ordinal)}` : `Supporting ${String(ordinal)}`;
      cast.push({
        characterId: uniqueId(slugify(name, role), usedIds),
        name,
        roleType: role,
        storyRole: role === 'main' ? 'Central point-of-view character' : 'Supporting dramatic role',
        ageDescriptor: 'adult',
        personality: 'specific, reactive, emotionally readable',
        motivation: `Pursues or resists the central conflict of: ${truncate(brief.premise, 160)}`,
        appearance: 'distinctive face, consistent proportions, memorable silhouette',
        wardrobe: 'a signature outfit that stays consistent across scenes',
        visualSignature: 'strong silhouette, identifiable face, stable wardrobe accents',
      });
    }
  }
  return cast;
}

function buildCharacterLookup(characters: CharacterPlan[]): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const character of characters) {
    lookup.set(character.characterId, character.characterId);
    lookup.set(character.name.toLowerCase(), character.characterId);
    lookup.set(slugify(character.name, character.characterId), character.characterId);
  }
  return lookup;
}

function parseScene(
  value: unknown,
  index: number,
  sceneCount: number,
  brief: FilmBrief,
  characters: CharacterPlan[],
  lookup: Map<string, string>,
): ScenePlan {
  const source = asRecord(value);
  const isFirst = index === 0;
  const isLast = index === sceneCount - 1;
  const number = String(index + 1);

  const requested = [
    ...asStringArray(source.characterIds),
    ...asStringArray(source.characterNames),
    ...asStringArray(source.characters),
  ];
  const resolved = requested
    .map((entry) => lookup.get(entry.toLowerCase()) ?? lookup.get(slugify(entry, '')))
    .filter((entry): entry is string => entry !== undefined);
  const characterIds = [...new Set(resolved.length > 0 ? resolved : defaultSceneCast(characters, index))];

  return {
    index,
    title: asString(source.title, `Scene ${number}`),
    beat: asString(source.beat, `Story beat ${number}`),
    sceneObjective: asString(
      source.sceneObjective,
      'Advance the objective through a visible decision or confrontation.',
    ),
    storyPurpose: asString(source.storyPurpose, `Move the story forward in scene ${number}.`),
    conflict: asString(source.conflict, 'Escalate pressure through visible conflict.'),
    turningPoint: asString(source.turningPoint, 'End on a visible turn that drives the next scene.'),
    carryOverFromPrevious: asString(
      source.carryOverFromPrevious,
      isFirst
        ? 'Opening: establish the pressure that drives the film.'
        : 'Carry forward the unresolved consequence of the previous scene.',
    ),
    consequenceForNext: asString(
      source.consequenceForNext,
      isLast
        ? 'Resolve the central question or leave one clean final sting.'
        : 'Create a problem, decision or reveal the next scene must answer.',
    ),
    primaryLocation: asString(source.primaryLocation, 'The main story location.'),
    timeMarker: asString(
      source.timeMarker,
      isFirst ? 'The story begins.' : 'Moments after the previous scene.',
    ),
    characterIds: characterIds.slice(0, MAX_CHARACTERS_PER_SCENE),
    dialoguePurpose: asString(
      source.dialoguePurpose,
      'Short, plot-driving lines that reveal intent, stakes or a decision.',
    ),
    dialogueLines: parseDialogue(source.dialogueLines),
    durationWeight: normalizeDurationWeight(source.durationWeight, isFirst ? 2 : isLast ? 4 : 3),
    shotPrompt: asString(
      source.shotPrompt,
      `${brief.premise}. Scene ${number}. Keep every recurring character consistent.`,
    ),
    continuityAnchor: asString(
      source.continuityAnchor,
      'Preserve cast identity, wardrobe, props and location continuity.',
    ),
  };
}

function parseDialogue(value: unknown): string[] {
  const lines = asStringArray(value)
    .slice(0, MAX_DIALOGUE_LINES)
    .map((line) => truncate(line, MAX_DIALOGUE_LINE_LENGTH));
  return lines.length > 0 ? lines : ['LEAD: We are out of time.', 'PARTNER: Then choose now.'];
}

/** When the director names nobody, show the first lead, plus others on alternating scenes. */
function defaultSceneCast(characters: CharacterPlan[], index: number): string[] {
  const mains = characters.filter((character) => character.roleType === 'main');
  const supporting = characters.filter((character) => character.roleType === 'supporting');
  const chosen = [mains[0], index > 0 ? mains[1] : undefined, index % 2 === 1 ? supporting[0] : undefined]
    .filter((character): character is CharacterPlan => character !== undefined)
    .map((character) => character.characterId);
  if (chosen.length === 0 && characters[0]) chosen.push(characters[0].characterId);
  return chosen;
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  for (let suffix = 2; used.has(id); suffix += 1) id = `${base}-${String(suffix)}`;
  used.add(id);
  return id;
}

/* ── Locked second pass ─────────────────────────────────────────────────────────────── */

/**
 * Prompt for the second pass. The first pass invents freely; this one may only restate facts
 * that are already in the plan, so the synopsis and the poster cannot promise things the
 * film does not show.
 */
export function buildCanonPrompt(plan: StoryPlan, brief: FilmBrief): string {
  const cast = plan.characters
    .map(
      (character) =>
        `${character.name} (${character.roleType}) | role: ${character.storyRole} | look: ${character.visualSignature} | wardrobe: ${character.wardrobe}`,
    )
    .join('\n');
  return [
    'You are the continuity editor of a locked film plan.',
    'Use only facts that are explicitly present in the plan below.',
    'Do not invent characters, creatures, props, locations, costumes, twists, symbols, weather or genre cliches.',
    'Return JSON only, with exactly this shape: { "description": string, "posterDirection": string }',
    `- description: 1 or 2 sentences, at most ${String(DESCRIPTION_MAX_LENGTH)} characters, summarising the story viewers will actually see.`,
    `- posterDirection: one paragraph, at most ${String(POSTER_DIRECTION_MAX_LENGTH)} characters, describing a poster that only uses explicit story elements: the real main characters, their wardrobe, the true primary location and the central conflict.`,
    `Title: ${brief.title}`,
    `Genres: ${brief.genres.join(', ')}`,
    `Synopsis: ${plan.synopsis}`,
    `Premise: ${plan.premise}`,
    `Theme: ${plan.theme}`,
    `Visual style: ${plan.visualStyle}`,
    `Continuity rules: ${plan.continuityRules.join('; ') || 'Preserve cast identity, wardrobe, props and geography.'}`,
    `Story bible: ${truncate(plan.storyBible, 2200)}`,
    'Cast:',
    truncate(cast, 1800),
    'Scenes:',
    sceneCanon(plan),
  ].join('\n');
}

export function parseCanon(raw: unknown, plan: StoryPlan, brief: FilmBrief): LockedCanon {
  const payload = asRecord(raw);
  const fallback = fallbackCanon(plan, brief);
  return {
    description: truncate(asString(payload.description, fallback.description), DESCRIPTION_MAX_LENGTH),
    posterDirection: truncate(
      asString(payload.posterDirection, fallback.posterDirection),
      POSTER_DIRECTION_MAX_LENGTH,
    ),
  };
}

/** Deterministic canon used when the second pass fails: built only from plan facts. */
export function fallbackCanon(plan: StoryPlan, brief: FilmBrief): LockedCanon {
  const leads = plan.characters
    .filter((character) => character.roleType === 'main')
    .slice(0, 2)
    .map((character) => character.name)
    .join(' and ');
  const location = plan.scenes[0]?.primaryLocation ?? 'the main story location';
  return {
    description: truncate(plan.synopsis || brief.premise, DESCRIPTION_MAX_LENGTH),
    posterDirection: truncate(
      [
        `Story-faithful poster for "${brief.title}".`,
        leads ? `Focus on ${leads}.` : 'Focus on the central lead.',
        `Setting: ${location}.`,
        `Central conflict: ${plan.premise}.`,
        `Visual style: ${plan.visualStyle}.`,
      ].join(' '),
      POSTER_DIRECTION_MAX_LENGTH,
    ),
  };
}

/** Compact scene-by-scene summary used by the second pass and the poster prompt. */
export function sceneCanon(plan: StoryPlan, maxLength = 2200): string {
  return truncate(
    plan.scenes
      .map(
        (scene) =>
          `Scene ${String(scene.index + 1)}: ${scene.title}. Objective: ${scene.sceneObjective}. Conflict: ${scene.conflict}. Turn: ${scene.turningPoint}. Location/time: ${scene.primaryLocation}; ${scene.timeMarker}.`,
      )
      .join('\n'),
    maxLength,
  );
}

/* ── Persisted views of the plan ────────────────────────────────────────────────────── */

export function summarizeStory(plan: StoryPlan, canon: LockedCanon): StorySummary {
  return {
    synopsis: canon.description,
    theme: plan.theme,
    styleMedium: plan.styleMedium,
    visualStyle: plan.visualStyle,
    locations: plan.locationBible,
    continuityRules: plan.continuityRules,
    relationships: plan.relationshipMap,
    timeline: plan.masterTimeline,
  };
}

export function castFromPlan(plan: StoryPlan): CastMember[] {
  return plan.characters.map((character) => ({
    characterId: character.characterId,
    name: character.name,
    roleType: character.roleType,
    storyRole: character.storyRole,
    appearance: character.appearance,
    wardrobe: character.wardrobe,
    visualSignature: character.visualSignature,
  }));
}

export function sceneSummaries(plan: StoryPlan, durations: readonly number[]): SceneSummary[] {
  return plan.scenes.map((scene) => ({
    index: scene.index,
    title: scene.title,
    beat: scene.beat,
    location: scene.primaryLocation,
    timeMarker: scene.timeMarker,
    characterIds: scene.characterIds,
    durationSeconds: durations[scene.index] ?? 0,
  }));
}
