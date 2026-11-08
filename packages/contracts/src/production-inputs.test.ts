import { describe, expect, it } from 'vitest';
import type { AdapterDescriptor } from './index.js';
import {
  addProductionAudioBindings,
  addProductionImageBindings,
  productionImageBindingPrompt,
  productionShotReferenceIds,
  productionFrameInputConflict,
  productionImagesFromParameters,
} from './production-inputs.js';

function descriptor(
  properties: AdapterDescriptor['parameterSchema']['properties'],
): AdapterDescriptor {
  return {
    key: 'REFERENCE_TO_IMAGE:test:reference:v1',
    capability: 'REFERENCE_TO_IMAGE',
    capabilityLabel: '参考生图',
    provider: 'test',
    providerLabel: 'Test',
    model: 'reference',
    modelLabel: 'Reference',
    apiVersion: 'v1',
    schemaVersion: 1,
    endpoint: 'https://example.invalid/generate',
    documentationUrl: 'https://example.invalid/docs',
    credentialProvider: 'test',
    parameterSchema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties,
    },
    uiSchema: { fields: [] },
  };
}

describe('production image binding prompts', () => {
  it('projects flat frame inputs according to the selected generation mode', () => {
    const adapter = descriptor({ images: { type: 'array', title: '图片' } });
    const parameters = { images: ['project-asset://first', 'project-asset://last'] };
    expect(productionImagesFromParameters(adapter, parameters).map((image) => image.role)).toEqual([
      'reference',
      'reference',
    ]);
    adapter.capability = 'START_END_TO_VIDEO';
    expect(productionImagesFromParameters(adapter, parameters).map((image) => image.role)).toEqual([
      'first-frame',
      'last-frame',
    ]);
    adapter.capability = 'IMAGE_TO_VIDEO';
    expect(
      productionImagesFromParameters(adapter, { images: parameters.images.slice(0, 1) })[0]?.role,
    ).toBe('first-frame');
  });
  it('does not assume frame/reference exclusivity when the model schema permits mixing', () => {
    const adapter = descriptor({
      media: { type: 'array', title: '素材', items: { type: 'object' } },
    });
    expect(
      productionFrameInputConflict(adapter, {
        media: [
          { type: 'first_frame', url: 'project-asset://frame' },
          { type: 'reference_image', url: 'project-asset://actor' },
        ],
      }),
    ).toBeUndefined();
    adapter.parameterSchema.oneOf = [
      {
        if: {
          properties: { media: { contains: { properties: { type: { const: 'first_frame' } } } } },
        },
        then: {
          properties: {
            media: {
              contains: { properties: { type: { const: 'reference_image' } } },
              maxContains: 0,
            },
          },
        },
      },
      { properties: { media: { type: 'array' } } },
    ];
    expect(
      productionFrameInputConflict(adapter, {
        media: [
          { type: 'first_frame', url: 'project-asset://frame' },
          { type: 'reference_image', url: 'project-asset://actor' },
        ],
      }),
    ).toBeUndefined();
  });
  it('replaces its generated section and removes it when no current bindings remain', () => {
    const first = productionImageBindingPrompt('镜头描述', 2, [
      { imageIndex: 1, role: 'character', label: '林澈' },
      { imageIndex: 2, role: 'scene', label: '旧码头' },
    ]);
    const updated = productionImageBindingPrompt(first, 2, [
      { imageIndex: 2, role: 'character', label: '林澈' },
    ]);

    expect(updated).toBe(
      '镜头描述\n\n【输入图片说明】（本段传入2张参考图）：\n图片2为角色「林澈」的角色参考图。',
    );
    expect(productionImageBindingPrompt(updated, 2, [])).toBe('镜头描述');
  });

  it('maps character and scene bindings by their final media order and drops removed images', () => {
    const adapter = descriptor({
      prompt: { type: 'string', title: '提示词' },
      media: { type: 'array', title: '输入素材', items: { type: 'object' } },
    });
    const bindings = [
      { assetId: 'character', role: 'character' as const, label: '林澈' },
      { assetId: 'scene', role: 'scene' as const, label: '旧码头' },
    ];
    const parameters = addProductionImageBindings(
      adapter,
      {
        prompt: '雨夜里回头',
        media: [
          { type: 'reference_image', url: 'asset://scene' },
          { type: 'reference_image', url: 'project-asset://character' },
        ],
      },
      bindings,
    );
    expect(parameters.prompt).toContain('图片2为角色「林澈」的角色参考图。');
    expect(parameters.prompt).toContain('图片1为场景「旧码头」的场景参考图。');

    const removed = addProductionImageBindings(
      adapter,
      { ...parameters, media: [{ type: 'reference_image', url: 'project-asset://scene' }] },
      bindings,
    );
    expect(removed.prompt).not.toContain('角色「林澈」');
    expect(removed.prompt).toContain('图片1为场景「旧码头」的场景参考图。');
  });

  it('updates structured content text without changing nested image objects', () => {
    const adapter = descriptor({
      content: { type: 'array', title: '内容', items: { type: 'object' } },
    });
    const image = {
      type: 'image_url',
      image_url: { url: 'project-asset://character' },
      role: 'reference_image',
    };
    const parameters = addProductionImageBindings(
      adapter,
      { content: [image, { type: 'text', text: '站在雨中。', note: 'keep' }] },
      [{ assetId: 'character', role: 'character', label: '林澈' }],
    );

    expect(parameters.content).toEqual([
      image,
      {
        type: 'text',
        text: '站在雨中。\n\n【输入图片说明】（本段传入1张参考图）：\n图片1为角色「林澈」的角色参考图。',
        note: 'keep',
      },
    ]);
  });
});

