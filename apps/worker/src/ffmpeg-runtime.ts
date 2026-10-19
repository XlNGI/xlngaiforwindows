import { spawn } from 'node:child_process';
import { constants, existsSync, statSync } from 'node:fs';
import { copyFile, lstat, mkdtemp, readFile, realpath, rm, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { assertStorageCapacity, type StorageStats } from './storage-capacity.js';

export interface MediaProbe {
  durationMs: number;
  width?: number;
  height?: number;
  fps?: number;
  sampleRate?: number;
  channels?: number;
  hasVideo: boolean;
  hasAudio: boolean;
}

export interface FfmpegAvailability {
  available: boolean;
  ffmpegPath?: string;
  ffprobePath?: string;
  version?: string;
  h264Encoder?: string;
  error?: string;
}

export interface FfmpegRuntimeOptions {
  resourceDirectory?: string;
  ffmpegPath?: string;
  ffprobePath?: string;
  timeoutMs?: number;
  storageProbe?: (directory: string) => StorageStats;
  /** Test/deployment may lower the hard ceiling, never raise it above 512 MiB. */
  maxOutputBytes?: number;
}

export interface DubbingSegment {
  startMs: number;
  endMs: number;
  audioPath: string;
  videoPath?: string;
}

interface ProbeDocument {
  format?: { duration?: string };
  streams?: {
    codec_type?: string;
    duration?: string;
    width?: number;
    height?: number;
    avg_frame_rate?: string;
    sample_rate?: string;
    channels?: number;
  }[];
}

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_SEGMENTS = 100;
const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
const MAX_MEDIA_BYTES = 512 * 1024 * 1024;
const LOCAL_INPUT_OPTIONS = [
  '-protocol_whitelist',
  'file',
  '-format_whitelist',
  'wav,mp3,flac,ogg,mov,matroska,webm,aac',
];
const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Local files only. Project ownership is checked by the calling repository/service. */
async function localFile(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('Media path must be absolute.');
  const normalized = resolve(path);
  const canonical = await realpath(normalized);
  if (!samePath(normalized, canonical) || !(await lstat(normalized)).isFile()) {
    throw new Error('Media must be a regular local file without symbolic links or junctions.');
  }
  if ((await stat(canonical)).size === 0) throw new Error('Media file is empty.');
  return canonical;
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(6);
}

function positive(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function frameRate(value?: string): number | undefined {
  if (!value) return undefined;
  const [numerator, denominator] = value.split('/').map(Number);
  return positive(denominator ? (numerator ?? 0) / denominator : numerator);
}

function checkRange(startMs: number, endMs: number, durationMs: number): void {
  if (
    !Number.isSafeInteger(startMs) ||
    !Number.isSafeInteger(endMs) ||
    startMs < 0 ||
    endMs <= startMs ||
    endMs > durationMs
  ) {
    throw new Error('Media interval must use integer milliseconds inside the source duration.');
  }
}

export class FfmpegRuntime {
  private readonly options: FfmpegRuntimeOptions;
  private resolved?: Promise<FfmpegAvailability>;

  constructor(options: FfmpegRuntimeOptions = {}) {
    if (
      options.maxOutputBytes !== undefined &&
      (!Number.isSafeInteger(options.maxOutputBytes) ||
        options.maxOutputBytes <= 0 ||
        options.maxOutputBytes > MAX_MEDIA_BYTES)
    ) {
      throw new Error('Media output size limit must be between 1 byte and 512 MiB.');
    }
    this.options = options;
  }

  availability(): Promise<FfmpegAvailability> {
    this.resolved ??= this.resolveTools();
    return this.resolved;
  }

  private async resolveTools(): Promise<FfmpegAvailability> {
    try {
      const directoryCandidates = this.options.resourceDirectory
        ? [resolve(this.options.resourceDirectory)]
        : 'pkg' in process
          ? [join(dirname(process.execPath), 'media', 'ffmpeg')]
          : [
              join(dirname(process.execPath), 'media', 'ffmpeg'),
              resolve('apps/desktop/src-tauri/resources/ffmpeg'),
              resolve('../desktop/src-tauri/resources/ffmpeg'),
            ];
      let directory = directoryCandidates[0]!;
      if (!this.options.ffmpegPath && !this.options.ffprobePath) {
        for (const candidate of directoryCandidates) {
          try {
            await localFile(join(candidate, 'ffmpeg.exe'));
            directory = candidate;
            break;
          } catch {
            // Try another bundled resource location, never the system PATH.
          }
        }
      }
      const ffmpegPath = await localFile(this.options.ffmpegPath ?? join(directory, 'ffmpeg.exe'));
      const ffprobePath = await localFile(
        this.options.ffprobePath ?? join(directory, 'ffprobe.exe'),
      );
      const version = await this.run(
        ffmpegPath,
        ['-version'],
        dirname(ffmpegPath),
        undefined,
        10000,
      );
      await this.run(ffprobePath, ['-version'], dirname(ffprobePath), undefined, 10000);
      if (/--enable-(?:gpl|nonfree)\b/.test(version)) {
        throw new Error(
          'This application requires an LGPL FFmpeg build without GPL/nonfree components.',
        );
      }
      const encoders = await this.run(
        ffmpegPath,
        ['-hide_banner', '-encoders'],
        dirname(ffmpegPath),
        undefined,
        10000,
      );
      const h264Encoder = /\blibopenh264\b/.test(encoders)
        ? 'libopenh264'
        : /\bh264_mf\b/.test(encoders)
          ? 'h264_mf'
          : undefined;
      return {
        available: true,
        ffmpegPath,
        ffprobePath,
        version: version.split('\n')[0]?.trim(),
        h264Encoder,
      };
    } catch (error) {
      return {
        available: false,
        error: `Bundled FFmpeg is unavailable; repair the installation or prepare its resources. ${error instanceof Error ? error.message : 'Tool validation failed.'}`,
      };
    }
  }

  private async tools(): Promise<
    Required<Pick<FfmpegAvailability, 'ffmpegPath' | 'ffprobePath'>> & FfmpegAvailability
  > {
    const tools = await this.availability();
    if (!tools.available || !tools.ffmpegPath || !tools.ffprobePath) {
      throw new Error(tools.error ?? 'Bundled FFmpeg is unavailable.');
    }
    return { ...tools, ffmpegPath: tools.ffmpegPath, ffprobePath: tools.ffprobePath };
  }

  private run(
    executable: string,
    args: string[],
    cwd: string,
    signal?: AbortSignal,
    timeoutMs = this.options.timeoutMs ?? 120000,
    checkOutput?: () => void,
  ): Promise<string> {
    if (signal?.aborted) return Promise.reject(new Error('Media operation cancelled.'));
    try {
      checkOutput?.();
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error('Media output storage validation failed.'),
      );
    }
    return new Promise((resolveResult, reject) => {
      const processChild = spawn(executable, args, {
        cwd,
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let failure: string | undefined;
      let outputBytes = 0;
      const stop = (reason: string) => {
        failure ??= reason;
        processChild.kill('SIGKILL');
      };
      const abort = () => stop('Media operation cancelled.');
      signal?.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(() => stop('Media operation timed out.'), timeoutMs);
      const outputMonitor = checkOutput
        ? setInterval(() => {
            try {
              checkOutput();
            } catch (error) {
              stop(
                error instanceof Error ? error.message : 'Media output storage validation failed.',
              );
            }
          }, 250)
        : undefined;
      const cleanup = () => {
        clearTimeout(timeout);
        clearInterval(outputMonitor);
        signal?.removeEventListener('abort', abort);
      };
      processChild.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) stop('Media tool output exceeded its limit.');
        else stdout += chunk.toString('utf8');
      });
      processChild.stderr.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-8192);
      });
      processChild.once('error', (error) => {
        cleanup();
        reject(new Error(`Cannot start bundled media tool: ${error.message}`));
      });
      processChild.once('close', (code) => {
        cleanup();
        if (failure) reject(new Error(failure));
        else if (code !== 0)
          reject(
            new Error(`Media processing failed (${code ?? 'signal'}): ${stderr.slice(-2048)}`),
          );
        else resolveResult(stdout);
      });
      if (signal?.aborted) abort();
    });
  }

  async probe(input: string, signal?: AbortSignal): Promise<MediaProbe> {
    const path = await localFile(input);
    const tools = await this.tools();
    const output = await this.run(
      tools.ffprobePath,
      ['-v', 'error', ...LOCAL_INPUT_OPTIONS, '-show_format', '-show_streams', '-of', 'json', path],
      dirname(path),
      signal,
      15000,
    );
    const document = JSON.parse(output) as ProbeDocument;
    const streams = document.streams ?? [];
    const video = streams.find((stream) => stream.codec_type === 'video');
    const audio = streams.find((stream) => stream.codec_type === 'audio');
    const duration =
      positive(document.format?.duration) ?? positive(video?.duration) ?? positive(audio?.duration);
    if (!duration || duration * 1000 > MAX_DURATION_MS || (!video && !audio)) {
      throw new Error(
        'Media has no usable streams or its duration exceeds the local processing limit.',
      );
    }
    const fps = frameRate(video?.avg_frame_rate);
    if (
      video &&
      (!positive(video.width) ||
        !positive(video.height) ||
        (video.width ?? 0) > 8192 ||
        (video.height ?? 0) > 8192 ||
        !fps ||
        fps > 120)
    ) {
      throw new Error('Media has invalid video dimensions.');
    }
    return {
      durationMs: Math.round(duration * 1000),
      width: video?.width,
      height: video?.height,
      fps,
      sampleRate: positive(audio?.sample_rate),
      channels: audio?.channels,
      hasVideo: Boolean(video),
      hasAudio: Boolean(audio),
    };
  }

  /** Full packet decode used at import/provider-output boundaries. */
  async validate(input: string, signal?: AbortSignal): Promise<MediaProbe> {
    const path = await localFile(input);
    const result = await this.probe(path, signal);
    const tools = await this.tools();
    await this.run(
      tools.ffmpegPath,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-xerror',
        '-err_detect',
        'explode',
        '-nostdin',
        ...LOCAL_INPUT_OPTIONS,
        '-i',
        path,
        '-f',
        'null',
        '-',
      ],
      dirname(path),
      signal,
      this.options.timeoutMs ?? Math.min(1800000, Math.max(120000, result.durationMs * 3)),
    );
    return result;
  }

  private async outputDirectory(output: string): Promise<string> {
    if (!isAbsolute(output) || output.includes('\0'))
      throw new Error('Output path must be absolute.');
    const parent = dirname(resolve(output));
    const canonical = await realpath(parent);
    if (!samePath(parent, canonical))
      throw new Error('Output directory cannot contain symbolic links or junctions.');
    try {
      await lstat(output);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return canonical;
      throw error;
    }
    throw new Error('Media output already exists; source files must never be overwritten.');
  }

  private async processOutput(
    output: string,
    args: string[],
    signal: AbortSignal | undefined,
    validate: (result: MediaProbe) => void,
    durationMs: number,
  ): Promise<MediaProbe> {
    const parent = await this.outputDirectory(output);
    assertStorageCapacity(parent, 0, this.options.storageProbe);
    const tools = await this.tools();
    const cwd = await mkdtemp(join(parent, '.ffmpeg-'));
    const stagedOutput = join(cwd, basename(output));
    const checkOutput = () => {
      assertStorageCapacity(cwd, 0, this.options.storageProbe);
      if (
        existsSync(stagedOutput) &&
        statSync(stagedOutput).size > (this.options.maxOutputBytes ?? MAX_MEDIA_BYTES)
      ) {
        throw new Error('Media output exceeds its maximum file size.');
      }
    };
    let ownsOutput = false;
    try {
      await this.run(
        tools.ffmpegPath,
        ['-hide_banner', '-loglevel', 'error', '-nostdin', '-n', ...args, stagedOutput],
        cwd,
        signal,
        this.options.timeoutMs ?? Math.min(1800000, Math.max(120000, durationMs * 3)),
        checkOutput,
      );
      checkOutput();
      const result = await this.validate(stagedOutput, signal);
      validate(result);
      if (signal?.aborted) throw new Error('Media operation cancelled.');
      assertStorageCapacity(parent, statSync(stagedOutput).size, this.options.storageProbe);
      await copyFile(stagedOutput, output, constants.COPYFILE_EXCL);
      ownsOutput = true;
      if (signal?.aborted) throw new Error('Media operation cancelled.');
      return result;
    } catch (error) {
      if (ownsOutput) await unlink(output).catch(() => undefined);
      throw error;
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  private async videoEncoder(): Promise<string[]> {
    const tools = await this.tools();
    if (!tools.h264Encoder) throw new Error('Bundled LGPL FFmpeg has no supported H.264 encoder.');
    return [
      '-c:v',
      tools.h264Encoder,
      '-b:v',
      '4000000',
      '-pix_fmt',
      'yuv420p',
      ...(tools.h264Encoder === 'h264_mf' ? ['-hw_encoding', '0'] : []),
    ];
  }

  async convertAudio(input: string, output: string, signal?: AbortSignal): Promise<MediaProbe> {
    const source = await localFile(input);
    const probe = await this.probe(source, signal);
    if (!probe.hasAudio || extname(output).toLowerCase() !== '.wav') {
      throw new Error('Audio conversion requires an audio stream and a new WAV output.');
    }
    return this.processOutput(
      output,
      [
        ...LOCAL_INPUT_OPTIONS,
        '-i',
        source,
        '-map',
        '0:a:0',
        '-vn',
        '-c:a',
        'pcm_s16le',
        '-ar',
        '48000',
        '-ac',
        '2',
      ],
      signal,
      (result) => {
        if (
          !result.hasAudio ||
          result.hasVideo ||
          Math.abs(result.durationMs - probe.durationMs) > 50
        ) {
          throw new Error('Converted audio is incomplete or has an unexpected duration.');
        }
      },
      probe.durationMs,
    );
  }

  async extractClip(
    input: string,
    output: string,
    startMs: number,
    endMs: number,
    signal?: AbortSignal,
  ): Promise<MediaProbe> {
    const source = await localFile(input);
    const probe = await this.probe(source, signal);
    checkRange(startMs, endMs, probe.durationMs);
    if (!probe.hasVideo || extname(output).toLowerCase() !== '.mp4') {
      throw new Error('Video extraction requires a video stream and a new MP4 output.');
    }
    const durationMs = endMs - startMs;
    return this.processOutput(
      output,
      [
        ...LOCAL_INPUT_OPTIONS,
        '-i',
        source,
        '-ss',
        seconds(startMs),
        '-t',
        seconds(durationMs),
        '-map',
        '0:v:0',
        '-an',
        ...(await this.videoEncoder()),
        '-movflags',
        '+faststart',
      ],
      signal,
      (result) => {
        if (
          !result.hasVideo ||
          Math.abs(result.durationMs - durationMs) > 1000 / (probe.fps ?? 25) + 2
        ) {
          throw new Error('Extracted video does not match the requested frame interval.');
        }
      },
      durationMs,
    );
  }

  /** Decode at a manually selected time. Preview is bounded JPEG; adopted output is full-size PNG. */
  async extractFrame(
    input: string,
    output: string,
    timeMs: number,
    preview = false,
    signal?: AbortSignal,
  ): Promise<MediaProbe> {
    const source = await localFile(input);
    const probe = await this.probe(source, signal);
    if (
      !probe.hasVideo ||
      !Number.isSafeInteger(timeMs) ||
      timeMs < 0 ||
      timeMs >= probe.durationMs
    )
      throw new Error('请选择视频时长内的有效画面时间点。');
    if (extname(output).toLowerCase() !== (preview ? '.jpg' : '.png'))
      throw new Error('Frame output extension does not match its encoding.');
    const parent = await this.outputDirectory(output);
    const tools = await this.tools();
    assertStorageCapacity(parent, 0, this.options.storageProbe);
    const cwd = await mkdtemp(join(parent, '.ffmpeg-'));
    const staged = join(cwd, basename(output));
    let ownsOutput = false;
    const checkOutput = () => {
      assertStorageCapacity(cwd, 0, this.options.storageProbe);
      if (
        existsSync(staged) &&
        statSync(staged).size >
          Math.min(this.options.maxOutputBytes ?? Infinity, preview ? 512 * 1024 : 25 * 1024 * 1024)
      )
        throw new Error('抽帧图片超过大小限制。');
    };
    try {
      await this.run(
        tools.ffmpegPath,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-n',
          ...LOCAL_INPUT_OPTIONS,
          '-ss',
          seconds(timeMs),
          '-i',
          source,
          '-map',
          '0:v:0',
          '-frames:v',
          '1',
          '-an',
          ...(preview
            ? [
                '-vf',
                "scale=w='min(640,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease",
                '-q:v',
                '4',
              ]
            : ['-pix_fmt', 'rgb24']),
          '-threads',
          '1',
          '-update',
          '1',
          staged,
        ],
        cwd,
        signal,
        this.options.timeoutMs ?? 30000,
        checkOutput,
      );
      checkOutput();
      if (!existsSync(staged)) throw new Error('所选时间点没有可解码画面，请向前选择一帧。');
      const bytes = await readFile(staged);
      if (
        !(preview
          ? bytes[0] === 0xff && bytes[1] === 0xd8
          : bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
      )
        throw new Error('未能从所选时间点解码出完整图片，请向前选择一帧。');
      if (signal?.aborted) throw new Error('Media operation cancelled.');
      assertStorageCapacity(parent, bytes.length, this.options.storageProbe);
      await copyFile(staged, output, constants.COPYFILE_EXCL);
      ownsOutput = true;
      if (signal?.aborted) throw new Error('Media operation cancelled.');
      return probe;
    } catch (error) {
      if (ownsOutput) await unlink(output).catch(() => undefined);
      throw error;
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  /** Small multimodal transport copy; never replaces the user's full reference image. */
  async previewImage(input: string, output: string, signal?: AbortSignal): Promise<void> {
    const source = await localFile(input);
    if (
      !['.png', '.jpg', '.jpeg', '.webp'].includes(extname(source).toLowerCase()) ||
      extname(output).toLowerCase() !== '.jpg'
    )
      throw new Error('Image preview requires a local PNG, JPEG or WebP image.');
    const parent = await this.outputDirectory(output);
    const tools = await this.tools();
    assertStorageCapacity(parent, 0, this.options.storageProbe);
    const directory = await mkdtemp(join(parent, '.ffmpeg-'));
    const staged = join(directory, 'preview.jpg');
    let ownsOutput = false;
    const check = () => {
      assertStorageCapacity(directory, 0, this.options.storageProbe);
      if (existsSync(staged) && statSync(staged).size > 512 * 1024)
        throw new Error('图片预览超过大小限制。');
    };
    try {
      await this.run(
        tools.ffmpegPath,
        [
          '-v',
          'error',
          '-nostdin',
          '-n',
          '-protocol_whitelist',
          'file',
          '-format_whitelist',
          'image2,png_pipe,jpeg_pipe,webp_pipe',
          '-i',
          source,
          '-frames:v',
          '1',
          '-vf',
          "scale=w='min(640,iw)':h='min(640,ih)':force_original_aspect_ratio=decrease",
          '-q:v',
          '4',
          '-threads',
          '1',
          '-update',
          '1',
          staged,
        ],
        directory,
        signal,
        30000,
        check,
      );
      check();
      const bytes = await readFile(staged);
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('图片预览解码失败。');
      if (signal?.aborted) throw new Error('Media operation cancelled.');
      await copyFile(staged, output, constants.COPYFILE_EXCL);
      ownsOutput = true;
      if (signal?.aborted) throw new Error('Media operation cancelled.');
    } catch (error) {
      if (ownsOutput) await unlink(output).catch(() => undefined);
      throw error;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async composeDubbing(
    sourceVideo: string,
    output: string,
    segments: DubbingSegment[],
    signal?: AbortSignal,
  ): Promise<MediaProbe> {
    const source = await localFile(sourceVideo);
    const probe = await this.probe(source, signal);
    if (
      !probe.hasVideo ||
      extname(output).toLowerCase() !== '.mp4' ||
      segments.length > MAX_SEGMENTS
    ) {
      throw new Error(
        'Dubbing composition requires a video, a new MP4 output and at most 100 segments.',
      );
    }
    const fps = probe.fps ?? 25;
    const frameMs = 1000 / fps;
    const ordered = [...segments].sort((a, b) => a.startMs - b.startMs);
    let previousEnd = 0;
    const inputs = [...LOCAL_INPUT_OPTIONS, '-i', source];
    const filters = [
      `[0:v:0]setpts=PTS-STARTPTS,fps=${fps},format=yuv420p[base0]`,
      `anullsrc=r=48000:cl=stereo,atrim=duration=${seconds(probe.durationMs)},asetpts=PTS-STARTPTS[silence]`,
    ];
    const audioLabels = ['[silence]'];
    let inputIndex = 1;
    let videoIndex = 0;
    for (const [index, segment] of ordered.entries()) {
      checkRange(segment.startMs, segment.endMs, probe.durationMs);
      if (segment.startMs < previousEnd) throw new Error('Dubbing intervals cannot overlap.');
      previousEnd = segment.endMs;
      const audio = await localFile(segment.audioPath);
      const audioProbe = await this.probe(audio, signal);
      const durationMs = segment.endMs - segment.startMs;
      if (!audioProbe.hasAudio || audioProbe.durationMs > durationMs) {
        throw new Error(
          'Confirmed dialogue does not fit its interval; the tail must not be truncated.',
        );
      }
      inputs.push(...LOCAL_INPUT_OPTIONS, '-i', audio);
      filters.push(
        `[${inputIndex}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS,adelay=${segment.startMs}:all=1[voice${index}]`,
      );
      audioLabels.push(`[voice${index}]`);
      inputIndex++;
      if (segment.videoPath) {
        const replacement = await localFile(segment.videoPath);
        const replacementProbe = await this.probe(replacement, signal);
        if (
          !replacementProbe.hasVideo ||
          Math.abs(replacementProbe.durationMs - durationMs) > frameMs + 2
        ) {
          throw new Error(
            'Lip-sync result duration exceeds one output frame of its frozen interval.',
          );
        }
        inputs.push(...LOCAL_INPUT_OPTIONS, '-i', replacement);
        filters.push(
          `[${inputIndex}:v:0]trim=duration=${seconds(durationMs)},setpts=PTS-STARTPTS,fps=${fps},scale=${probe.width}:${probe.height}:force_original_aspect_ratio=decrease,pad=${probe.width}:${probe.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,setpts=PTS+${seconds(segment.startMs)}/TB[replacement${index}]`,
        );
        filters.push(
          `[base${videoIndex}][replacement${index}]overlay=eof_action=pass:repeatlast=0:enable='gte(t,${seconds(segment.startMs)})*lt(t,${seconds(segment.endMs)})'[base${videoIndex + 1}]`,
        );
        videoIndex++;
        inputIndex++;
      }
    }
    filters.push(
      `${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:dropout_transition=0:normalize=0[dialogue]`,
    );
    return this.processOutput(
      output,
      [
        ...inputs,
        '-filter_complex',
        filters.join(';'),
        '-map',
        `[base${videoIndex}]`,
        '-map',
        '[dialogue]',
        '-t',
        seconds(probe.durationMs),
        ...(await this.videoEncoder()),
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-ar',
        '48000',
        '-movflags',
        '+faststart',
      ],
      signal,
      (result) => {
        if (
          !result.hasVideo ||
          !result.hasAudio ||
          Math.abs(result.durationMs - probe.durationMs) > frameMs + 2
        ) {
          throw new Error(
            'Scene composition changed its frozen duration or omitted a media stream.',
          );
        }
      },
      probe.durationMs,
    );
  }
}
