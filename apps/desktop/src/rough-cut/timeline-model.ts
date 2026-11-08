import type { RoughCutClip } from '@ai-video/contracts';

export const clipLength = (clip: RoughCutClip) => clip.outMs - clip.inMs;
export const sequenceLength = (clips: RoughCutClip[]) =>
  clips.reduce((sum, clip) => sum + clipLength(clip), 0);
export function locateTimeline(clips: RoughCutClip[], timeMs: number) {
  let startMs = 0;
  for (const [index, clip] of clips.entries()) {
    if (timeMs < startMs + clipLength(clip) || index === clips.length - 1)
      return { clip, index, startMs };
    startMs += clipLength(clip);
  }
  return undefined;
}
export function moveClip(clips: RoughCutClip[], clipId: string, beforeId?: string): RoughCutClip[] {
  const clip = clips.find((item) => item.id === clipId);
  if (!clip || clipId === beforeId) return clips;
  const next = clips.filter((item) => item.id !== clipId);
  const index = beforeId ? next.findIndex((item) => item.id === beforeId) : next.length;
  if (index < 0) return clips;
  next.splice(index, 0, clip);
  return next;
}
export function splitClip(clips: RoughCutClip[], timeMs: number, newId: string): RoughCutClip[] {
  const position = locateTimeline(clips, timeMs);
  if (!position) return clips;
  const offset = Math.round(timeMs - position.startMs);
  if (offset < 34 || clipLength(position.clip) - offset < 34) return clips;
  const split = position.clip.inMs + offset;
  return clips.flatMap((clip) =>
    clip.id !== position.clip.id
      ? [clip]
      : [
          { ...clip, outMs: split },
          { ...clip, id: newId, inMs: split },
        ],
  );
}
export function assetDropIds(serialized: string, projectId: string): string[] {
  const value: unknown = JSON.parse(serialized);
  if (!value || typeof value !== 'object') throw new Error('请从素材库拖入视频。');
  const payload = value as { version?: unknown; projectId?: unknown; assets?: unknown };
  if (payload.version !== 1 || payload.projectId !== projectId)
    throw new Error('只能拖入当前项目的素材。');
  if (!Array.isArray(payload.assets) || !payload.assets.length || payload.assets.length > 200)
    throw new Error('一次最多拖入 200 个视频。');
  return payload.assets.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object') throw new Error('无效的素材拖拽。');
    const asset = raw as { id?: unknown; kind?: unknown };
    if (
      typeof asset.id !== 'string' ||
      !asset.id ||
      typeof asset.kind !== 'string' ||
      !asset.kind.includes('video')
    )
      throw new Error('粗剪目前只接收视频素材。');
    return asset.id;
  });
}
export function timeLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
