import { describe, expect, it } from 'vitest';
import {
  currentMediaModelBinding,
  officialVideoAudioContracts,
  seedProductionInputs,
  supportsProductionAudioUpload,
  productionFrameInputConflict,
  resolveProductionFrameInputs,
  addProductionImageBindings,
  type AdapterParameterValue,
} from '@ai-video/contracts';
import { adapterBindsCatalogModel, getAdapter, validateAdapterParameters } from './index.js';

describe('UniComp Seedance bindings', () => {
  it.each(['cn.bytedance.seedance2-0.video', 'cn.bytedance.seedance2-5.video'])(
    'preserves character, scene and first frame for %s and validates each explicit resolution',
    (id) => {
      const adapter = getAdapter(`IMAGE_TO_VIDEO:unicompapi:${id}:contract-2`)!;
      const bindings = [
        { assetId: 'actor', role: 'character' as const, label: '林澈' },
        { assetId: 'scene', role: 'scene' as const, label: '旧码头' },
        { assetId: 'frame', role: 'first-frame' as const },
      ];
      const initial = addProductionImageBindings(
        adapter,
        seedProductionInputs(
          adapter,
          { duration: 5 },
          '雨中回头',
          bindings.map((image) => ({ ...image, url: `project-asset://${image.assetId}` })),
        ),
        bindings,
      );
      expect(
        (initial.content as { role?: string }[])
          .filter((item) => item.role)
          .map((item) => item.role),
      ).toEqual(['reference_image', 'reference_image', 'first_frame']);
      expect(validateAdapterParameters(adapter.key, initial).valid).toBe(false);
      expect(productionFrameInputConflict(adapter, initial)).toMatchObject({
        canUseReferences: true,
        firstFrameIndex: 2,
      });
      for (const choice of ['references', 'first-frame'] as const) {
        const resolved = addProductionImageBindings(
          adapter,
          resolveProductionFrameInputs(adapter, initial, choice),
          bindings,
        );
        expect(validateAdapterParameters(adapter.key, resolved)).toEqual({
          valid: true,
          errors: [],
        });
        expect(productionFrameInputConflict(adapter, resolved)).toBeUndefined();
        const content = resolved.content as {
          role?: string;
          text?: string;
          image_url?: { url: string };
        }[];
        expect(content.filter((item) => item.image_url).map((item) => item.image_url?.url)).toEqual(
          choice === 'references'
            ? ['project-asset://actor', 'project-asset://scene', 'project-asset://frame']
            : ['project-asset://frame'],
        );
        expect(content[0]?.text).toContain(
          choice === 'references' ? '开场构图参考（不锁定首帧）' : '本镜视频的首帧',
        );
      }
    },
  );
  it.each([
    ['cn.bytedance.seedance2-0.video', 'doubao-seedance-2-0-260128', 15],
    ['cn.bytedance.seedance2-5.video', 'doubao-seedance-2-5-260628', 30],
  ] as const)('uses the canonical %s contract for all four production modes', (id, model, max) => {
    expect(currentMediaModelBinding('unicompapi', model)).toMatchObject({
      contractId: id,
      contractRevision: 2,
      protocol: 'openai-compatible-video',
      compatibility: 'partial',
      inputTransport: { audio: 'url-only' },
    });
    for (const mode of [
      'TEXT_TO_VIDEO',
      'IMAGE_TO_VIDEO',
      'REFERENCE_TO_VIDEO',
      'START_END_TO_VIDEO',
    ]) {
      const adapter = getAdapter(`${mode}:unicompapi:${id}:contract-2`)!;
      expect(adapter).toBeDefined();
      expect(
        adapterBindsCatalogModel(adapter, { providerType: 'unicompapi', remoteModelId: model }),
      ).toBe(true);
      expect(supportsProductionAudioUpload(adapter)).toBe(false);
      const images =
        mode === 'TEXT_TO_VIDEO'
          ? []
          : [
              { url: 'project-asset://first', role: 'first-frame' as const },
              ...(mode === 'START_END_TO_VIDEO'
                ? [{ url: 'project-asset://last', role: 'last-frame' as const }]
                : []),
            ];
      const parameters = seedProductionInputs(adapter, { duration: max }, '人物走进雨中', images);
      expect(validateAdapterParameters(adapter.key, parameters)).toEqual({
        valid: true,
        errors: [],
      });
      expect(
        validateAdapterParameters(adapter.key, { ...parameters, duration: max + 1 }).valid,
      ).toBe(false);
      expect(validateAdapterParameters(adapter.key, { ...parameters, duration: '7' }).valid).toBe(
        false,
      );
      expect(validateAdapterParameters(adapter.key, { ...parameters, duration: -1 }).valid).toBe(
        true,
      );
    }
    const reference = getAdapter(`REFERENCE_TO_VIDEO:unicompapi:${id}:contract-2`)!;
    const content: AdapterParameterValue[] = [
      { type: 'image_url', image_url: { url: 'asset://actor' }, role: 'reference_image' },
      {
        type: 'audio_url',
        audio_url: { url: 'https://example.com/voice.wav' },
        role: 'reference_audio',
      },
      {
        type: 'video_url',
        video_url: { url: 'https://example.com/reference.mp4' },
        role: 'reference_video',
      },
      { type: 'text', text: '参考音频1的音色' },
    ];
    expect(validateAdapterParameters(reference.key, { content, generate_audio: true }).valid).toBe(
      true,
    );
    expect(
      validateAdapterParameters(reference.key, { content, draft: true, resolution: '480p' }).valid,
    ).toBe(max === 30);
    const canonical = officialVideoAudioContracts.find(
      (c) => c.contractId === id && c.contractRevision === 2,
    )!;
    expect(Object.keys(reference.parameterSchema.properties)).toEqual(
      Object.keys(canonical.parameterSchema.properties as object),
    );
  });
});
