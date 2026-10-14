import { describe, expect, it } from 'vitest';
import { officialVideoAudioContracts, mediaModelBindings } from '@ai-video/contracts';
import {
  buildOfficialVideoAudioRequest,
  validateOfficialVideoAudioParameters,
  adapterDescriptorFromModelContract,
  getAdapter,
  validateAdapterParameters,
} from './index.js';

const image = 'https://example.com/actor.png';
const audio = 'https://example.com/voice.wav';
const wan = 'cn.qwen.wan3-0-video';
const reference = {
  prompt: '角色说你好，音色参考音频1。',
  media: [
    { type: 'reference_image', url: image },
    { type: 'reference_audio', url: audio },
  ],
  audio: true,
};
const validate = (id: string, params: unknown, revision = 1) =>
  validateOfficialVideoAudioParameters(id, params, revision).valid;

describe('official video audio contracts', () => {
  it.each(officialVideoAudioContracts.map((c) => [c.contractId, c.contractRevision, c] as const))(
    'validates and reproduces the official %s revision %s request sample',
    (id, revision, contract) => {
      const request = contract.transport.samples![0]!.request as Record<string, unknown>;
      const parameters: Record<string, unknown> = {};
      for (const mapping of contract.transport.request) {
        let value: unknown = request;
        for (const part of mapping.to.split('.'))
          value = (value as Record<string, unknown> | undefined)?.[part];
        if (value !== undefined) parameters[mapping.from!] = value;
      }
      expect(validate(id, parameters, revision)).toBe(true);
      expect(buildOfficialVideoAudioRequest(id, parameters, revision)).toEqual(request);
      expect(validate(id, { ...parameters, api_key: 'forbidden' }, revision)).toBe(false);
      expect(contract.source.verificationStatus).toBe('verified');
    },
  );

  it('keeps old UniComp bindings on revision one while official runtime uses the new revision', () => {
    expect(
      mediaModelBindings
        .filter((b) => b.contractId === wan && b.providerType === 'unicompapi')
        .every((b) => b.contractRevision === 1),
    ).toBe(true);
    expect(officialVideoAudioContracts.filter((c) => c.status === 'enabled')).toHaveLength(7);
    expect(
      mediaModelBindings.find(
        (binding) => binding.providerType === 'wan-video' && binding.contractId === wan,
      )?.contractRevision,
    ).toBe(3);
    expect(validate(wan, reference, 1)).toBe(false);
    expect(validate(wan, reference, 2)).toBe(true);
  });

  it('rejects Wan frame/reference mixing, excessive audio, unknown nested fields and wrong wrappers', () => {
    for (const media of [
      [
        { type: 'first_frame', url: image },
        { type: 'reference_audio', url: audio },
      ],
      Array.from({ length: 6 }, () => ({ type: 'reference_audio', url: audio })),
      [{ type: 'reference_audio', url: audio, api_key: 'forbidden' }],
      [{ type: 'driving_audio', url: audio }],
    ])
      expect(validate(wan, { ...reference, media }, 2)).toBe(false);
    expect(validate(wan, { prompt: 'hello', prompt_extend: false }, 2)).toBe(true);
    expect(
      validate(
        wan,
        { media: [{ type: 'file', url: 'https://example.com/script.pdf' }], prompt_extend: false },
        2,
      ),
    ).toBe(false);
    expect(validate(wan, { input: reference }, 2)).toBe(false);
    expect(validate(wan, { prompt: '' }, 2)).toBe(false);
    expect(validate(wan, { media: [{ type: 'last_frame', url: image }] }, 2)).toBe(false);
    expect(buildOfficialVideoAudioRequest(wan, reference, 2)).toEqual({
      model: 'wan3.0-video',
      input: { prompt: reference.prompt, media: reference.media },
      parameters: { audio: true },
    });
  });

  it('separates Wan driving audio from voice reference and accepts only valid source combinations', () => {
    const id = 'cn.qwen.wan2-7-i2v';
    expect(
      validate(id, {
        media: [
          { type: 'first_frame', url: image },
          { type: 'driving_audio', url: audio },
        ],
      }),
    ).toBe(true);
    expect(validate(id, { media: [{ type: 'driving_audio', url: audio }] })).toBe(false);
    expect(
      validate(id, {
        media: [
          { type: 'first_clip', url: 'https://example.com/video.mp4' },
          { type: 'driving_audio', url: audio },
        ],
      }),
    ).toBe(false);
  });

  it('enforces MiniMax modes, model-specific resolutions and file references', () => {
    const content = [
      { type: 'text', text: '你好' },
      { type: 'audio_url', role: 'reference_audio', audio_url: { url: 'mm_file://example-file' } },
    ];
    expect(validate('cn.minimax.h3.video', { content, resolution: '2K', duration: 4 })).toBe(true);
    expect(validate('cn.minimax.h3-max.video', { content, resolution: '2K', duration: 4 })).toBe(
      false,
    );
    expect(
      validate('cn.minimax.h3.video', {
        content: [
          ...content,
          { type: 'image_url', role: 'first_frame', image_url: { url: image } },
        ],
        resolution: '768P',
        duration: 5,
      }),
    ).toBe(false);
    expect(
      validate('cn.minimax.h3.video', {
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image_url', image_url: { url: image } },
          { type: 'image_url', role: 'first_frame', image_url: { url: image } },
        ],
        resolution: '768P',
        duration: 5,
      }),
    ).toBe(false);
    expect(
      validate('cn.minimax.h3.video', {
        content: [{ type: 'text', text: '你好' }],
        resolution: '768P',
        duration: 5,
        ratio: 'adaptive',
      }),
    ).toBe(false);
  });

  it('distinguishes Seedance 2.0 audio-only restrictions from 2.5 and rejects legacy-only fields', () => {
    const content = [{ type: 'audio_url', role: 'reference_audio', audio_url: { url: audio } }];
    expect(validate('cn.bytedance.seedance2-0.video', { content })).toBe(false);
    expect(validate('cn.bytedance.seedance2-5.video', { content })).toBe(true);
    expect(validate('cn.bytedance.seedance2-5.video', { content, seed: 1 })).toBe(false);
    expect(
      validate('cn.bytedance.seedance2-5.video', { content, draft: true, resolution: '1080p' }),
    ).toBe(false);
    expect(
      validate('cn.bytedance.seedance2-0.video', {
        content: [
          ...content,
          { type: 'image_url', role: 'first_frame', image_url: { url: image } },
        ],
      }),
    ).toBe(false);
  });

  it('keeps Vidu reference sounds and clone request semantics distinct', () => {
    const id = 'cn.vidu.q4-preview.reference-video';
    expect(
      validate(id, { prompt: '你好', images: [image], sounds: ['https://example.com/voice.mp3'] }),
    ).toBe(true);
    expect(validate(id, { prompt: '你好', images: [image], sounds: Array(4).fill(audio) })).toBe(
      false,
    );
    expect(
      validate('cn.vidu.voice-clone', {
        audio_url: audio,
        voice_id: 'actor_voice_01',
        text: '你好',
      }),
    ).toBe(true);
    expect(
      validate('cn.vidu.voice-clone', { audio_url: audio, voice_id: 'actor_', text: '你好' }),
    ).toBe(false);
  });

  it('binds Kling voice through character elements rather than fabricated direct audio parameters', () => {
    const params = {
      contents: [
        { type: 'prompt', text: '<<<actor>>>说你好。' },
        { type: 'element', element_id: 'example-character', id: 'actor' },
      ],
      settings: { audio: 'native', duration: 5 },
    };
    expect(validate('cn.kling.3-0.video-omni', params)).toBe(true);
    expect(validate('cn.kling.3-0.video-omni', { ...params, voice_ids: ['fake'] })).toBe(false);
    expect(
      validate('cn.kling.3-0.video-omni', {
        ...params,
        settings: { ...params.settings, voice_id: 'fake' },
      }),
    ).toBe(false);
    expect(validate('cn.kling.custom-voice', { voice_name: '角色', voice_url: audio })).toBe(true);
    expect(validate('cn.kling.custom-voice', { voice_name: '角色' })).toBe(false);
    expect(buildOfficialVideoAudioRequest('cn.kling.3-0.video-omni', params)).not.toHaveProperty(
      'model',
    );
  });

  it('preserves nested schema and conditional validation when projecting a form', () => {
    const contract = officialVideoAudioContracts.find((c) => c.contractId === wan)!;
    const adapter = adapterDescriptorFromModelContract({
      contract,
      capability: 'REFERENCE_TO_VIDEO',
      provider: 'qwen',
      providerLabel: 'Qwen',
      model: 'wan3.0-video',
      modelLabel: 'Wan 3',
      apiVersion: 'preview',
      endpoint: '/preview',
      documentationUrl: contract.source.url,
      credentialProvider: 'qwen',
    });
    expect(adapter.parameterSchema.properties.media!.items).toEqual(
      (contract.parameterSchema.properties as Record<string, { items: unknown }>).media!.items,
    );
    expect(adapter.parameterSchema.anyOf).toEqual(contract.parameterSchema.anyOf);
    expect(adapter.uiSchema.fields.find((field) => field.key === 'media')?.control).toBe(
      'structured',
    );
    const runtime = getAdapter('REFERENCE_TO_VIDEO:wan-video:cn.qwen.wan3-0-video:contract-3')!;
    expect(validateAdapterParameters(runtime.key, reference).valid).toBe(true);
    expect(
      validateAdapterParameters(runtime.key, {
        ...reference,
        media: [{ type: 'reference_audio', url: audio, api_key: 'forbidden' }],
      }).valid,
    ).toBe(false);
  });
});
