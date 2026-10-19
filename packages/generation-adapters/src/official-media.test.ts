import { describe, expect, it } from 'vitest';
import {
  officialImageContracts,
  officialVideoContracts,
  type AdapterParameters,
} from '@ai-video/contracts';
import { adapterBindsCatalogModel, getAdapter, validateAdapterParameters } from './index.js';

const key = (mode: string) =>
  `${mode === 't2v' ? 'TEXT_TO_VIDEO' : mode === 'i2v' ? 'IMAGE_TO_VIDEO' : 'REFERENCE_TO_VIDEO'}:unicompapi:cn.happyhorse.1.1.${mode}:contract-1`;

describe('official HappyHorse contracts', () => {
  it('offers current Wan audio/media contracts while keeping the old adapter available for history', () => {
    const adapter = getAdapter('REFERENCE_TO_VIDEO:unicompapi:cn.qwen.wan3-0-video:contract-3')!;
    expect(adapter).toBeDefined();
    expect(
      adapterBindsCatalogModel(adapter, {
        providerType: 'unicompapi',
        remoteModelId: 'wan3.0-video',
      }),
    ).toBe(true);
    const old = getAdapter('TEXT_TO_VIDEO:unicompapi:cn.qwen.wan3-0-video:contract-1')!;
    expect(old).toBeDefined();
    expect(
      adapterBindsCatalogModel(old, { providerType: 'unicompapi', remoteModelId: 'wan3.0-video' }),
    ).toBe(false);
    const parameters = {
      prompt: '使用音频1的音色',
      audio: true,
      media: [{ type: 'reference_audio', url: 'https://example.com/voice.wav' }],
    };
    expect(validateAdapterParameters(adapter.key, parameters)).toEqual({ valid: true, errors: [] });
    expect(
      validateAdapterParameters(adapter.key, {
        ...parameters,
        audio: 'https://example.com/voice.wav',
      }).valid,
    ).toBe(false);
    expect(
      validateAdapterParameters(adapter.key, {
        ...parameters,
        media: [{ type: 'reference_image', url: 'project-asset://image' }, ...parameters.media],
      }).valid,
    ).toBe(true);
    expect(
      validateAdapterParameters(adapter.key, {
        ...parameters,
        media: [{ type: 'first_frame', url: 'https://example.com/first.png' }, ...parameters.media],
      }).valid,
    ).toBe(false);
  });
  it('exposes only officially sourced schemas and exact channel bindings', () => {
    for (const contract of officialVideoContracts) {
      expect(new URL(contract.source.url).hostname).toBe('help.aliyun.com');
      expect(contract.source.verificationStatus).toBe('verified');
      expect(contract.transport.samples?.[0]?.request).toHaveProperty('input');
    }
    const adapter = getAdapter(key('t2v'))!;
    expect(
      adapterBindsCatalogModel(adapter, {
        providerType: 'unicompapi',
        remoteModelId: 'happyhorse-1.1-t2v',
      }),
    ).toBe(true);
    expect(
      adapterBindsCatalogModel(adapter, {
        providerType: 'unicompapi',
        remoteModelId: 'happyhorse-1.1-r2v',
      }),
    ).toBe(false);
    expect(
      adapterBindsCatalogModel(adapter, {
        providerType: 'unicompapi',
        remoteModelId: 'happyhorse-1.1-t2v',
        contractStatus: 'verified',
      }),
    ).toBe(false);
    expect(adapter.parameterSchema.properties).not.toHaveProperty('generate_audio');
    expect(adapter.parameterSchema.properties).not.toHaveProperty('seconds');
  });

  it('enforces official duration, resolution, seed and prompt constraints', () => {
    for (const duration of [3, 5, 15])
      expect(validateAdapterParameters(key('t2v'), { prompt: 'test', duration }).valid).toBe(true);
    const invalid: AdapterParameters[] = [
      { prompt: 'test', duration: 2 },
      { prompt: 'test', duration: 16 },
      { prompt: 'test', duration: 5.5 },
      { prompt: 'test', resolution: '4K' },
      { prompt: 'test', seed: 2147483648 },
      { prompt: 'test', generate_audio: true },
      { prompt: '汉'.repeat(2501) },
    ];
    for (const parameters of invalid) {
      expect(validateAdapterParameters(key('t2v'), parameters).valid).toBe(false);
    }
  });

  it('allows optional i2v prompt, exactly one first frame, and up to nine references', () => {
    const image = 'https://example.com/image.png';
    expect(validateAdapterParameters(key('i2v'), { images: [image] }).valid).toBe(true);
    expect(validateAdapterParameters(key('i2v'), { images: [image, image] }).valid).toBe(false);
    expect(validateAdapterParameters(key('i2v'), { images: [image], ratio: '16:9' }).valid).toBe(
      false,
    );
    expect(
      validateAdapterParameters(key('r2v'), {
        prompt: '[Image 1] walks',
        images: Array(9).fill(image),
      }).valid,
    ).toBe(true);
    expect(
      validateAdapterParameters(key('r2v'), { prompt: 'test', images: Array(10).fill(image) })
        .valid,
    ).toBe(false);
    expect(
      validateAdapterParameters(key('r2v'), { prompt: 'test', images: ['file:///private.png'] })
        .valid,
    ).toBe(false);
  });

  it('uses the official video editing schema instead of generation parameters', () => {
    const adapterKey = 'VIDEO_TO_VIDEO:unicompapi:cn.happyhorse.1.0.video-edit:contract-1';
    expect(
      validateAdapterParameters(adapterKey, {
        prompt: 'Change the clothing',
        video: 'https://example.com/input.mp4',
        audio_setting: 'origin',
      }).valid,
    ).toBe(true);
    expect(
      validateAdapterParameters(adapterKey, { prompt: 'test', video: 'data:video/mp4;base64,abc' })
        .valid,
    ).toBe(false);
    expect(
      validateAdapterParameters(adapterKey, {
        prompt: 'test',
        video: 'https://example.com/input.mp4',
        duration: 5,
      }).valid,
    ).toBe(false);
  });

  it('exposes official Wan 3 Qwen video contracts with the documented fields', () => {
    for (const model of ['wan3.0-video', 'wan3.0-video-prime']) {
      const contract = officialVideoContracts.find((item) => item.officialModelName === model)!;
      expect(contract.providerFamily).toBe('qwen');
      expect(contract.source.url).toBe(
        'https://help.aliyun.com/zh/model-studio/wan3-video-generation-api-reference',
      );
      const adapter = getAdapter(`TEXT_TO_VIDEO:unicompapi:${contract.contractId}:contract-1`)!;
      expect(adapter.parameterSchema.properties).toHaveProperty('audio');
      expect(adapter.parameterSchema.properties).toHaveProperty('prompt_extend');
      expect(adapter.parameterSchema.properties).not.toHaveProperty('seconds');
      expect(
        validateAdapterParameters(adapter.key, {
          prompt: '一只小猫在月光下奔跑',
          resolution: '720P',
          ratio: 'adaptive',
          duration: 5,
          audio: true,
          prompt_extend: true,
          watermark: false,
          seed: -1,
        }).valid,
      ).toBe(true);
      expect(validateAdapterParameters(adapter.key, { prompt: 'test', duration: 31 }).valid).toBe(
        false,
      );
      expect(
        validateAdapterParameters(adapter.key, { prompt: 'test', resolution: '4K' }).valid,
      ).toBe(false);
    }
  });

  it('exposes current official Qwen Image text-to-image contracts', () => {
    expect(officialImageContracts.map((contract) => contract.officialModelName)).toEqual([
      'qwen-image-3.0-pro',
      'qwen-image-3.0',
      'qwen-image-2.1-pro',
      'qwen-image-2.1-turbo',
    ]);
    for (const contract of officialImageContracts) {
      const adapter = getAdapter(`TEXT_TO_IMAGE:unicompapi:${contract.contractId}:contract-1`)!;
      expect(adapter.parameterSchema.properties).toHaveProperty('size');
      expect(adapter.parameterSchema.properties).toHaveProperty('prompt_extend');
      expect(
        validateAdapterParameters(adapter.key, { prompt: 'a cat', size: '1024x1024' }).valid,
      ).toBe(true);
      expect(
        validateAdapterParameters(adapter.key, { prompt: 'a cat', generate_audio: true }).valid,
      ).toBe(false);
    }
  });
});
