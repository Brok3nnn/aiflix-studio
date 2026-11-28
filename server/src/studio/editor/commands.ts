/**
 * ffmpeg command builders. Pure functions: they turn a description of an edit into an
 * argument list, so they can be unit-tested without running ffmpeg.
 */
import { asRecord } from '../text.ts';

export const OUTPUT_FPS = 25;
export const AUDIO_SAMPLE_RATE = 48_000;
/** The end card covers the last seconds of the film, so the runtime stays exact. */
export const MAX_END_CARD_SECONDS = 5;

const BASE_ARGS = ['-y', '-hide_banner', '-nostdin', '-nostats', '-loglevel', 'error'];
const STEREO = `aformat=sample_fmts=fltp:sample_rates=${String(AUDIO_SAMPLE_RATE)}:channel_layouts=stereo`;
const PLACEHOLDER_COLORS = ['0x1d3557', '0x5b2a86', '0x1f6f5c', '0x7a3e1d', '0x3d405b', '0x6b2737'];

export interface MediaInfo {
  durationSeconds: number;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
}

/** Text to draw with the bundled font. Only used when ffmpeg has the drawtext filter. */
export interface TextStyle {
  fontFile: string;
}

/**
 * Escapes a value for a filtergraph option, applying both escaping levels described in
 * ffmpeg-filters(1), "Notes on filtergraph escaping": first the option value (\ ' :),
 * then the filtergraph description (\ ' [ ] , ;). Arguments are passed to ffmpeg without
 * a shell, so no third level is needed.
 */
