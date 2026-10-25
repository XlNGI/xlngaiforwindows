import { describe, expect, it } from 'vitest';
import { validateSessionRequestParams } from './request-validation.js';

describe('scene cast RPC validation', () => {
  it.each(['image.generate.prepare', 'video.generate.prepare'] as const)(
    'validates the IR form source at the %s IPC boundary',
    (method) => {
      const params = {
        adapterKey: 'model',
        providerProfileId: 'profile',
        modelId: 'model',
        parameters: { prompt: '最终表单正文' },
        providerRegion: 'cn',
        productionSource: {
          mode: 'form',
          target: { kind: 'shot', id: 'shot' },
          token: 'a'.repeat(64),
        },
      };
      if (method === 'image.generate.prepare') Reflect.deleteProperty(params, 'providerRegion');
      expect(() => validateSessionRequestParams(method, params)).not.toThrow();
      for (const source of [
        { ...params.productionSource, token: undefined },
        { ...params.productionSource, token: 'invalid' },
        { ...params.productionSource, mode: undefined },
        { ...params.productionSource, instructionId: 'old' },
      ])
        expect(() =>
          validateSessionRequestParams(method, { ...params, productionSource: source }),
        ).toThrow();
      expect(() =>
        validateSessionRequestParams(method, { ...params, productionSource: undefined }),
      ).not.toThrow();
    },
  );
  it('accepts default or disabled media and bounds batch lookups at the RPC boundary', () => {
    expect(() =>
      validateSessionRequestParams('scene.save', {
        title: '场次',
        characterBindings: [
          { characterDocumentId: 'role', imageDisabled: true, voiceDisabled: true },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      validateSessionRequestParams('scene.media.resolve', {
        characterDocumentIds: ['role'],
        assetIds: ['image'],
        voiceVersionIds: ['old'],
      }),
    ).not.toThrow();
    for (const input of [
      { characterDocumentIds: Array.from({ length: 31 }, (_, i) => `role-${i}`) },
      { characterDocumentIds: ['same', 'same'] },
      {
        characterDocumentIds: ['one'],
        assetIds: Array.from({ length: 61 }, (_, i) => `image-${i}`),
      },
      { characterDocumentIds: ['one'], body: 'extra' },
    ])
      expect(() => validateSessionRequestParams('scene.media.resolve', input)).toThrow();
  });
  it('accepts explicit cast, optional media and clearing dialogue', () => {
    expect(() =>
      validateSessionRequestParams('scene.save', {
        title: '场次',
        characterBindings: [
          { characterDocumentId: 'role' },
          {
            characterDocumentId: 'second',
            imageAssetId: 'image',
            voiceReferenceVersionId: 'version',
          },
        ],
        dialogueAudioId: null,
      }),
    ).not.toThrow();
  });
  it.each([
    { characterBindings: [{ characterDocumentId: 'role', audioId: 'wrong-field' }] },
    { characterBindings: [{ imageAssetId: 'image' }] },
    { characterBindings: [{ characterDocumentId: 'role', voiceReferenceVersionId: 3 }] },
    { characterBindings: Array.from({ length: 31 }, () => ({ characterDocumentId: 'role' })) },
    { characterBindings: null },
    { characterBindings: [{ characterDocumentId: 'role', imageDisabled: 'true' }] },
    {
      characterBindings: [
        { characterDocumentId: 'role', imageDisabled: true, imageAssetId: 'image' },
      ],
    },
    { dialogueAudioId: 3 },
  ])('rejects malformed scene bindings %j', (value) => {
    expect(() => validateSessionRequestParams('scene.save', { title: '场次', ...value })).toThrow();
  });
});
