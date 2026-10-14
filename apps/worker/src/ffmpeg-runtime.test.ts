import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FfmpegRuntime } from './ffmpeg-runtime.js';

const resources = resolve('../desktop/src-tauri/resources/ffmpeg');
const executable = join(resources, 'ffmpeg.exe');

describe('FFmpeg resource failures', () => {
  it('fails clearly without a bundled executable and never searches PATH', async () => {
    const runtime = new FfmpegRuntime({ resourceDirectory: resolve('missing-ffmpeg-resources') });
    expect(await runtime.availability()).toMatchObject({ available: false });
    await expect(runtime.probe(resolve('package.json'))).rejects.toThrow('Bundled FFmpeg');
  });
});

describe.runIf(process.platform === 'win32')('bundled LGPL FFmpeg media integration', () => {
  let directory: string;
  let runtime: FfmpegRuntime;
  let source: string;
  let audio: string;
  let tailAudio: string;
  let replacement: string;

  function encode(args: string[]): Buffer {
    return execFileSync(executable, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], {
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 4 * 1024 * 1024,
    });
  }

  function rms(samples: Buffer, startMs: number, endMs: number): number {
    let power = 0;
    const start = Math.round(startMs * 48);
    const end = Math.round(endMs * 48);
    for (let index = start; index < end; index++) power += samples.readInt16LE(index * 2) ** 2;
    return Math.sqrt(power / (end - start));
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), '配音 FFmpeg fixture '));
    runtime = new FfmpegRuntime({ resourceDirectory: resources });
    const availability = await runtime.availability();
    expect(availability).toMatchObject({ available: true, h264Encoder: 'libopenh264' });
    source = join(directory, 'source scene ; literal.mp4');
    audio = join(directory, 'confirmed dialogue.wav');
    tailAudio = join(directory, 'tail dialogue.wav');
    replacement = join(directory, 'lip result.mp4');
    encode([
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=160x120:r=25:d=4',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=4',
      '-c:v',
      'libopenh264',
      '-b:v',
      '4000000',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      source,
    ]);
    encode([
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880:sample_rate=44100:duration=0.6',
      '-c:a',
      'pcm_s16le',
      audio,
    ]);
    encode([
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=1000:sample_rate=48000:duration=0.8',
      '-c:a',
      'pcm_s16le',
      tailAudio,
    ]);
    encode([
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=160x120:r=25:d=0.8',
      '-c:v',
      'libopenh264',
      '-b:v',
      '4000000',
      '-pix_fmt',
      'yuv420p',
      replacement,
    ]);
  });

  afterAll(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it('probes real bundled streams and normalizes audio without changing duration', async () => {
    expect(await runtime.probe(source)).toMatchObject({
      durationMs: 4000,
      width: 160,
      height: 120,
      fps: 25,
      hasVideo: true,
      hasAudio: true,
    });
    const result = await runtime.convertAudio(audio, join(directory, 'normalized.wav'));
    expect(result).toMatchObject({
      durationMs: 600,
      sampleRate: 48000,
      channels: 2,
      hasVideo: false,
      hasAudio: true,
    });
  });

  it('extracts the precise interval to playable H264 rather than copying keyframe ranges', async () => {
    const output = join(directory, 'accurate clip.mp4');
    const result = await runtime.extractClip(source, output, 360, 1160);
    expect(result).toMatchObject({ durationMs: 800, hasVideo: true, hasAudio: false });
    const codec = execFileSync(
      join(resources, 'ffprobe.exe'),
      ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', output],
      { windowsHide: true, encoding: 'utf8' },
    );
    expect(codec.trim()).toBe('h264');
  });

  it('preserves absolute scene positions and final dialogue while removing all original audio', async () => {
    const output = join(directory, 'composed scene.mp4');
    const original = await readFile(source);
    const result = await runtime.composeDubbing(source, output, [
      { startMs: 1000, endMs: 1800, audioPath: audio, videoPath: replacement },
      { startMs: 3200, endMs: 4000, audioPath: tailAudio },
    ]);
    expect(result.durationMs).toBe(4000);
    expect(await readFile(source)).toEqual(original);
    const pcm = encode([
      '-i',
      output,
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-f',
      's16le',
      '-',
    ]);
    expect(rms(pcm, 300, 800)).toBeLessThan(10);
    expect(rms(pcm, 1100, 1500)).toBeGreaterThan(500);
    expect(rms(pcm, 2200, 2800)).toBeLessThan(10);
    expect(rms(pcm, 3800, 3950)).toBeGreaterThan(500);
    const red = encode([
      '-i',
      output,
      '-ss',
      '1.4',
      '-frames:v',
      '1',
      '-vf',
      'scale=1:1',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      '-',
    ]);
    const blue = encode([
      '-i',
      output,
      '-ss',
      '2.4',
      '-frames:v',
      '1',
      '-vf',
      'scale=1:1',
      '-pix_fmt',
      'rgb24',
      '-f',
      'rawvideo',
      '-',
    ]);
    expect(red[0]).toBeGreaterThan(200);
    expect(red[2]).toBeLessThan(50);
    expect(blue[2]).toBeGreaterThan(200);
    expect(blue[0]).toBeLessThan(50);
  });

  it('rejects overlaps, dialogue truncation, replacement drift and out-of-bounds intervals', async () => {
    await expect(
      runtime.composeDubbing(source, join(directory, 'overlap.mp4'), [
        { startMs: 0, endMs: 800, audioPath: audio },
        { startMs: 600, endMs: 1400, audioPath: tailAudio },
      ]),
    ).rejects.toThrow('overlap');
    await expect(
      runtime.composeDubbing(source, join(directory, 'truncation.mp4'), [
        { startMs: 0, endMs: 400, audioPath: audio },
      ]),
    ).rejects.toThrow('tail');
    await expect(
      runtime.composeDubbing(source, join(directory, 'drift.mp4'), [
        { startMs: 0, endMs: 1200, audioPath: audio, videoPath: replacement },
      ]),
    ).rejects.toThrow('one output frame');
    await expect(
      runtime.extractClip(source, join(directory, 'bounds.mp4'), 0, 4001),
    ).rejects.toThrow('inside');
  });

  it('protects existing output and rejects corrupt input', async () => {
    const output = join(directory, 'existing.wav');
    await writeFile(output, 'keep this existing file');
    await expect(runtime.convertAudio(audio, output)).rejects.toThrow('already exists');
    expect(await readFile(output, 'utf8')).toBe('keep this existing file');
    const corrupted = join(directory, 'corrupt.mp4');
    await writeFile(corrupted, 'not media');
    await expect(runtime.probe(corrupted)).rejects.toThrow('Media processing failed');
    const truncated = join(directory, 'truncated.wav');
    const bytes = await readFile(audio);
    await writeFile(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)));
    await expect(runtime.validate(truncated)).rejects.toThrow('Media processing failed');
  });

  it('rejects junction escapes and playlists with indirect file references', async () => {
    const junction = join(directory, 'junction');
    await symlink(directory, junction, 'junction');
    await expect(runtime.probe(join(junction, 'confirmed dialogue.wav'))).rejects.toThrow(
      'junctions',
    );
    await expect(runtime.convertAudio(audio, join(junction, 'escaped.wav'))).rejects.toThrow(
      'junctions',
    );
    const playlist = join(directory, 'indirect.wav');
    await writeFile(playlist, `ffconcat version 1.0\nfile '${audio.replaceAll('\\', '/')}'\n`);
    await expect(runtime.probe(playlist)).rejects.toThrow('Media processing failed');
  });

  it('honors cancellation and timeout without committing incomplete output', async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 25);
    const output = join(directory, 'cancelled.mp4');
    try {
      await expect(runtime.extractClip(source, output, 0, 4000, controller.signal)).rejects.toThrow(
        'cancelled',
      );
    } finally {
      clearTimeout(timer);
    }
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
    const timedRuntime = new FfmpegRuntime({ resourceDirectory: resources, timeoutMs: 1 });
    await timedRuntime.availability();
    const timedOutput = join(directory, 'timed out.mp4');
    await expect(timedRuntime.extractClip(source, timedOutput, 0, 4000)).rejects.toThrow(
      'timed out',
    );
    await expect(readFile(timedOutput)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects insufficient disk space before processing and enforces output size during staging', async () => {
    const lowDisk = new FfmpegRuntime({
      resourceDirectory: resources,
      storageProbe: () => ({ bavail: 1, bsize: 1024 }),
    });
    const diskOutput = join(directory, 'disk full.wav');
    await expect(lowDisk.convertAudio(audio, diskOutput)).rejects.toThrow(
      'Insufficient disk space',
    );
    await expect(readFile(diskOutput)).rejects.toMatchObject({ code: 'ENOENT' });
    const bounded = new FfmpegRuntime({ resourceDirectory: resources, maxOutputBytes: 1024 });
    const largeOutput = join(directory, 'oversized.wav');
    await expect(bounded.convertAudio(audio, largeOutput)).rejects.toThrow('maximum file size');
    await expect(readFile(largeOutput)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(directory)).filter((name) => name.startsWith('.ffmpeg-'))).toEqual([]);
  });

  it('reserves disk space for the final copy instead of committing when only the staging reserve remains', async () => {
    let calls = 0;
    const shrinking = new FfmpegRuntime({
      resourceDirectory: resources,
      storageProbe: () => ({
        bavail: ++calls < 4 ? 100 * 1024 * 1024 : 16 * 1024 * 1024 + 1024,
        bsize: 1,
      }),
    });
    const output = join(directory, 'copy reserve.wav');
    await expect(shrinking.convertAudio(audio, output)).rejects.toThrow('Insufficient disk space');
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(directory)).filter((name) => name.startsWith('.ffmpeg-'))).toEqual([]);
  });
});
