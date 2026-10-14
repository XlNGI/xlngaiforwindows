import { describe, expect, it } from 'vitest';
import type { CharacterVoiceReferenceInfo } from '@ai-video/contracts';
import { addOfficialRoleVoices, seedOfficialVideoParameters } from './official-video-parameters';

const voices = [
  {
    id: 'voice',
    projectId: 'project',
    characterDocumentId: 'actor',
    characterName: '主角',
    versionId: 'version-1',
    revision: 1,
    rowVersion: 1,
    audioId: 'audio',
    audioName: '样本',
    durationMs: 3000,
    sizeBytes: 100,
    mime: 'audio/wav',
  },
] satisfies CharacterVoiceReferenceInfo[];
describe('official production input assembly', () => {
  it.each([
    ['wan-video', 'cn.qwen.wan3-0-video', 3],
    ['seedance-video', 'cn.bytedance.seedance2-5.video', 2],
    ['minimax-video', 'cn.minimax.h3.video', 2],
  ] as const)(
    'seeds %s inputs and adds a frozen role voice version',
    (provider, contract, revision) => {
      const adapter = { provider, contractId: contract, capability: 'TEXT_TO_VIDEO' as const };
      expect(revision).toBeGreaterThan(0);
      const seeded = seedOfficialVideoParameters(adapter, {}, '主角说你好', ['asset://image']);
      const result = addOfficialRoleVoices(adapter, seeded, voices);
      expect(JSON.stringify(result)).toContain('character-voice://actor/version-1');
      expect(JSON.stringify(result)).toContain('音频1');
      expect(result).not.toHaveProperty('images');
      if (provider !== 'wan-video') expect(result).not.toHaveProperty('prompt');
    },
  );
  it('refuses incompatible strict frames and distinguishes driving audio', () => {
    const reference = {
      provider: 'minimax-video',
      contractId: 'cn.minimax.h3.video',
      capability: 'REFERENCE_TO_VIDEO' as const,
    };
    expect(() =>
      addOfficialRoleVoices(
        reference,
        {
          content: [
            {
              type: 'image_url',
              image_url: { url: 'https://example.com/frame.png' },
              role: 'first_frame',
            },
          ],
        },
        voices,
      ),
    ).toThrow('不能混用');
    const driving = {
      provider: 'wan-video',
      contractId: 'cn.qwen.wan2-7-i2v',
      capability: 'IMAGE_TO_VIDEO' as const,
    };
    expect(
      addOfficialRoleVoices(
        driving,
        { media: [{ type: 'first_frame', url: 'asset://frame' }] },
        [],
        'dialogue',
      ),
    ).toEqual({
      media: [
        { type: 'first_frame', url: 'asset://frame' },
        { type: 'driving_audio', url: 'project-audio://dialogue' },
      ],
    });
  });
});
