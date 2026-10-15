import { describe, expect, it } from 'vitest';
import type { AdapterParameterValue, CharacterVoiceReferenceInfo } from '@ai-video/contracts';
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
  it('clears removed scene images while retaining a manually entered audio input', () => {
    for (const provider of ['wan-video', 'seedance-video', 'minimax-video']) {
      const adapter = {
        provider,
        contractId: 'reference',
        capability: 'REFERENCE_TO_VIDEO' as const,
      };
      const initial = seedOfficialVideoParameters(adapter, {}, '对白', ['asset://old']);
      const audio: AdapterParameterValue =
        provider === 'wan-video'
          ? { type: 'reference_audio', url: 'https://example.com/audio.wav' }
          : {
              type: 'audio_url',
              audio_url: { url: 'https://example.com/audio.wav' },
              role: 'reference_audio',
            };
      const field = provider === 'wan-video' ? 'media' : 'content';
      initial[field] = [...(Array.isArray(initial[field]) ? initial[field] : []), audio];
      const result = seedOfficialVideoParameters(adapter, initial, '新版对白', [], true);
      expect(JSON.stringify(result)).not.toContain('project-asset://old');
      expect(result[field]).toContainEqual(audio);
    }
  });

  it('numbers images from the actual reordered request and voices from the selected cast order', () => {
    const second = {
      ...voices[0]!,
      characterDocumentId: 'second',
      characterName: '配角',
      versionId: 'version-2',
    };
    const adapter = {
      provider: 'wan-video',
      contractId: 'cn.qwen.wan3-0-video',
      capability: 'REFERENCE_TO_VIDEO' as const,
    };
    const parameters = seedOfficialVideoParameters(adapter, {}, '两人对话', [
      'asset://second-image',
      'asset://room',
      'asset://first-image',
    ]);
    const result = addOfficialRoleVoices(adapter, parameters, [second, voices[0]!], undefined, [
      { id: 'room', role: 'scene', label: '客厅', assetId: 'room', source: 'manual' },
      { id: 'first', role: 'character', label: '主角', assetId: 'first-image', source: 'manual' },
      { id: 'second', role: 'character', label: '配角', assetId: 'second-image', source: 'manual' },
      { id: 'removed', role: 'prop', label: '已移除', assetId: 'removed', source: 'manual' },
    ]);
    expect(result.prompt).toContain('角色「主角」参考图片3');
    expect(result.prompt).toContain('场景「客厅」参考图片2');
    expect(result.prompt).toContain('角色「配角」参考图片1');
    expect(result.prompt).toContain('角色「配角」使用音频1');
    expect(result.prompt).toContain('角色「主角」使用音频2');
    expect(result.prompt).not.toContain('已移除');
    expect(JSON.stringify(result)).toContain('character-voice://second/version-2');
    expect(parameters.prompt).toBe('两人对话');
  });
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
    const labelled = addOfficialRoleVoices(
      driving,
      { prompt: '对白', media: [{ type: 'first_frame', url: 'asset://frame' }] },
      [],
      'dialogue',
      [{ id: 'actor', role: 'character', label: '主角', assetId: 'frame', source: 'manual' }],
    );
    expect(labelled.prompt).toContain('角色「主角」参考图片1');
  });
});
