/** The poster prompt: built only from the locked plan, so the poster shows the actual film. */
import { sceneCanon } from './director.ts';
import { truncate } from './text.ts';
import type { FilmBrief, LockedCanon, StoryPlan } from './types.ts';

export const POSTER_FILE = 'poster.png';

export function buildPosterPrompt(plan: StoryPlan, brief: FilmBrief, canon: LockedCanon): string {
  const heroes = plan.characters
    .filter((character) => character.roleType === 'main')
    .slice(0, 2)
    .map((character) => `${character.name}: ${character.visualSignature}; wardrobe: ${character.wardrobe}`)
    .join(' | ');

  return [
    'Create a polished film poster with no logos or watermarks.',
    'Format: square 1:1 composition that renders cleanly at 1024x1024.',
    'High-contrast composition, cinematic lighting, one or two dominant subjects.',
    'Only depict characters, wardrobe, locations, props and conflicts that appear in the story materials below.',
    'Do not add plot elements or generic genre imagery that the story does not contain.',
    `Title treatment: ${brief.title}`,
    `Description: ${canon.description}`,
    `Synopsis: ${truncate(plan.synopsis, 600)}`,
    `Genres: ${brief.genres.join(', ')}`,
    `Visual style: ${plan.visualStyle}`,
    `Hero characters: ${heroes || 'the central lead'}`,
    `Continuity rules: ${truncate(plan.continuityRules.join('; '), 700) || 'Keep the cast, wardrobe and geography exactly as planned.'}`,
    `Story bible: ${truncate(plan.storyBible, 1400)}`,
    `Scenes: ${sceneCanon(plan, 1600)}`,
    `Poster direction: ${canon.posterDirection}`,
    `Director's poster idea: ${truncate(plan.posterPrompt, 400)}`,
  ].join('\n');
}
