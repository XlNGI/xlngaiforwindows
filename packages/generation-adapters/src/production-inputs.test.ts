import { describe, expect, it } from 'vitest';
import { seedProductionInputs, supportsProductionAudioUpload } from '@ai-video/contracts';
import { getAdapterCatalog, validateAdapterParameters } from './index.js';
const model = (contractId: string, capability = 'REFERENCE_TO_VIDEO') =>
  getAdapterCatalog().adapters.find(
    (a) =>
      a.contractId === contractId && a.capability === capability && a.provider !== 'unicompapi',
  )!;
describe('canonical production input projection', () => {
  it.each(['cn.qwen.wan3-0-video', 'cn.bytedance.seedance2-0.video', 'cn.minimax.h3.video'])(
    'projects references and preserves manual audio for %s',
    (id) => {
      const adapter = model(id);
      const original = seedProductionInputs(
        adapter,
        { duration: 8, ratio: '16:9', resolution: id.includes('minimax') ? '2K' : '720p' },
        '人物走入庭院',
        [
          { url: 'https://example.com/actor.png', role: 'character' },
          { url: 'https://example.com/scene.png', role: 'scene' },
        ],
      );
      expect(original).not.toHaveProperty('images');
      expect(JSON.stringify(original)).toContain('actor.png');
      expect(JSON.stringify(original)).toContain('scene.png');
      const serialized = structuredClone(original);
      if (adapter.parameterSchema.properties.media)
        serialized.media = [
          ...(serialized.media as []),
          { type: 'reference_audio', url: 'https://example.com/voice.wav' },
        ];
      else
        serialized.content = [
          ...(serialized.content as []),
          {
            type: 'audio_url',
            role: 'reference_audio',
            audio_url: { url: 'https://example.com/voice.wav' },
          },
        ];
      const changed = seedProductionInputs(adapter, serialized, '新的画面', [
        { url: 'https://example.com/new.png', role: 'reference' },
      ]);
      expect(JSON.stringify(changed)).not.toContain('actor.png');
      expect(JSON.stringify(changed)).toContain('voice.wav');
      // Case normalization belongs to output parameter compilation; the projector preserves form values.
      if (id.includes('wan')) changed.resolution = '720P';
      expect(validateAdapterParameters(adapter.key, changed).valid).toBe(true);
    },
  );
  it('selects the explicit first frame while preserving the meaning of character boards', () => {
    const adapter = getAdapterCatalog().adapters.find(
      (a) => a.contractId === 'cn.happyhorse.1.1.i2v',
    )!;
    const inputs = [
      { url: 'asset://board', role: 'character' as const },
      { url: 'asset://location', role: 'scene' as const },
      { url: 'asset://frame', role: 'first-frame' as const },
    ];
    expect(seedProductionInputs(adapter, {}, '画面', inputs).images).toEqual([
      'project-asset://frame',
    ]);
    expect(
      validateAdapterParameters(adapter.key, seedProductionInputs(adapter, {}, '画面', inputs))
        .valid,
    ).toBe(true);
    expect(() => seedProductionInputs(adapter, {}, '画面', inputs.slice(0, 2))).toThrow(
      '不能自动当作首帧',
    );
  });
  it('distinguishes identical model schemas on channels with different audio upload support', () => {
    const official = model('cn.qwen.wan3-0-video');
    const gateway = getAdapterCatalog().adapters.find(
      (a) =>
        a.contractId === official.contractId &&
        a.contractRevision === 3 &&
        a.provider === 'unicompapi',
    )!;
    expect(supportsProductionAudioUpload(official)).toBe(true);
    expect(supportsProductionAudioUpload(gateway)).toBe(false);
  });
});
