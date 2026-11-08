import type { RoughCutClip } from '@ai-video/contracts';
import { clipLength, locateTimeline, sequenceLength } from './timeline-model';

type Point = NonNullable<ReturnType<typeof locateTimeline>>;
interface Slot {
  video: HTMLVideoElement;
  point?: Point;
  source?: string;
  targetMs: number;
  ready: boolean;
  failed: boolean;
  release: () => void;
}
interface Callbacks {
  time: (timeMs: number) => void;
  stopped: () => void;
  waiting: (waiting: boolean) => void;
  error: (message: string) => void;
}

/** Decode in two slots and publish only confirmed frames to the preview surface. */
export class RoughCutPlayback {
  private slots: Slot[];
  private clips: RoughCutClip[] = [];
  private sources: Record<string, string> = {};
  private unavailable: string[] = [];
  private signature = '';
  private active?: Slot;
  private pending?: Slot;
  private timeMs = 0;
  private playing = false;
  private waitingForFrame = false;
  private disposed = false;
  private playEpoch = 0;
  private cancelTick?: () => void;
  private hasHeldFrame = false;

  constructor(
    videos: HTMLVideoElement[],
    private callbacks: Callbacks,
    private heldFrame?: HTMLCanvasElement,
  ) {
    this.slots = videos.map((video) => ({
      video,
      targetMs: 0,
      ready: false,
      failed: false,
      release: () => undefined,
    }));
    for (const slot of this.slots) this.show(slot, false);
  }

  configure(clips: RoughCutClip[], sources: Record<string, string>, unavailable: string[]) {
    const signature = JSON.stringify([
      clips.map((clip) => [
        clip.id,
        clip.assetId,
        clip.contentHash,
        clip.inMs,
        clip.outMs,
        clip.muted,
        clip.fit,
        clip.fps,
      ]),
      unavailable,
    ]);
    const changed = signature !== this.signature;
    this.clips = clips;
    this.sources = sources;
    this.unavailable = unavailable;
    this.signature = signature;
    const point = locateTimeline(clips, this.timeMs);
    if (changed || !this.active || this.active.source !== (point && sources[point.clip.assetId])) {
      this.seek(this.timeMs);
    } else this.preloadNext();
  }

  seek(timeMs: number) {
    if (this.disposed) return;
    this.stopDecoders();
    this.hold(true);
    this.timeMs = Math.max(0, Math.min(sequenceLength(this.clips), timeMs));
    this.pending = undefined;
    this.waitingForFrame = true;
    const point = locateTimeline(this.clips, this.timeMs);
    if (!point) {
      this.active = undefined;
      this.hasHeldFrame = false;
      this.hold(false);
      this.waitingForFrame = false;
      for (const slot of this.slots) {
        slot.release();
        slot.point = undefined;
        slot.source = undefined;
        slot.ready = false;
        slot.video.removeAttribute('src');
        slot.video.load();
        this.show(slot, false);
      }
      this.callbacks.waiting(false);
      return;
    }
    const source = this.sources[point.clip.assetId];
    this.callbacks.waiting(true);
    if (this.unavailable.includes(point.clip.id)) {
      this.fail('来源视频不可用，请检查源文件。');
      return;
    }
    if (!source) return;
    // At the sequence endpoint retain the final decodable frame, never seek to EOF.
    const targetMs = Math.min(
      point.clip.outMs - 0.001,
      point.clip.inMs + Math.max(0, this.timeMs - point.startMs),
    );
    const slot = this.slots.find((item) => item !== this.active)!;
    this.pending = slot;
    if (
      slot.point?.clip.id === point.clip.id &&
      slot.source === source &&
      Math.abs(slot.targetMs - targetMs) < 0.001 &&
      !slot.failed
    ) {
      slot.point = point;
      slot.video.style.objectFit = point.clip.fit;
      if (slot.ready) this.activate(slot);
      return;
    }
    this.prepare(slot, point, targetMs, source);
  }

  setPlaying(playing: boolean) {
    if (this.disposed || this.playing === playing) return;
    this.playing = playing;
    this.stopDecoders();
    if (!playing) return;
    if (this.timeMs >= sequenceLength(this.clips)) this.seek(0);
    else if (this.waitingForFrame) this.seek(this.timeMs);
    else if (this.active && !this.waitingForFrame) this.play(this.active);
  }

  private show(slot: Slot, visible: boolean) {
    slot.video.style.opacity = visible && !this.hasHeldFrame ? '1' : '0';
    slot.video.style.zIndex = visible ? '1' : '0';
    slot.video.setAttribute('aria-hidden', String(!visible));
  }

