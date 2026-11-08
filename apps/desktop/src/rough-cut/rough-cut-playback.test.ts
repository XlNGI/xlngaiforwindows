import type { RoughCutClip } from '@ai-video/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoughCutPlayback } from './rough-cut-playback';

const clip = (id: string, assetId = id, inMs = 0, outMs = 2000): RoughCutClip => ({
  id,
  assetId,
  inMs,
  outMs,
  durationMs: 4000,
  width: 160,
  height: 90,
  name: id,
  contentHash: assetId,
  hasAudio: true,
  muted: false,
  fit: 'contain',
  fps: 30,
});
let playback: RoughCutPlayback;
let a: HTMLVideoElement;
let b: HTMLVideoElement;
let callbacks: {
  time: ReturnType<typeof vi.fn>;
  stopped: ReturnType<typeof vi.fn>;
  waiting: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};
const sources = { a: '/a.mp4', b: '/b.mp4', c: '/c.mp4' };
function event(video: HTMLVideoElement, name: string) {
  video.dispatchEvent(new Event(name));
}
function ready(video: HTMLVideoElement) {
  Object.defineProperty(video, 'readyState', { configurable: true, value: 2 });
  event(video, 'loadedmetadata');
  event(video, 'loadeddata');
  event(video, 'seeked');
}
function visible(video: HTMLVideoElement) {
  return video.getAttribute('aria-hidden') === 'false';
}
function start(clips = [clip('a'), clip('b', 'b', 500, 2500)]) {
  playback.configure(clips, sources, []);
  ready(a);
  playback.setPlaying(true);
}
function tick(video: HTMLVideoElement, seconds: number) {
  video.currentTime = seconds;
  event(video, 'timeupdate');
}
function frames(video: HTMLVideoElement) {
  let next = 0;
  const queued = new Map<number, VideoFrameRequestCallback>();
  const cancelled: VideoFrameRequestCallback[] = [];
  video.requestVideoFrameCallback = (callback) => {
    queued.set(++next, callback);
    return next;
  };
  video.cancelVideoFrameCallback = (id) => {
    const callback = queued.get(id);
    if (callback) cancelled.push(callback);
    queued.delete(id);
  };
  return {
    cancelled,
    deliver(mediaTime: number) {
      const current = [...queued.values()];
      queued.clear();
      current.forEach((callback) => callback(0, { mediaTime } as VideoFrameCallbackMetadata));
    },
    queued,
  };
}
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  a = document.createElement('video');
  b = document.createElement('video');
  callbacks = { time: vi.fn(), stopped: vi.fn(), waiting: vi.fn(), error: vi.fn() };
  playback = new RoughCutPlayback([a, b], callbacks);
});
afterEach(() => {
  playback.dispose();
  vi.restoreAllMocks();
});

