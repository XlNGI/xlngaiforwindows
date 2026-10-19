import { describe, expect, it } from 'vitest';
import {
  officialVideoAudioContracts,
  officialVideoContracts,
  type AdapterDescriptor,
  type AdapterParameterValue,
  type CharacterVoiceReferenceInfo,
} from '@ai-video/contracts';
import { addOfficialRoleVoices, seedOfficialVideoParameters } from './official-video-parameters';

function descriptor(input: {
  provider: string;
  contractId: string;
  capability: AdapterDescriptor['capability'];
  contractRevision?: number;
}): AdapterDescriptor {
  const contractId =
    input.contractId === 'reference'
      ? (
          {
            'wan-video': 'cn.qwen.wan3-0-video',
            'seedance-video': 'cn.bytedance.seedance2-5.video',
            'minimax-video': 'cn.minimax.h3.video',
          } as Record<string, string>
        )[input.provider]!
      : input.contractId;
  const contract = [...officialVideoAudioContracts, ...officialVideoContracts]
    .filter(
      (c) =>
        c.contractId === contractId &&
        (input.contractRevision === undefined || c.contractRevision === input.contractRevision),
    )
    .sort((a, b) => b.contractRevision - a.contractRevision)[0]!;
  return {
    ...input,
    contractId,
    contractRevision: contract.contractRevision,
    parameterSchema: contract.parameterSchema,
  } as unknown as AdapterDescriptor;
}
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
  it('seeds UniComp Wan media without losing a public audio reference or adding empty media', () => {
    const adapter = descriptor({
      provider: 'unicompapi',
      contractId: 'cn.qwen.wan3-0-video',
      contractRevision: 3,
      capability: 'REFERENCE_TO_VIDEO' as const,
    });
    const audio = { type: 'reference_audio', url: 'https://example.com/voice.wav' };
    const parameters = seedOfficialVideoParameters(
      adapter,
      { media: [audio] },
      '说你好',
      ['asset://image'],
      true,
    );
    expect(parameters).toMatchObject({
      prompt: '说你好',
      media: [{ type: 'reference_image', url: 'project-asset://image' }, audio],
    });
    const cleared = seedOfficialVideoParameters(adapter, parameters, undefined, [], true);
    expect(cleared.media).toEqual([audio]);
    expect(seedOfficialVideoParameters(adapter, {}, '无参考文生视频', [], true)).toEqual({
      prompt: '无参考文生视频',
    });
  });
  it('clears removed scene images while retaining a manually entered audio input', () => {
    for (const provider of ['wan-video', 'seedance-video', 'minimax-video']) {
      const adapter = descriptor({
        provider,
        contractId: 'reference',
        capability: 'REFERENCE_TO_VIDEO' as const,
      });
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
    const adapter = descriptor({
      provider: 'wan-video',
      contractId: 'cn.qwen.wan3-0-video',
      contractRevision: 3,
      capability: 'REFERENCE_TO_VIDEO' as const,
    });
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
    expect(result.prompt).toContain('角色「主角」参考图 3');
    expect(result.prompt).toContain('场景「客厅」参考图 2');
    expect(result.prompt).toContain('角色「配角」参考图 1');
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
      const adapter = descriptor({
        provider,
        contractId: contract,
        capability: 'TEXT_TO_VIDEO' as const,
      });
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
    const reference = descriptor({
      provider: 'minimax-video',
      contractId: 'cn.minimax.h3.video',
      capability: 'REFERENCE_TO_VIDEO' as const,
    });
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
    const driving = descriptor({
      provider: 'wan-video',
      contractId: 'cn.qwen.wan2-7-i2v',
      contractRevision: 2,
      capability: 'IMAGE_TO_VIDEO' as const,
    });
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
    expect(labelled.prompt).toContain('角色「主角」参考首帧图');
  });
});