  private stopDecoders() {
    this.playEpoch++;
    this.cancelTick?.();
    this.cancelTick = undefined;
    for (const slot of this.slots) {
      slot.video.pause();
      slot.video.muted = true;
    }
  }

  private hold(visible: boolean) {
    if (this.heldFrame) this.heldFrame.style.opacity = visible && this.hasHeldFrame ? '1' : '0';
  }

  private capture(slot: Slot, sourceMs?: number) {
    const canvas = this.heldFrame;
    const { video } = slot;
    if (!canvas || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
    // Without frame timestamps, the media clock can lag a newly decoded frame.
    // Retain the previous valid picture near the out point rather than publishing it.
    if (
      sourceMs !== undefined &&
      typeof video.requestVideoFrameCallback !== 'function' &&
      slot.point &&
      sourceMs + 1000 / (slot.point.clip.fps || 24) >= slot.point.clip.outMs
    )
      return;
    const scale = Math.min(1, 1280 / video.videoWidth, 720 / video.videoHeight);
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) return;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    try {
      context.drawImage(video, 0, 0, width, height);
      canvas.style.objectFit = slot.point?.clip.fit ?? 'contain';
      this.hasHeldFrame = true;
      slot.video.style.opacity = '0';
      this.hold(true);
    } catch {
      /* Keep the last successfully decoded frame during decoder teardown. */
    }
  }

