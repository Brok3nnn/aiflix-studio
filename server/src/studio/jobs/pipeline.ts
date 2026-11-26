/**
 * One film, start to finish: director plan, locked second pass, one clip per scene, the edit
 * and the poster. Progress is written to the repository as the job runs. On failure the
 * pipeline throws; the runner records the failure (see runner.ts).
 */
import { access, mkdir, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { allocateSceneDurations, planSceneCount } from '../../../../shared/planner.ts';
import type { Logger } from '../../logger.ts';
import type { FilmRepository } from '../../store/repository.ts';
import {
  buildCanonPrompt,
  buildDirectorPrompt,
  castFromPlan,
  fallbackCanon,
  parseCanon,
  parseStoryPlan,
  sceneSummaries,
  summarizeStory,
} from '../director.ts';
import type { FilmEditor } from '../editor/runner.ts';
import { buildPosterPrompt, POSTER_FILE } from '../poster.ts';
import { buildShotPrompt } from '../prompts.ts';
import { errorMessage } from '../providers/errors.ts';
import type { CallContext, StudioProviders } from '../providers/types.ts';
import type { ClipRecord, FilmBrief, FilmRecord, LockedCanon } from '../types.ts';
import { clipFile, FILM_FILE, filmDir, partialClipFile } from './media.ts';
import { JobReporter } from './progress.ts';
import { loadSnapshot, saveSnapshot, type PlanSnapshot } from './snapshot.ts';

export interface PipelineDeps {
  repo: FilmRepository;
  providers: StudioProviders;
  editor: FilmEditor;
  generatedDir: string;
  endCardText: string;
  logger: Logger;
  signal?: AbortSignal;
}

/** A scene's clip could not be rendered. Carries the scene so the UI can name it. */
export class SceneRenderError extends Error {
  readonly sceneIndex: number;
  readonly sceneTitle: string;

  constructor(sceneIndex: number, sceneCount: number, sceneTitle: string, cause: unknown) {
    super(
      `Scene ${String(sceneIndex + 1)} of ${String(sceneCount)} ("${sceneTitle}") failed: ${errorMessage(cause)}`,
      { cause },
    );
    this.name = 'SceneRenderError';
    this.sceneIndex = sceneIndex;
    this.sceneTitle = sceneTitle;
  }
}

// Progress milestones, in percent.
const PLAN_DONE = 20;
const CANON_DONE = 30;
const CLIPS_DONE = 85;
const EDIT_DONE = 92;

export async function runFilmPipeline(film: FilmRecord, deps: PipelineDeps): Promise<void> {
  const { brief } = film;
  const dir = filmDir(deps.generatedDir, film.id);
  await mkdir(dir, { recursive: true });

  const report = new JobReporter(deps.repo, film.id, deps.logger);
  const context: CallContext = { notify: (message) => report.warn(message), signal: deps.signal };

  // 1. The story plan: reuse the saved one when resuming, otherwise ask the director.
  let snapshot = await loadSnapshot(dir, brief);
  if (snapshot) {
    await report.stage(CANON_DONE, 'Resuming with the saved story plan.');
  } else {
    // Media left over from a plan that can no longer be loaded belongs to a different story.
    await removeRenderedMedia(dir);
    snapshot = await planFilm(brief, deps, report, context);
    await saveSnapshot(dir, snapshot);
  }
  const { plan, sceneDurations, canon } = snapshot;
  await report.save({
    story: summarizeStory(plan, canon),
    cast: castFromPlan(plan),
    scenes: sceneSummaries(plan, sceneDurations),
  });

  // 2. One clip per scene. Clips already on disk are complete (they are renamed into place
  //    only after rendering finishes), so a resumed job continues from the first gap.
  const clips = await completedClips(dir, sceneDurations);
  await report.save(
    { clips },
    clips.length > 0 ? `Reusing ${String(clips.length)} clip(s) that were already rendered.` : undefined,
  );
  const sceneCount = plan.scenes.length;
  for (const scene of plan.scenes.slice(clips.length)) {
    const seconds = sceneDurations[scene.index] ?? 0;
    const progress = CANON_DONE + ((CLIPS_DONE - CANON_DONE) * scene.index) / sceneCount;
    await report.stage(
      progress,
      `Rendering scene ${String(scene.index + 1)} of ${String(sceneCount)}: ${scene.title} (${String(seconds)}s)`,
    );

    const partialPath = path.join(dir, partialClipFile(scene.index));
    try {
      await deps.providers.video.renderClip(
        {
          prompt: buildShotPrompt({ plan, scene, brief, clipSeconds: seconds }),
          durationSeconds: seconds,
          outputPath: partialPath,
          scene: { index: scene.index, title: scene.title },
        },
        context,
      );
    } catch (error) {
      throw new SceneRenderError(scene.index, sceneCount, scene.title, error);
    }
    await rename(partialPath, path.join(dir, clipFile(scene.index)));
    clips.push({ sceneIndex: scene.index, file: clipFile(scene.index), durationSeconds: seconds });
    await report.save({ clips: [...clips] });
  }

  // 3. The edit: concatenate, trim to the exact runtime, add the end card.
  await report.stage(
    CLIPS_DONE,
    `Editing: joining ${String(clips.length)} clips, trimming to ${String(brief.durationSeconds)}s and adding the end card.`,
  );
  const { textDrawn } = await deps.editor.assemble(
    {
      clipPaths: clips.map((clip) => path.join(dir, clip.file)),
      runtimeSeconds: brief.durationSeconds,
      outputPath: path.join(dir, FILM_FILE),
      endCardText: deps.endCardText,
    },
    deps.signal,
  );
  if (!textDrawn) {
    await report.warn('This ffmpeg build has no drawtext filter, so the end card has no text.');
  }
  await report.save({ videoFile: FILM_FILE });

  // 4. The poster. A failed poster does not fail the film.
  await report.stage(EDIT_DONE, 'Generating the poster.');
  let posterFile: string | null = POSTER_FILE;
  try {
    await deps.providers.poster.renderPoster(
      {
        prompt: buildPosterPrompt(plan, brief, canon),
        outputPath: path.join(dir, POSTER_FILE),
        title: brief.title,
      },
      context,
    );
  } catch (error) {
    if (deps.signal?.aborted) throw error;
    posterFile = null;
    await report.warn(`Poster generation failed (${errorMessage(error)}); the film is ready without one.`);
  }

  await report.save(
    { status: 'ready', progress: 100, statusText: 'Ready.', posterFile, failure: null },
    'Film ready.',
  );
}

async function planFilm(
  brief: FilmBrief,
  deps: PipelineDeps,
  report: JobReporter,
  context: CallContext,
): Promise<PlanSnapshot> {
  const sceneCount = planSceneCount(brief.durationSeconds);
  await report.stage(
    5,
    'The director is writing the story bible.',
    `Planning ${String(sceneCount)} scenes for a ${String(brief.durationSeconds)}s film.`,
  );
  const raw = await deps.providers.director.writeStoryPlan(
    { prompt: buildDirectorPrompt(brief, sceneCount), brief, sceneCount },
    context,
  );
  const plan = parseStoryPlan(raw, sceneCount, brief);
  const sceneDurations = allocateSceneDurations(
    brief.durationSeconds,
    plan.scenes.map((scene) => scene.durationWeight),
  );
  await report.stage(
    PLAN_DONE,
    'Locking the synopsis and poster direction to the plan.',
    `Story bible ready: ${String(plan.characters.length)} characters; scenes of ${sceneDurations.join(' + ')} = ${String(brief.durationSeconds)}s.`,
  );

  let canon: LockedCanon;
  try {
    const rawCanon = await deps.providers.director.lockCanon(
      { prompt: buildCanonPrompt(plan, brief), brief, plan },
      context,
    );
    canon = parseCanon(rawCanon, plan, brief);
  } catch (error) {
    if (deps.signal?.aborted) throw error;
    canon = fallbackCanon(plan, brief);
    await report.warn(
      `The story lock pass failed (${errorMessage(error)}); using a synopsis built from the plan.`,
    );
  }
  return { plan, sceneDurations, canon };
}

async function removeRenderedMedia(dir: string): Promise<void> {
  const files = await readdir(dir);
  const rendered = files.filter(
    (file) => /^clip-\d+(\.partial)?\.mp4$/.test(file) || file === FILM_FILE || file === POSTER_FILE,
  );
  await Promise.all(rendered.map((file) => rm(path.join(dir, file), { force: true })));
}

/** The leading run of clips that already exist on disk, in scene order. */
async function completedClips(dir: string, sceneDurations: readonly number[]): Promise<ClipRecord[]> {
  const clips: ClipRecord[] = [];
  for (const [sceneIndex, durationSeconds] of sceneDurations.entries()) {
    try {
      await access(path.join(dir, clipFile(sceneIndex)));
    } catch {
      break;
    }
    clips.push({ sceneIndex, file: clipFile(sceneIndex), durationSeconds });
  }
  return clips;
}
