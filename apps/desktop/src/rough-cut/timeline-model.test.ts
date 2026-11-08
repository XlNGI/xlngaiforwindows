import { describe, expect, it } from 'vitest';
import type { RoughCutClip } from '@ai-video/contracts';
import { assetDropIds, locateTimeline, moveClip, splitClip } from './timeline-model';

const clip: RoughCutClip = {
  id: 'one',
  assetId: 'video',
  contentHash: 'hash',
  name: '镜头',
  durationMs: 4000,
  width: 1920,
  height: 1080,
  hasAudio: true,
  inMs: 1000,
  outMs: 3000,
  muted: true,
  fit: 'contain',
};
describe('rough cut timeline operations', () => {
  it('splits the frozen source range and locates boundaries without losing audio settings', () => {
    const split = splitClip([clip], 750, 'two');
    expect(split.map((item) => [item.inMs, item.outMs, item.muted])).toEqual([
      [1000, 1750, true],
      [1750, 3000, true],
    ]);
    expect(locateTimeline(split, 750)?.clip.id).toBe('two');
    expect(splitClip([clip], 10, 'short')).toEqual([clip]);
    expect(splitClip([clip], 2000, 'empty')).toEqual([clip]);
  });
  it('reorders existing cuts without changing source intervals or silently duplicating clips', () => {
    const clips = [clip, { ...clip, id: 'two' }, { ...clip, id: 'three' }];
    expect(moveClip(clips, 'one', 'three').map((item) => item.id)).toEqual(['two', 'one', 'three']);
    expect(moveClip(clips, 'one').map((item) => item.id)).toEqual(['two', 'three', 'one']);
    expect(moveClip(clips, 'one', 'one')).toBe(clips);
    expect(clips[0]?.inMs).toBe(1000);
  });
  it('accepts current-project video snapshots and rejects mixed or foreign drops', () => {
    const payload = { version: 1, projectId: 'p', assets: [{ id: 'a', kind: 'scene-video' }] };
    expect(assetDropIds(JSON.stringify(payload), 'p')).toEqual(['a']);
    expect(() => assetDropIds(JSON.stringify(payload), 'other')).toThrow('当前项目');
    expect(() =>
      assetDropIds(
        JSON.stringify({ ...payload, assets: [{ id: 'a', kind: 'generated-image' }] }),
        'p',
      ),
    ).toThrow('只接收视频');
    expect(() => assetDropIds('{}', 'p')).toThrow();
  });
});
