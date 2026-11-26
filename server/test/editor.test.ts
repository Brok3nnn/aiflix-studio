import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildAssembleArgs,
  buildPlaceholderClipArgs,
  buildPlaceholderPosterArgs,
  cleanDrawText,
  drawTextFilter,
  endCardTiming,
  escapeFilterValue,
  fitFontSize,
  formatSeconds,
  parseFilterNames,
  parseProbeOutput,
} from '../src/studio/editor/commands.ts';
import { tempDir } from './helpers.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/** The value that follows `flag` in an argument list. */
function argAfter(args: string[], flag: string): string {
  const index = args.indexOf(flag);
  const value = args[index + 1];
  if (index === -1 || value === undefined) throw new Error(`${flag} not found`);
  return value;
}

describe('escapeFilterValue', () => {
  it('matches the two-level example in ffmpeg-filters(1)', () => {
    expect(escapeFilterValue("this is a 'string': may contain one, or more, special characters")).toBe(
      "this is a \\\\\\'string\\\\\\'\\\\: may contain one\\, or more\\, special characters",
    );
  });

  it('leaves plain values alone', () => {
    expect(escapeFilterValue('(w-text_w)/2')).toBe('(w-text_w)/2');
  });

  it.skipIf(!hasFfmpeg)('survives the ffmpeg parser for a hostile file path', async () => {
    // lut3d reads a file named in a filter option, like drawtext's fontfile, and is built
    // into every ffmpeg, so it proves the escaping against the real parser.
    const dir = path.join(await tempDir(), "it's: [x], y; z \\ w");
    await mkdir(dir, { recursive: true });
    const lut = path.join(dir, 'identity.cube');
    await writeFile(
      lut,
      ['LUT_3D_SIZE 2', ...['0 0 0', '1 0 0', '0 1 0', '1 1 0', '0 0 1', '1 0 1', '0 1 1', '1 1 1']].join(
        '\n',
      ),
    );
    const result = spawnSync('ffmpeg', [
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=16x16:d=0.04',
      '-vf',
      `lut3d=file=${escapeFilterValue(lut)}`,
      '-frames:v',
      '1',
      '-f',
      'null',
      '-',
    ]);
    expect(result.stderr.toString()).toBe('');
    expect(result.status).toBe(0);
  });
});

describe('parseFilterNames', () => {
  it('reads filter names from `ffmpeg -filters`', () => {
    const listing = [
      'Filters:',
      '  T.. = Timeline support',
      '  ------',
      ' TSC drawtext          V->V       Draw text on top of video frames using libfreetype library.',
      ' ... concat            N->N       Concatenate audio and video streams.',
      ' .. color             |->V       Provide an uniformly colored input.',
    ].join('\n');
    expect([...parseFilterNames(listing)]).toEqual(['drawtext', 'concat', 'color']);
  });
});

describe('parseProbeOutput', () => {
  it('reads duration, size and audio presence', () => {
    const output = JSON.stringify({
      streams: [{ codec_type: 'video', width: 1920, height: 1080 }, { codec_type: 'audio' }],
      format: { duration: '14.040000' },
    });
    expect(parseProbeOutput(output)).toEqual({
      durationSeconds: 14.04,
      width: 1920,
      height: 1080,
      hasAudio: true,
    });
  });

  it('rejects output without a duration', () => {
    expect(() => parseProbeOutput('{"format":{}}')).toThrow('no duration');
  });
});