describe('production shot reference IDs', () => {
  it('uses each explicit IR list and falls back to durable shot bindings only when omitted', () => {
    expect(
      productionShotReferenceIds({
        authoringIR: {
          schemaVersion: 1,
          kind: 'shot',
          prompt: '角色回头。',
          references: { characterDocumentIds: [], sceneDocumentIds: ['location'] },
        },
        referenceBindings: {
          characterBindings: [{ characterDocumentId: 'legacy-character', assetId: 'image-1' }],
          sceneBindings: [{ sourceDocumentId: 'legacy-location', assetId: 'image-2' }],
        },
      }),
    ).toEqual({
      characterDocumentIds: [],
      sceneDocumentIds: ['location'],
      propDocumentIds: [],
    });
  });

  it('uses shot-scoped durable bindings for old shots without an IR', () => {
    expect(
      productionShotReferenceIds({
        referenceBindings: {
          characterBindings: [
            { characterDocumentId: 'character', assetId: 'image-1' },
            { characterDocumentId: 'character', assetId: 'image-2' },
          ],
          sceneBindings: [{ sourceDocumentId: 'location', assetId: 'image-3' }],
        },
      }),
    ).toEqual({
      characterDocumentIds: ['character'],
      sceneDocumentIds: ['location'],
      propDocumentIds: [],
    });
  });
});

describe('production audio binding prompts', () => {
  it('shows, replaces, and clears the selected role voice declarations', () => {
    const adapter = descriptor({ prompt: { type: 'string', title: '提示词' } });
    const firstVoice = {
      characterDocumentId: 'actor-one',
      characterName: '林澈',
      versionId: 'voice-one',
    } as import('./index.js').CharacterVoiceReferenceInfo;
    const secondVoice = {
      characterDocumentId: 'actor-two',
      characterName: '江晚',
      versionId: 'voice-two',
    } as import('./index.js').CharacterVoiceReferenceInfo;

    const first = addProductionAudioBindings(adapter, { prompt: '镜头中人物对白' }, [firstVoice]);
    expect(first.prompt).toContain('【输入音频说明】（本段传入1段角色音色参考）：');
    expect(first.prompt).toContain('角色「林澈」使用音频1的音色。');

    const replaced = addProductionAudioBindings(adapter, first, [secondVoice]);
    expect(replaced.prompt).not.toContain('林澈');
    expect(replaced.prompt).toContain('角色「江晚」使用音频1的音色。');

    expect(addProductionAudioBindings(adapter, replaced, []).prompt).toBe('镜头中人物对白');
  });

  it('binds each voice declaration to its character image when final image references are known', () => {
    const adapter = descriptor({ prompt: { type: 'string', title: '提示词' } });
    const voice = {
      characterDocumentId: 'actor-one',
      characterName: '林澈',
      versionId: 'voice-one',
    } as import('./index.js').CharacterVoiceReferenceInfo;

    const result = addProductionAudioBindings(
      adapter,
      { prompt: '两人对话' },
      [voice],
      [{ characterDocumentId: 'actor-one', imageReference: '图 2' }],
    );

    expect(result.prompt).toContain('图 2中的角色「林澈」仅使用音频1的音色。');
  });
});
