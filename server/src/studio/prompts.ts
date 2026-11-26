/**
 * Shot prompts for the video model.
 *
 * Consistency between scenes is text-only: every prompt repeats a style lock (one medium, one
 * look) and a character lock (the face, build and wardrobe of everyone on screen). There are
 * no reference images or seeds, so faces and look can still drift between clips.
 *
 * Prompts are assembled from sections and kept within SHOT_PROMPT_BUDGET characters. The
 * locks, the dialogue and the scene direction are always kept; when space runs out the
 * lower-priority context is dropped, least important first, instead of cutting the tail.
 */
import { truncate } from './text.ts';
import type { CharacterPlan, FilmBrief, ScenePlan, StoryPlan } from './types.ts';

export const SHOT_PROMPT_BUDGET = 5_000;
export const CLIP_RESOLUTION = '1080p';
export const CLIP_ASPECT_RATIO = '16:9';

export interface PromptSection {
  text: string;
  /** Omitted for sections that must always be kept; otherwise 1 = keep longest. */
  dropPriority?: number;
}

export function buildStyleLock(plan: StoryPlan): string {
  return [
    `Style lock: one ${truncate(plan.styleMedium, 80)} production from the first frame to the last.`,
    `Look: ${truncate(plan.visualStyle, 260)}.`,
    'Keep the same medium, finish, color pipeline, lens behavior, lighting and production design in every scene.',
    `Never: ${truncate(plan.styleNegative.join('; '), 220)}.`,
    'Never mix live action with animation, anime, illustration, comic-book art, toy-like CGI or game-cutscene styling.',
  ].join(' ');
}

export function buildCharacterLock(cast: readonly CharacterPlan[]): string {
  if (cast.length === 0) {
    return "Character lock: keep the established lead's face, build, hair and wardrobe unchanged.";
  }
  const entries = cast.map(
    (character) =>
      `${truncate(character.name, 40)} (${character.roleType}): ${truncate(character.visualSignature, 120)}; wardrobe: ${truncate(character.wardrobe, 100)}`,
  );
  return `Character lock (same face, build, hair and wardrobe as in every other scene): ${entries.join(' | ')}`;
}

export interface ShotPromptInput {
  plan: StoryPlan;
  scene: ScenePlan;
  brief: FilmBrief;
  clipSeconds: number;
}

export function buildShotPrompt({ plan, scene, brief, clipSeconds }: ShotPromptInput): string {
  const cast = scene.characterIds
    .map((id) => plan.characters.find((character) => character.characterId === id))
    .filter((character): character is CharacterPlan => character !== undefined);
  const dialogue = scene.dialogueLines.map((line) => truncate(line, 120)).join(' | ');
  const opening =
    scene.index === 0
      ? 'Begin with a cinematic establishing introduction that sets mood, place and tension before the main action.'
      : 'Continue seamlessly from the established film continuity.';

  return fitToBudget(
    [
      {
        text: `Scene ${String(scene.index + 1)} of ${String(plan.scenes.length)}. Generate exactly one ${String(clipSeconds)}-second cinematic film clip in ${CLIP_ASPECT_RATIO} at ${CLIP_RESOLUTION}.`,
      },
      {
        text: 'Quality lock: feature-film consistency, stable anatomy, clean edges, controlled contrast and coherent textures. No warped faces, smeared textures, unstable geometry or medium switching.',
      },
      { text: buildStyleLock(plan) },
      { text: buildCharacterLock(cast) },
      {
        text: `Continuity lock: ${truncate(plan.continuityRules.join('; ') || 'Preserve faces, wardrobe, props, geography and emotional continuity.', 320)}`,
        dropPriority: 3,
      },
      {
        text: `Film: ${truncate(brief.title, 120)}. Genres: ${truncate(brief.genres.join(', '), 120)}.`,
        dropPriority: 1,
      },
      { text: `Synopsis: ${truncate(plan.synopsis, 260)}`, dropPriority: 2 },
      { text: `Scene: ${truncate(scene.title, 120)}` },
      { text: `Objective: ${truncate(scene.sceneObjective, 150)}`, dropPriority: 4 },
      { text: `Purpose: ${truncate(scene.storyPurpose, 180)}`, dropPriority: 5 },
      { text: `Carried over: ${truncate(scene.carryOverFromPrevious, 140)}`, dropPriority: 2 },
      { text: `Conflict: ${truncate(scene.conflict, 140)}`, dropPriority: 3 },
      { text: `Turning point: ${truncate(scene.turningPoint, 140)}`, dropPriority: 4 },
      { text: `Leads into: ${truncate(scene.consequenceForNext, 140)}`, dropPriority: 3 },
      {
        text: `Location and time: ${truncate(scene.primaryLocation, 90)}; ${truncate(scene.timeMarker, 90)}`,
        dropPriority: 4,
      },
      {
        text: `Dialogue purpose: ${truncate(scene.dialoguePurpose, 140)}\nRequired spoken dialogue: ${dialogue}`,
      },
      { text: `Scene direction: ${truncate(scene.shotPrompt, 820)}` },
      { text: `Continuity anchor: ${truncate(scene.continuityAnchor, 140)}`, dropPriority: 5 },
      { text: opening },
      {
        text: [
          'Third-person cinematic framing only. No text overlays. No duplicate faces. Keep costumes and identities stable from start to finish.',
          'Characters clearly say the required lines in a natural way that fits the scene; prioritise intelligible speech over silent montage.',
          'Audio: natural ambience and grounded sound design that match the location and action.',
        ].join(' '),
      },
    ],
    SHOT_PROMPT_BUDGET,
  );
}

/**
 * Joins sections with newlines, dropping optional sections (highest `dropPriority` first,
 * later sections first on ties) until the result fits `budget`. Required sections are never
 * dropped; if they alone exceed the budget the result is truncated as a last resort.
 */
export function fitToBudget(sections: readonly PromptSection[], budget: number): string {
  const kept = [...sections];
  const join = (): string => kept.map((section) => section.text).join('\n');

  let prompt = join();
  while (prompt.length > budget) {
    let dropIndex = -1;
    kept.forEach((section, index) => {
      const priority = section.dropPriority;
      if (priority === undefined) return;
      const current = dropIndex === -1 ? undefined : kept[dropIndex]?.dropPriority;
      if (current === undefined || priority >= current) dropIndex = index;
    });
    if (dropIndex === -1) return truncate(prompt, budget);
    kept.splice(dropIndex, 1);
    prompt = join();
  }
  return prompt;
}