describe('buildAssembleArgs', () => {
  const clips = [
    { path: '/films/a/clip-01.mp4', durationSeconds: 10.04, hasAudio: true },
    { path: '/films/a/clip-02.mp4', durationSeconds: 12, hasAudio: false },
  ];

  it('concatenates in scene order, normalises formats and trims to the exact runtime', () => {
    const args = buildAssembleArgs({
      clips,
      width: 1920,
      height: 1080,
      runtimeSeconds: 22,
      endCard: null,
      outputPath: '/films/a/final.partial.mp4',
    });
    expect(args.filter((_arg, index) => args[index - 1] === '-i')).toEqual([
      '/films/a/clip-01.mp4',
      '/films/a/clip-02.mp4',
      'anullsrc=channel_layout=stereo:sample_rate=48000',
    ]);
    const graph = argAfter(args, '-filter_complex');
    expect(graph).toContain('[0:v]scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080');
    // The silent clip takes its audio from the generated silence (input 2).
    expect(graph).toContain('[2:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a1]');
    expect(graph).toContain('[v0][a0][v1][a1]concat=n=2:v=1:a=1[vcat][acat]');
    expect(graph).toContain('trim=duration=22');
    expect(graph).toContain('apad,atrim=duration=22');
    expect(graph).not.toContain('drawtext');
    expect(args.at(-1)).toBe('/films/a/final.partial.mp4');
  });

  it('fades out over the end card and draws its text with the bundled font', () => {
    const args = buildAssembleArgs({
      clips,
      width: 1920,
      height: 1080,
      runtimeSeconds: 22,
      endCard: { text: 'AIFLIX Studio', style: { fontFile: '/fonts/Display Font.ttf' } },
      outputPath: '/films/a/final.partial.mp4',
    });
    const graph = argAfter(args, '-filter_complex');
    expect(endCardTiming(22)).toEqual({ startSeconds: 17, durationSeconds: 5 });
    expect(graph).toContain('fade=t=out:st=17:d=1');
    expect(graph).toContain('afade=t=out:st=17:d=5');
    expect(graph).toContain('drawtext=fontfile=/fonts/Display Font.ttf:text=AIFLIX Studio:expansion=none');
    expect(graph).toContain('enable=gte(t\\,17.5)');
  });

  it('pads with the last frame when the clips come back short', () => {
    const short = buildAssembleArgs({
      clips: [{ path: 'a.mp4', durationSeconds: 19.5, hasAudio: true }],
      width: 640,
      height: 360,
      runtimeSeconds: 20,
      endCard: null,
      outputPath: 'out.mp4',
    });
    expect(argAfter(short, '-filter_complex')).toContain('tpad=stop_mode=clone:stop_duration=1.5');
  });

  it('refuses an empty edit', () => {
    expect(() =>
      buildAssembleArgs({
        clips: [],
        width: 1,
        height: 1,
        runtimeSeconds: 8,
        endCard: null,
        outputPath: 'x.mp4',
      }),
    ).toThrow('without clips');
  });
});

describe('end card', () => {
  it('covers at most the last 5 seconds, and a quarter of very short films', () => {
    expect(endCardTiming(64)).toEqual({ startSeconds: 59, durationSeconds: 5 });
    expect(endCardTiming(8)).toEqual({ startSeconds: 6, durationSeconds: 2 });
  });

  it('sizes text to fit the frame', () => {
    expect(fitFontSize('AIFLIX Studio', 1920, 1080, 0.09)).toBe(97);
    expect(fitFontSize('A much, much longer end card line than usual', 1920, 1080, 0.09)).toBeLessThan(97);
  });
});

describe('drawTextFilter', () => {
  it('escapes user text and disables % expansion', () => {
    const filter = drawTextFilter({
      text: "It's 100%: [done]",
      style: { fontFile: '/f.ttf' },
      fontSize: 40,
      y: 'h*0.8',
    });
    expect(filter).toContain("text=It\\\\\\'s 100%\\\\: \\[done\\]");
    expect(filter).toContain('expansion=none');
  });

  it('strips control characters and caps the length', () => {
    expect(cleanDrawText('a\u0007b\nc')).toBe('ab c');
    expect(cleanDrawText('x'.repeat(100), 10)).toBe('xxxxxxx...');
  });
});

describe('placeholders', () => {
  it('renders a clip of the exact length, with the title only when drawtext exists', () => {
    const base = {
      outputPath: 'clip.mp4',
      durationSeconds: 12,
      sceneNumber: 2,
      title: 'The Offer',
      width: 1280,
      height: 720,
    };
    const withText = buildPlaceholderClipArgs({ ...base, text: { fontFile: '/f.ttf' } });
    expect(withText).toContain('color=c=0x5b2a86:s=1280x720:r=25:d=12');
    expect(argAfter(withText, '-t')).toBe('12');
    expect(argAfter(withText, '-filter_complex')).toContain('text=The Offer');

    const plain = buildPlaceholderClipArgs({ ...base, text: null });
    expect(argAfter(plain, '-filter_complex')).not.toContain('drawtext');
  });

  it('renders a square poster', () => {
    const args = buildPlaceholderPosterArgs({
      outputPath: 'poster.png',
      title: 'Bottle',
      size: 1024,
      text: null,
    });
    expect(args).toContain('color=c=0x141821:s=1024x1024');
    expect(argAfter(args, '-frames:v')).toBe('1');
  });
});

describe('formatSeconds', () => {
  it('prints plain decimals with millisecond precision', () => {
    expect(formatSeconds(17)).toBe('17');
    expect(formatSeconds(17.5)).toBe('17.5');
    expect(formatSeconds(1 / 3)).toBe('0.333');
  });
});
