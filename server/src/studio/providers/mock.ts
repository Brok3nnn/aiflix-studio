/**
 * Offline providers for demos and tests (`STUDIO_PROVIDERS=mock`, the default).
 *
 * The director returns a deterministic story bible built from the brief, in the same JSON
 * shape the real model returns, so it goes through the same validation. Clips and the poster
 * are rendered locally with ffmpeg. Nothing touches the network and nothing costs money.
 */
import type { PlaceholderRenderer } from '../editor/runner.ts';
import { truncate } from '../text.ts';
import type {
  CanonRequest,
  ClipRequest,
  DirectorModel,
  PosterModel,
  PosterRequest,
  StoryPlanRequest,
  VideoModel,
} from './types.ts';

const NAMES = [
  'Mara Quinn',
  'Theo Vance',
  'Iris Calder',
  'Jonah Reyes',
  'Nadia Okoro',
  'Felix Hart',
  'Lena Park',
  'Owen Brandt',
  'Sofia Lind',
  'Ravi Mehta',
  'Clara Voss',
  'Tomas Ruiz',
  'Ada Moreau',
  'Hugo Stein',
  'June Akers',
  'Milo Grant',
  'Elsa Novak',
  'Kai Morgan',
];
const SCENE_TITLES = [
  'Cold Open',
  'The Offer',
  'First Crack',
  'Point of No Return',
  'Closing In',
  'The Reckoning',
  'Aftermath',
];
const WEIGHTS = [2, 3, 4, 3, 5, 3, 4];

export class MockDirector implements DirectorModel {
  writeStoryPlan({ brief, sceneCount }: StoryPlanRequest): Promise<unknown> {
    const mains = Array.from({ length: brief.minMainCharacters }, (_, index) => ({
      name: NAMES[index % NAMES.length],
      roleType: 'main',
      storyRole: index === 0 ? 'Protagonist' : 'Co-lead',
      appearance: index === 0 ? 'sharp-eyed, short dark hair' : 'tall, weathered, silver at the temples',
      wardrobe: index === 0 ? 'charcoal field jacket, red scarf' : 'long navy coat, leather satchel',
      visualSignature: index === 0 ? 'red scarf, scar over the left brow' : 'round glasses, silver ring',
    }));
    const supporting = Array.from({ length: brief.minSupportingCharacters }, (_, index) => ({
      name: NAMES[(brief.minMainCharacters + index) % NAMES.length],
      roleType: 'supporting',
      storyRole: index === 0 ? 'Rival' : 'Ally',
      appearance: 'distinct features, consistent proportions',
      wardrobe: 'muted work clothes',
      visualSignature: 'a recognisable silhouette',
    }));
    const cast = [...mains, ...supporting];
    const lead = mains[0]?.name ?? 'The lead';

    return Promise.resolve({
      synopsis: `${lead} is pulled into a story about ${truncate(brief.premise, 160)}`,
      premise: brief.premise,
      theme: 'What people risk for one another.',
      castStrategy: 'A lean cast: the leads plus the people who push them.',
      storyBible: `A mock story bible for "${brief.title}", generated offline without any model.`,
      continuityRules: ['Keep every wardrobe unchanged', 'Night turns to dawn across the film'],
      relationshipMap: cast.length > 1 ? [`${lead} and ${String(cast[1]?.name)} need each other`] : [],
      locationBible: ['A rain-soaked harbour town', 'A lighthouse above the bay'],
      masterTimeline: ['Setup', 'Escalation', 'Payoff'],
      styleMedium:
        brief.look === 'animated' ? 'stylized feature animation' : 'live-action photorealistic cinema',
      visualStyle: 'teal shadows, warm practical lights, slow camera moves',
      posterPrompt: `${lead} at the edge of the harbour at dawn`,
      characters: cast,
      scenes: Array.from({ length: sceneCount }, (_, index) => ({
        title:
          index < SCENE_TITLES.length
            ? SCENE_TITLES[index]
            : `${String(SCENE_TITLES[index % SCENE_TITLES.length])} ${String(Math.floor(index / SCENE_TITLES.length) + 1)}`,
        beat: `Beat ${String(index + 1)}`,
        primaryLocation: index % 2 === 0 ? 'The harbour' : 'The lighthouse',
        timeMarker: index === 0 ? 'Night' : 'Later that night',
        characterNames: cast.slice(0, 2).map((character) => character.name),
        dialogueLines: [`${lead.toUpperCase()}: We finish this tonight.`],
        durationWeight: index === sceneCount - 1 ? 4 : WEIGHTS[index % WEIGHTS.length],
        shotPrompt: `Scene ${String(index + 1)} of "${brief.title}".`,
      })),
    });
  }

  lockCanon({ plan }: CanonRequest): Promise<unknown> {
    return Promise.resolve({
      description: truncate(plan.synopsis, 240),
      posterDirection: `${plan.characters[0]?.name ?? 'The lead'} in ${plan.locationBible[0] ?? 'the main location'}.`,
    });
  }
}

export interface MockVideoOptions {
  width?: number;
  height?: number;
}

export class MockVideo implements VideoModel {
  readonly label = 'mock clips (local ffmpeg)';
  readonly #renderer: PlaceholderRenderer;
  readonly #width: number;
  readonly #height: number;

  constructor(renderer: PlaceholderRenderer, options: MockVideoOptions = {}) {
    this.#renderer = renderer;
    this.#width = options.width ?? 1280;
    this.#height = options.height ?? 720;
  }

  renderClip(request: ClipRequest): Promise<void> {
    return this.#renderer.renderPlaceholderClip({
      outputPath: request.outputPath,
      durationSeconds: request.durationSeconds,
      sceneNumber: request.scene.index + 1,
      title: request.scene.title,
      width: this.#width,
      height: this.#height,
    });
  }
}

export class MockPoster implements PosterModel {
  readonly #renderer: PlaceholderRenderer;

  constructor(renderer: PlaceholderRenderer) {
    this.#renderer = renderer;
  }

  renderPoster(request: PosterRequest): Promise<void> {
    return this.#renderer.renderPlaceholderPoster({
      outputPath: request.outputPath,
      title: request.title,
      size: 1024,
    });
  }
}