describe('rough cut decoder handoff', () => {
  it('holds the previous frame through metadata and seek, and starts only the ready decoder', () => {
    start();
    const playB = vi.spyOn(b, 'play');
    Object.defineProperty(b, 'readyState', { configurable: true, value: 1 });
    event(b, 'loadedmetadata');
    expect(b.currentTime).toBe(0.5);
    tick(a, 2.1);
    expect(visible(a)).toBe(true);
    expect(visible(b)).toBe(false);
    expect(a.muted).toBe(true);
    expect(playB).not.toHaveBeenCalled();
    Object.defineProperty(b, 'seeking', { configurable: true, value: true });
    ready(b);
    expect(visible(a)).toBe(true);
    Object.defineProperty(b, 'seeking', { configurable: true, value: false });
    event(b, 'seeked');
    expect(visible(b)).toBe(true);
    expect(visible(a)).toBe(false);
    expect(playB).toHaveBeenCalledOnce();
    expect(b.muted).toBe(false);
    expect(callbacks.time).toHaveBeenLastCalledWith(2000);
    expect(b.currentTime).toBe(0.5);
  });

  it('confirms a presented target frame when the browser supports video frame callbacks', () => {
    const fa = frames(a);
    const fb = frames(b);
    playback.configure([clip('a'), clip('b', 'b', 500, 2500)], sources, []);
    ready(a);
    expect(visible(a)).toBe(false);
    fa.deliver(0);
    expect(visible(a)).toBe(true);
    playback.setPlaying(true);
    ready(b);
    fb.deliver(0); // A stale, pre-seek frame cannot be displayed.
    a.currentTime = 1.99; // The media clock can lag the frame being presented.
    fa.deliver(2);
    expect(callbacks.time).toHaveBeenLastCalledWith(2000);
    expect(visible(a)).toBe(true);
    fb.deliver(0.5);
    expect(visible(b)).toBe(true);
    expect(a.muted).toBe(true);
  });

  it('preserves overshoot through multiple continuous splits without seeking', () => {
    start([
      clip('first', 'a', 0, 1000),
      { ...clip('second', 'a', 1000, 2000), muted: true },
      { ...clip('third', 'a', 2000, 4000), muted: true, fit: 'cover' },
    ]);
    tick(a, 2.1);
    expect(a.currentTime).toBe(2.1);
    expect(callbacks.time).toHaveBeenLastCalledWith(2100);
    expect(a.muted).toBe(true);
    expect(a.style.objectFit).toBe('cover');
    expect(visible(a)).toBe(true);
  });

  it('accepts the confirmed target frame when seeked follows the frame callback', () => {
    const fa = frames(a);
    playback.configure([clip('a', 'a', 500, 2500)], sources, []);
    ready(a);
    Object.defineProperty(a, 'seeking', { configurable: true, value: true });
    fa.deliver(0.5);
    expect(visible(a)).toBe(false);
    Object.defineProperty(a, 'seeking', { configurable: true, value: false });
    event(a, 'seeked');
    expect(visible(a)).toBe(true);
  });

  it('holds the last valid picture instead of copying a frame beyond the out point', () => {
    const canvas = document.createElement('canvas');
    const draw = vi.fn();
    vi.spyOn(canvas, 'getContext').mockReturnValue({
      drawImage: draw,
    } as unknown as CanvasRenderingContext2D);
    for (const video of [a, b]) {
      Object.defineProperty(video, 'videoWidth', { value: 160 });
      Object.defineProperty(video, 'videoHeight', { value: 90 });
    }
    playback.dispose();
    playback = new RoughCutPlayback([a, b], callbacks, canvas);
    start();
    tick(a, 1.9);
    const captures = draw.mock.calls.length;
    tick(a, 2.1);
    expect(draw).toHaveBeenCalledTimes(captures);
    expect(canvas.style.opacity).toBe('1');
    ready(b);
    expect(canvas.style.opacity).toBe('1');
    expect(draw).toHaveBeenCalledTimes(captures + 1);
  });

  it('ignores a rejected play promise from the previous clip', async () => {
    let rejectOld!: (reason: Error) => void;
    vi.spyOn(a, 'play').mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    start();
    ready(b);
    tick(a, 2);
    rejectOld(new DOMException('superseded', 'AbortError'));
    await Promise.resolve();
    expect(visible(b)).toBe(true);
    expect(callbacks.stopped).not.toHaveBeenCalled();
    expect(b.muted).toBe(false);
  });

  it('reports a failure from the current play request and can retry', async () => {
    vi.spyOn(a, 'play').mockRejectedValueOnce(new Error('decode'));
    start();
    await Promise.resolve();
    expect(callbacks.stopped).toHaveBeenCalledOnce();
    expect(callbacks.error).toHaveBeenCalledOnce();
    playback.setPlaying(true);
    ready(b);
    expect(visible(b)).toBe(true);
  });

  it('does not resume audio when loading finishes after pause', () => {
    start();
    tick(a, 2);
    playback.setPlaying(false);
    const playB = vi.spyOn(b, 'play');
    ready(b);
    expect(visible(b)).toBe(true);
    expect(playB).not.toHaveBeenCalled();
    expect(a.muted && b.muted).toBe(true);
    playback.setPlaying(true);
    expect(playB).toHaveBeenCalledOnce();
  });

  it('isolates rapid seeks and callbacks delivered after cancellation', () => {
    const fb = frames(b);
    start();
    ready(b);
    playback.seek(2500);
    playback.seek(700);
    ready(b);
    fb.cancelled.forEach((callback) =>
      callback(0, { mediaTime: 0.5 } as VideoFrameCallbackMetadata),
    );
    expect(visible(a)).toBe(true);
    fb.deliver(0.7);
    expect(visible(b)).toBe(true);
    expect(b.src).toContain('/a.mp4');
    expect(b.currentTime).toBe(0.7);
  });

  it('handles ended, retains the last frame, and replays from the beginning', () => {
    start();
    ready(b);
    event(a, 'ended');
    expect(visible(b)).toBe(true);
    event(b, 'ended');
    expect(callbacks.time).toHaveBeenLastCalledWith(4000);
    expect(callbacks.stopped).toHaveBeenCalledOnce();
    expect(visible(b)).toBe(true);
    playback.setPlaying(true);
    ready(a);
    expect(a.currentTime).toBe(0);
    expect(visible(a)).toBe(true);
  });

  it('keeps the old frame silent while a source URL is still unavailable', () => {
    start();
    playback.configure([clip('a'), clip('b')], { a: sources.a }, []);
    playback.seek(2000);
    playback.setPlaying(false);
    playback.setPlaying(true);
    expect(a.muted && b.muted).toBe(true);
    playback.configure([clip('a'), clip('b')], sources, []);
    ready(b);
    expect(visible(b)).toBe(true);
  });

  it('defers a preload error and reports an unavailable target without clearing the old frame', () => {
    start();
    event(b, 'error');
    expect(callbacks.error).not.toHaveBeenCalled();
    playback.configure([clip('a'), clip('b', 'b', 500, 2500)], sources, ['b']);
    playback.seek(2000);
    expect(visible(a)).toBe(true);
    expect(callbacks.error).toHaveBeenCalledWith(expect.stringContaining('不可用'));
  });

  it('releases both sources and listeners when cleared or disposed', async () => {
    let rejectOld!: (error: Error) => void;
    vi.spyOn(a, 'play').mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject;
        }),
    );
    start();
    playback.configure([], {}, []);
    expect(a.getAttribute('src')).toBeNull();
    expect(b.getAttribute('src')).toBeNull();
    expect(visible(a) || visible(b)).toBe(false);
    playback.dispose();
    rejectOld(new Error('old'));
    event(a, 'error');
    await Promise.resolve();
    expect(callbacks.error).not.toHaveBeenCalled();
  });
});