export function escapeFilterValue(value: string): string {
  const optionLevel = value.replace(/[\\':]/g, '\\$&');
  return optionLevel.replace(/[\\'[\],;]/g, '\\$&');
}

/** Reads the filter names out of `ffmpeg -filters`. */
export function parseFilterNames(listing: string): Set<string> {
  const names = new Set<string>();
  for (const line of listing.split('\n')) {
    const [flags, name, io] = line.trim().split(/\s+/);
    if (flags && name && io?.includes('->')) names.add(name);
  }
  return names;
}

export function buildProbeArgs(file: string): string[] {
  return [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_entries',
    'format=duration:stream=codec_type,width,height',
    file,
  ];
}

export function parseProbeOutput(stdout: string): MediaInfo {
  const data = asRecord(JSON.parse(stdout) as unknown);
  const duration = Number.parseFloat(String(asRecord(data.format).duration));
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('ffprobe reported no duration.');
  }
  const streams = Array.isArray(data.streams) ? data.streams.map(asRecord) : [];
  const video = streams.find((stream) => stream.codec_type === 'video');
  const dimension = (value: unknown): number | null =>
    typeof value === 'number' && value > 0 ? value : null;
  return {
    durationSeconds: duration,
    width: dimension(video?.width),
    height: dimension(video?.height),
    hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
  };
}

export function endCardTiming(runtimeSeconds: number): { startSeconds: number; durationSeconds: number } {
  const durationSeconds = Math.min(MAX_END_CARD_SECONDS, runtimeSeconds / 4);
  return { startSeconds: runtimeSeconds - durationSeconds, durationSeconds };
}

/** Largest font size (px) at which `text` fits on one line, capped at `heightRatio` of the frame. */
export function fitFontSize(text: string, width: number, height: number, heightRatio: number): number {
  const byHeight = height * heightRatio;
  // Roughly 0.55em per glyph for a serif display face; 86% of the width leaves a margin.
  const byWidth = (width * 0.86) / Math.max(1, text.length * 0.55);
  return Math.max(10, Math.floor(Math.min(byHeight, byWidth)));
}

/** Removes control characters and caps the length of text that will be drawn on video. */
export function cleanDrawText(text: string, maxLength = 80): string {
  const clean = Array.from(text.replace(/\s+/g, ' ').trim())
    .filter((char) => char >= ' ' && char !== '\u007f')
    .join('');
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 3)}...` : clean;
}

interface DrawTextOptions {
  text: string;
  style: TextStyle;
  fontSize: number;
  y: string;
  color?: string;
  alpha?: string;
  enable?: string;
}

export function drawTextFilter(options: DrawTextOptions): string {
  const parts = [
    `fontfile=${escapeFilterValue(options.style.fontFile)}`,
    `text=${escapeFilterValue(cleanDrawText(options.text))}`,
    // Draw the text literally: no %{...} expansion of user-supplied strings.
    'expansion=none',
    `fontsize=${String(options.fontSize)}`,
    `fontcolor=${options.color ?? 'white'}`,
    'shadowcolor=black@0.6',
    'shadowx=2',
    'shadowy=2',
    'x=(w-text_w)/2',
    `y=${escapeFilterValue(options.y)}`,
  ];
  if (options.alpha) parts.push(`alpha=${escapeFilterValue(options.alpha)}`);
  if (options.enable) parts.push(`enable=${escapeFilterValue(options.enable)}`);
  return `drawtext=${parts.join(':')}`;
}

export interface AssembleClip {
  path: string;
  durationSeconds: number;
  hasAudio: boolean;
}

export interface AssembleInput {
  clips: readonly AssembleClip[];
  width: number;
  height: number;
  runtimeSeconds: number;
  /** End-card text, or null to render the end card (fade to black) without text. */
  endCard: { text: string; style: TextStyle } | null;
  outputPath: string;
}

/**
 * One ffmpeg pass that edits the film:
 * - normalises every clip to the same size, frame rate and audio format;
 * - concatenates them in scene order (clips without audio get silence);
 * - re-times the joined video to a constant frame rate;
 * - pads or trims video and audio to exactly `runtimeSeconds`;
 * - fades picture and sound out over the last seconds and draws the end-card text there.
 */
export function buildAssembleArgs(input: AssembleInput): string[] {
  const { clips, width, height, runtimeSeconds } = input;
  if (clips.length === 0) throw new Error('Cannot assemble a film without clips.');

  const args = [...BASE_ARGS];
  for (const clip of clips) args.push('-i', clip.path);

  let nextInput = clips.length;
  const audioInputs = clips.map((clip) => {
    if (clip.hasAudio) return null;
    args.push(
      '-f',
      'lavfi',
      '-t',
      formatSeconds(clip.durationSeconds),
      '-i',
      `anullsrc=channel_layout=stereo:sample_rate=${String(AUDIO_SAMPLE_RATE)}`,
    );
    return nextInput++;
  });

  const size = `${String(width)}:${String(height)}`;
  const graph: string[] = [];
  clips.forEach((_, index) => {
    const n = String(index);
    graph.push(
      `[${n}:v]scale=${size}:force_original_aspect_ratio=decrease,pad=${size}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${String(OUTPUT_FPS)},format=yuv420p[v${n}]`,
    );
    graph.push(`[${String(audioInputs[index] ?? index)}:a]${STEREO}[a${n}]`);
  });
  const segments = clips.map((_, index) => `[v${String(index)}][a${String(index)}]`).join('');
  graph.push(`${segments}concat=n=${String(clips.length)}:v=1:a=1[vcat][acat]`);

  // Clips should already add up to the runtime; cloning the last frame covers a provider
  // that returns a clip a few frames short, and the trim removes any excess.
  const clipSeconds = clips.reduce((sum, clip) => sum + clip.durationSeconds, 0);
  const padSeconds = Math.max(0, runtimeSeconds - clipSeconds) + 1;
  const card = endCardTiming(runtimeSeconds);
  const fadeSeconds = Math.min(1, card.durationSeconds / 2);

  const video = [
    // concat starts each segment where the longest stream of the previous one ended (usually
    // the AAC audio), which leaves gaps in the video timestamps; fps fills them so the film has
    // exactly runtime x OUTPUT_FPS frames.
    `fps=${String(OUTPUT_FPS)}`,
    `tpad=stop_mode=clone:stop_duration=${formatSeconds(padSeconds)}`,
    `trim=duration=${formatSeconds(runtimeSeconds)}`,
    'setpts=PTS-STARTPTS',
    `fade=t=out:st=${formatSeconds(card.startSeconds)}:d=${formatSeconds(fadeSeconds)}`,
  ];
  if (input.endCard) {
    const textStart = formatSeconds(card.startSeconds + fadeSeconds / 2);
    video.push(
      drawTextFilter({
        text: input.endCard.text,
        style: input.endCard.style,
        fontSize: fitFontSize(input.endCard.text, width, height, 0.09),
        y: '(h-text_h)/2',
        alpha: `min(1,(t-${textStart})/0.8)`,
        enable: `gte(t,${textStart})`,
      }),
    );
  }
  graph.push(`[vcat]${video.join(',')}[v]`);
  graph.push(
    `[acat]apad,atrim=duration=${formatSeconds(runtimeSeconds)},asetpts=PTS-STARTPTS,afade=t=out:st=${formatSeconds(card.startSeconds)}:d=${formatSeconds(card.durationSeconds)}[a]`,
  );

  args.push(
    '-filter_complex',
    graph.join(';'),
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    input.outputPath,
  );
  return args;
}

export interface PlaceholderClipInput {
  outputPath: string;
  durationSeconds: number;
  sceneNumber: number;
  title: string;
  width: number;
  height: number;
  /** Null when ffmpeg has no drawtext filter: the clip is then a plain colour field. */
  text: TextStyle | null;
}

/** A free, offline stand-in for a generated clip: a coloured field, a tone and the scene title. */
export function buildPlaceholderClipArgs(input: PlaceholderClipInput): string[] {
  const seconds = formatSeconds(input.durationSeconds);
  const color = PLACEHOLDER_COLORS[(input.sceneNumber - 1) % PLACEHOLDER_COLORS.length] ?? '0x333333';
  const frequency = 220 + ((input.sceneNumber - 1) % 6) * 55;
  const video = ['drawbox=x=0:y=ih*0.66:w=iw:h=ih*0.34:color=black@0.35:t=fill'];
  if (input.text) {
    const label = `SCENE ${String(input.sceneNumber)}`;
    video.push(
      drawTextFilter({
        text: label,
        style: input.text,
        fontSize: fitFontSize(label, input.width, input.height, 0.06),
        y: 'h*0.70',
        color: '0xf4a261',
      }),
      drawTextFilter({
        text: input.title,
        style: input.text,
        fontSize: fitFontSize(cleanDrawText(input.title), input.width, input.height, 0.09),
        y: 'h*0.80',
      }),
    );
  }
  return [
    ...BASE_ARGS,
    '-f',
    'lavfi',
    '-i',
    `color=c=${color}:s=${String(input.width)}x${String(input.height)}:r=${String(OUTPUT_FPS)}:d=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${String(frequency)}:sample_rate=${String(AUDIO_SAMPLE_RATE)}:duration=${seconds}`,
    '-filter_complex',
    `[0:v]${video.join(',')}[v];[1:a]volume=0.05,${STEREO}[a]`,
    '-map',
    '[v]',
    '-map',
    '[a]',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-t',
    seconds,
    '-movflags',
    '+faststart',
    input.outputPath,
  ];
}

export interface PlaceholderPosterInput {
  outputPath: string;
  title: string;
  size: number;
  text: TextStyle | null;
}

/** A free, offline stand-in for the generated poster. */
export function buildPlaceholderPosterArgs(input: PlaceholderPosterInput): string[] {
  const size = String(input.size);
  const filters = ['drawbox=x=iw*0.05:y=ih*0.05:w=iw*0.9:h=ih*0.9:color=0xf45820@0.8:t=6'];
  if (input.text) {
    const title = cleanDrawText(input.title, 60);
    const caption = 'Placeholder poster (mock mode)';
    filters.push(
      drawTextFilter({
        text: title,
        style: input.text,
        fontSize: fitFontSize(title, input.size, input.size, 0.09),
        y: '(h-text_h)/2',
      }),
      drawTextFilter({
        text: caption,
        style: input.text,
        fontSize: fitFontSize(caption, input.size, input.size, 0.035),
        y: 'h*0.82',
        color: '0xf4a261',
      }),
    );
  }
  return [
    ...BASE_ARGS,
    '-f',
    'lavfi',
    '-i',
    `color=c=0x141821:s=${size}x${size}`,
    '-vf',
    filters.join(','),
    '-frames:v',
    '1',
    input.outputPath,
  ];
}

/** Seconds as ffmpeg likes them: plain decimal, at most millisecond precision. */
export function formatSeconds(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}
