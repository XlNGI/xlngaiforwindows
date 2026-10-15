import { describe, expect, it } from 'vitest';
import { validateSessionRequestParams } from './request-validation.js';

describe('scene cast RPC validation', () => {
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
    { dialogueAudioId: 3 },
  ])('rejects malformed scene bindings %j', (value) => {
    expect(() => validateSessionRequestParams('scene.save', { title: '场次', ...value })).toThrow();
  });
});