  private prepare(slot: Slot, point: Point, targetMs: number, source: string) {
    slot.release();
    slot.video.pause();
    slot.video.muted = true;
    this.show(slot, false);
    slot.point = point;
    slot.source = source;
    slot.targetMs = targetMs;
    slot.ready = false;
    slot.failed = false;
    slot.video.style.objectFit = point.clip.fit;
    const video = slot.video;
    let cancelled = false;
    let positioned = false;
    let frame: number | undefined;
    let presentedTime: number | undefined;
    const valid = () => !cancelled && !this.disposed;
    const atTarget = () =>
      positioned &&
      !video.seeking &&
      video.readyState >= 2 &&
      Math.abs(video.currentTime * 1000 - targetMs) < 2;
    const ready = () => {
      if (!valid() || slot.ready || !atTarget()) return;
      if (frame !== undefined) video.cancelVideoFrameCallback(frame);
      frame = undefined;
      slot.ready = true;
      if (this.pending === slot) this.activate(slot);
    };
    const frameReady = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      frame = undefined;
      if (!valid()) return;
      // A seek may finish between callbacks. Reject a frame from the previous position.
      presentedTime = metadata.mediaTime * 1000;
      if (targetFramePresented()) ready();
      if (!slot.ready) frame = video.requestVideoFrameCallback(frameReady);
    };
    const targetFramePresented = () =>
      presentedTime !== undefined &&
      presentedTime <= targetMs + 2 &&
      presentedTime >= targetMs - 1000 / (point.clip.fps || 24) - 2;
    const position = () => {
      if (!valid() || positioned || video.readyState < 1) return;
      positioned = true;
      if (typeof video.requestVideoFrameCallback === 'function')
        frame = video.requestVideoFrameCallback(frameReady);
      if (Math.abs(video.currentTime * 1000 - targetMs) >= 0.001)
        video.currentTime = targetMs / 1000;
      else if (typeof video.requestVideoFrameCallback !== 'function') ready();
    };
    const data = () => {
      position();
      // Older WebViews: loadeddata/seeked + HAVE_CURRENT_DATA are the frame readiness gate.
      if (typeof video.requestVideoFrameCallback !== 'function' || targetFramePresented()) ready();
    };
    const error = () => {
      if (!valid()) return;
      slot.failed = true;
      if (this.pending === slot || this.active === slot)
        this.fail('视频预览失败，请检查源文件或编码。');
    };
    const tick = () => {
      if (valid() && typeof video.requestVideoFrameCallback !== 'function') this.advance(slot);
    };
    const ended = () => {
      if (valid()) this.advance(slot, true);
    };
    video.addEventListener('loadedmetadata', position);
    video.addEventListener('loadeddata', data);
    video.addEventListener('seeked', data);
    video.addEventListener('canplay', data);
    video.addEventListener('error', error);
    video.addEventListener('timeupdate', tick);
    video.addEventListener('ended', ended);
    slot.release = () => {
      cancelled = true;
      if (frame !== undefined) video.cancelVideoFrameCallback(frame);
      video.removeEventListener('loadedmetadata', position);
      video.removeEventListener('loadeddata', data);
      video.removeEventListener('seeked', data);
      video.removeEventListener('canplay', data);
      video.removeEventListener('error', error);
      video.removeEventListener('timeupdate', tick);
      video.removeEventListener('ended', ended);
    };
    video.src = source;
    video.load();
  }

  private activate(slot: Slot) {
    if (this.disposed || this.pending !== slot || !slot.ready) return;
    this.stopDecoders();
    this.active = slot;
    this.pending = undefined;
    this.waitingForFrame = false;
    for (const item of this.slots) this.show(item, item === slot);
    this.capture(slot);
    this.hold(true);
    this.callbacks.waiting(false);
    if (this.playing) this.play(slot);
    this.preloadNext();
  }

  private continuous(first: RoughCutClip, next: RoughCutClip) {
    return (
      first.assetId === next.assetId &&
      first.outMs === next.inMs &&
      this.sources[first.assetId] === this.sources[next.assetId] &&
      !this.unavailable.includes(next.id)
    );
  }

  private preloadNext() {
    if (!this.active?.point || this.waitingForFrame) return;
    let index = this.active.point.index;
    let startMs = this.active.point.startMs;
    while (this.clips[index + 1] && this.continuous(this.clips[index]!, this.clips[index + 1]!)) {
      startMs += clipLength(this.clips[index]!);
      index++;
    }
    const clip = this.clips[index + 1];
    if (!clip || this.unavailable.includes(clip.id) || !this.sources[clip.assetId]) return;
    startMs += clipLength(this.clips[index]!);
    const slot = this.slots.find((item) => item !== this.active)!;
    if (
      slot.point?.clip.id === clip.id &&
      slot.source === this.sources[clip.assetId] &&
      slot.targetMs === clip.inMs
    )
      return;
    this.prepare(slot, { clip, index: index + 1, startMs }, clip.inMs, this.sources[clip.assetId]!);
  }

  private play(slot: Slot) {
    if (!slot.point || !slot.ready || !this.playing) return;
    const epoch = ++this.playEpoch;
    slot.video.muted = slot.point.clip.muted;
    void slot.video.play().catch(() => {
      if (!this.disposed && epoch === this.playEpoch && this.active === slot && this.playing)
        this.fail('视频播放失败，请重试或检查源文件。');
    });
    this.schedule(slot);
  }

  private schedule(slot: Slot) {
    this.cancelTick?.();
    if (!this.playing || this.active !== slot || this.waitingForFrame || this.disposed) return;
    const tick = (_now?: number, metadata?: VideoFrameCallbackMetadata) => {
      this.cancelTick = undefined;
      this.advance(slot, false, metadata ? metadata.mediaTime * 1000 : undefined);
      if (this.active === slot && !this.waitingForFrame && this.playing) this.schedule(slot);
    };
    if (typeof slot.video.requestVideoFrameCallback === 'function') {
      const id = slot.video.requestVideoFrameCallback(tick);
      this.cancelTick = () => slot.video.cancelVideoFrameCallback(id);
    } else {
      const id = requestAnimationFrame(tick);
      this.cancelTick = () => cancelAnimationFrame(id);
    }
  }

  private advance(slot: Slot, ended = false, presentedMs?: number) {
    if (
      this.disposed ||
      !this.playing ||
      this.waitingForFrame ||
      this.active !== slot ||
      !slot.point
    )
      return;
    const sourceMs = presentedMs ?? slot.video.currentTime * 1000;
    while (sourceMs >= slot.point.clip.outMs || ended) {
      const clip: RoughCutClip = slot.point.clip;
      const index: number = slot.point.index;
      const startMs: number = slot.point.startMs;
      const end: number = startMs + clipLength(clip);
      const next: RoughCutClip | undefined = this.clips[index + 1];
      if (!next) {
        this.timeMs = sequenceLength(this.clips);
        this.playing = false;
        this.stopDecoders();
        this.hold(true);
        this.callbacks.time(this.timeMs);
        this.callbacks.stopped();
        return;
      }
      if (!ended && this.continuous(clip, next)) {
        slot.point = { clip: next, index: index + 1, startMs: end };
        slot.video.style.objectFit = next.fit;
        slot.video.muted = next.muted;
      } else {
        this.seek(end);
        this.callbacks.time(end);
        return;
      }
    }
    this.capture(slot, sourceMs);
    this.timeMs = slot.point.startMs + Math.max(0, sourceMs - slot.point.clip.inMs);
    this.callbacks.time(this.timeMs);
  }

  private fail(message: string) {
    this.playing = false;
    this.waitingForFrame = true;
    this.stopDecoders();
    this.hold(true);
    this.callbacks.waiting(false);
    this.callbacks.stopped();
    this.callbacks.error(message);
  }

  dispose() {
    this.disposed = true;
    this.stopDecoders();
    for (const slot of this.slots) {
      slot.release();
      slot.video.removeAttribute('src');
      slot.video.load();
    }
  }
}
