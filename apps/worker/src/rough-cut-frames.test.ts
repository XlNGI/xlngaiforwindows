import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FfmpegRuntime } from './ffmpeg-runtime.js';

const resources = resolve('../desktop/src-tauri/resources/ffmpeg');
function run(tool: string, args: string[]) {
  return execFileSync(join(resources, tool), ['-v', 'error', ...args], {
    windowsHide: true,
    timeout: 60000,
    maxBuffer: 16 * 1024 * 1024,
  });
}
function inspect(path: string) {
  const document = JSON.parse(
    run('ffprobe.exe', [
      '-select_streams',
      'v:0',
      '-show_frames',
      '-show_entries',
      'frame=best_effort_timestamp_time',
      '-of',
      'json',
      path,
    ]).toString(),
  ) as { frames: { best_effort_timestamp_time: string }[] };
  const pts = document.frames.map((frame) => Number(frame.best_effort_timestamp_time));
  const rgb = run('ffmpeg.exe', [
    '-i',
    path,
    '-an',
    '-vf',
    'scale=1:1',
    '-pix_fmt',
    'rgb24',
    '-fps_mode',
    'passthrough',
    '-f',
    'rawvideo',
    'pipe:1',
  ]);
  return {
    pts,
    colors: Array.from({ length: rgb.length / 3 }, (_, i) =>
      Math.max(...rgb.subarray(i * 3, i * 3 + 3)) < 16
        ? 'black'
        : rgb[i * 3]! > rgb[i * 3 + 1]!
          ? 'red'
          : 'green',
    ),
  };
}

describe.runIf(process.platform === 'win32')('rough cut decoded frame continuity', () => {
  let directory: string;
  const sources: string[] = [];
  const originals: Buffer[] = [];
  const runtime = new FfmpegRuntime({ resourceDirectory: resources });
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), '粗剪帧连续性 '));
    for (const [i, fps] of ['30', '24', '25', '30000/1001'].entries()) {
      const path = join(directory, `source-${i}.mp4`);
      run('ffmpeg.exe', [
        '-nostdin',
        '-f',
        'lavfi',
        '-i',
        `color=c=${i % 2 ? 'lime' : 'red'}:s=160x90:r=${fps}:d=1.2`,
        ...(i % 2
          ? [
              '-f',
              'lavfi',
              '-i',
              'sine=frequency=440:sample_rate=48000:duration=1.2',
              '-c:a',
              'aac',
            ]
          : []),
        '-c:v',
        'libopenh264',
        '-pix_fmt',
        'yuv420p',
        path,
      ]);
      sources.push(path);
      originals.push(await readFile(path));
    }
  });
  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('preserves every frame and its boundary across twelve mixed-rate clips', async () => {
    const output = join(directory, 'twelve-clips.mp4');
    await runtime.composeRoughCut(
      Array.from({ length: 12 }, (_, i) => ({
        path: sources[i % 2]!,
        inMs: 100,
        outMs: 600,
        muted: false,
        fit: 'contain' as const,
      })),
      output,
      160,
      90,
    );
    const { pts, colors } = inspect(output);
    expect(pts).toHaveLength(180);
    pts.forEach((time, i) => expect(time).toBeCloseTo(i / 30, 4));
    expect(colors).toEqual(
      Array.from({ length: 180 }, (_, i) => (Math.floor(i / 15) % 2 ? 'green' : 'red')),
    );
    for (const [i, source] of sources.entries())
      expect(await readFile(source)).toEqual(originals[i]);
  });

  it('keeps rounded durations and short tails continuous with 24/25/30/29.97 fps and mixed audio', async () => {
    const clips = sources.flatMap((path, i) => [
      { path, inMs: 125, outMs: 558, muted: i === 1, fit: 'cover' as const },
      { path, inMs: 1140, outMs: 1200, muted: i === 3, fit: 'contain' as const },
    ]);
    const output = join(directory, 'mixed-tails.mp4');
    const probe = await runtime.composeRoughCut(clips, output, 160, 90);
    const { pts, colors } = inspect(output);
    expect(pts).toHaveLength(60); // 4 * (13 + 2) frames.
    pts.forEach((time, i) => expect(time).toBeCloseTo(i / 30, 4));
    expect(colors).toEqual(
      Array.from({ length: 60 }, (_, i) => (Math.floor(i / 15) % 2 ? 'green' : 'red')),
    );
    expect(probe.durationMs).toBe(2000);
    const samples = run('ffmpeg.exe', [
      '-i',
      output,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-f',
      's16le',
      'pipe:1',
    ]);
    const rms = (start: number, end: number) => {
      let power = 0;
      for (let i = start * 48; i < end * 48; i++) power += samples.readInt16LE(i * 2) ** 2;
      return Math.sqrt(power / ((end - start) * 48));
    };
    expect(rms(550, 850)).toBeLessThan(2); // Explicitly muted source with sound.
    expect(rms(950, 980)).toBeGreaterThan(100); // Its unmuted short tail.
    expect(rms(1550, 1850)).toBeGreaterThan(100); // 29.97fps original audio.
    expect(rms(1960, 1990)).toBeLessThan(2); // Muted final tail.
    for (const [i, source] of sources.entries())
      expect(await readFile(source)).toEqual(originals[i]);
  });
});
