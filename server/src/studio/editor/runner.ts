/** Runs ffmpeg and ffprobe, and implements the editing steps on top of the command builders. */
import { spawn } from 'node:child_process';
import { rename } from 'node:fs/promises';
import {
  buildAssembleArgs,
  buildPlaceholderClipArgs,
  buildPlaceholderPosterArgs,
  buildProbeArgs,
  parseFilterNames,
  parseProbeOutput,
  type AssembleClip,
  type MediaInfo,
  type TextStyle,
} from './commands.ts';

export class ProcessError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(command: string, exitCode: number | null, stderr: string) {
    const detail = stderr.trim().split('\n').slice(-6).join('\n');
    super(`${command} exited with code ${String(exitCode)}${detail ? `: ${detail}` : ''}`);
    this.name = 'ProcessError';
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export function runProcess(
  command: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-16_000);
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(
        error.code === 'ENOENT'
          ? new Error(`${command} was not found. Install ffmpeg or set FFMPEG_PATH and FFPROBE_PATH.`)
          : error,
      );
    });
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new ProcessError(command, code, stderr));
    });
  });
}

export interface AssembleRequest {
  clipPaths: readonly string[];
  runtimeSeconds: number;
  outputPath: string;
  endCardText: string;
}

/** The edit step as the pipeline sees it; tests can substitute a fake. */
export interface FilmEditor {
  /** Returns whether the end-card text could be drawn (needs the drawtext filter). */
  assemble(request: AssembleRequest, signal?: AbortSignal): Promise<{ textDrawn: boolean }>;
}

export interface PlaceholderRenderer {
  renderPlaceholderClip(request: {
    outputPath: string;
    durationSeconds: number;
    sceneNumber: number;
    title: string;
    width: number;
    height: number;
  }): Promise<void>;
  renderPlaceholderPoster(request: { outputPath: string; title: string; size: number }): Promise<void>;
}

export interface FfmpegOptions {
  ffmpegPath: string;
  ffprobePath: string;
  /** TrueType font used by drawtext (the bundled OFL font). */
  fontFile: string;
}

export class Ffmpeg implements FilmEditor, PlaceholderRenderer {
  readonly #options: FfmpegOptions;
  #drawtext: Promise<boolean> | undefined;

  constructor(options: FfmpegOptions) {
    this.#options = options;
  }

  /** First line of `ffmpeg -version`; also proves that ffmpeg and ffprobe can be started. */
  async version(): Promise<string> {
    const { stdout } = await runProcess(this.#options.ffmpegPath, ['-version']);
    await runProcess(this.#options.ffprobePath, ['-version']);
    return stdout.split('\n')[0]?.trim() ?? 'ffmpeg';
  }

  /** Whether this build has drawtext (it needs libfreetype, which some builds leave out). */
  hasDrawtext(): Promise<boolean> {
    this.#drawtext ??= runProcess(this.#options.ffmpegPath, ['-hide_banner', '-filters']).then(({ stdout }) =>
      parseFilterNames(stdout).has('drawtext'),
    );
    return this.#drawtext;
  }

  async probe(file: string, signal?: AbortSignal): Promise<MediaInfo> {
    const { stdout } = await runProcess(this.#options.ffprobePath, buildProbeArgs(file), signal);
    return parseProbeOutput(stdout);
  }

  async run(args: readonly string[], signal?: AbortSignal): Promise<void> {
    await runProcess(this.#options.ffmpegPath, args, signal);
  }

  async assemble(request: AssembleRequest, signal?: AbortSignal): Promise<{ textDrawn: boolean }> {
    const clips: AssembleClip[] = [];
    let width = 1920;
    let height = 1080;
    for (const [index, clipPath] of request.clipPaths.entries()) {
      const info = await this.probe(clipPath, signal);
      if (index === 0 && info.width && info.height) {
        width = info.width;
        height = info.height;
      }
      clips.push({ path: clipPath, durationSeconds: info.durationSeconds, hasAudio: info.hasAudio });
    }

    const textDrawn = await this.hasDrawtext();
    // ffmpeg picks the container from the extension, so the temporary file keeps `.mp4`.
    const partial = request.outputPath.replace(/\.mp4$/, '.partial.mp4');
    await this.run(
      buildAssembleArgs({
        clips,
        width,
        height,
        runtimeSeconds: request.runtimeSeconds,
        endCard: textDrawn ? { text: request.endCardText, style: this.#textStyle() } : null,
        outputPath: partial,
      }),
      signal,
    );
    await rename(partial, request.outputPath);
    return { textDrawn };
  }

  async renderPlaceholderClip(
    request: Parameters<PlaceholderRenderer['renderPlaceholderClip']>[0],
  ): Promise<void> {
    const text = (await this.hasDrawtext()) ? this.#textStyle() : null;
    await this.run(buildPlaceholderClipArgs({ ...request, text }));
  }

  async renderPlaceholderPoster(
    request: Parameters<PlaceholderRenderer['renderPlaceholderPoster']>[0],
  ): Promise<void> {
    const text = (await this.hasDrawtext()) ? this.#textStyle() : null;
    await this.run(buildPlaceholderPosterArgs({ ...request, text }));
  }

  #textStyle(): TextStyle {
    return { fontFile: this.#options.fontFile };
  }
}
