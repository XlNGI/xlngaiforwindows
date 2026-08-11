import { describe, expect, it } from 'vitest';
import {
  extractVideoCost,
  getAdapter,
  getAdapterCatalog,
  resolveAdapter,
  validateAdapterParameters,
} from './index.js';

describe('extractVideoCost', () => {
  it('extracts credits from Vidu poll bodies', () => {
    expect(
      extractVideoCost('vidu', {
        state: 'success',
        credits: '4',
      }),
    ).toEqual({ amount: 4, unit: 'credits' });
    expect(
      extractVideoCost('vidu', {
        state: 'success',
        data: { credits_used: 2 },
      }),
    ).toEqual({ amount: 2, unit: 'credits' });
    expect(
      extractVideoCost('vidu', {
        state: 'success',
        creditsUsed: 3,
      }),
    ).toEqual({ amount: 3, unit: 'credits' });
    expect(
      extractVideoCost('vidu', {
        state: 'success',
        cost: 1.5,
      }),
    ).toEqual({ amount: 1.5, unit: 'unknown' });
  });

  it('returns undefined when the body has no usable cost fields', () => {
    expect(extractVideoCost('vidu', undefined)).toBeUndefined();
    expect(extractVideoCost('vidu', null)).toBeUndefined();
    expect(extractVideoCost('vidu', { state: 'success' })).toBeUndefined();
    expect(extractVideoCost('unknown-provider', { credits: 4 })).toBeUndefined();
  });
});

describe('adapter registry', () => {
  it('resolves every capability/provider/model tuple to exactly one adapter', () => {
    const catalog = getAdapterCatalog();
    const keys = catalog.adapters.map((adapter) => adapter.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const adapter of catalog.adapters) {
      expect(resolveAdapter(adapter)).toMatchObject({ key: adapter.key });
    }
    expect(catalog.adapters.map(({ model, modelLabel }) => ({ model, modelLabel }))).toEqual(
      expect.arrayContaining([
        { model: 'viduq1', modelLabel: 'Vidu Q1' },
        { model: 'viduq2', modelLabel: 'Vidu Q2' },
        { model: 'viduq3', modelLabel: 'Vidu Q3' },
        { model: 'viduq3-pro', modelLabel: 'Vidu Q3 Pro' },
        { model: 'viduq3-drama', modelLabel: 'Vidu Q3-Drama' },
        { model: 'vidu2.0', modelLabel: 'Vidu 2.0' },
      ]),
    );
  });

  it('rejects unsupported selections instead of falling back to another model', () => {
    expect(() =>
      resolveAdapter({ capability: 'TEXT_TO_IMAGE', provider: 'vidu', model: 'viduq1' }),
    ).toThrow('No adapter matches');
  });

  it('accepts valid Vidu Q2 text-to-image parameters and rejects undeclared secrets', () => {
    const key = 'TEXT_TO_IMAGE:vidu:viduq2:v2';
    expect(
      validateAdapterParameters(key, {
        prompt: '夜色中的电影街道',
        aspect_ratio: '16:9',
        resolution: '2K',
      }),
    ).toMatchObject({ valid: true });
    expect(
      validateAdapterParameters(key, {
        prompt: '夜色中的电影街道',
        aspect_ratio: '16:9',
        resolution: '2K',
        apiKey: 'must-not-persist',
      }),
    ).toMatchObject({ valid: false });
  });

  it('enforces reference count and model-specific image resolution', () => {
    expect(
      validateAdapterParameters('REFERENCE_TO_IMAGE:vidu:viduq1:v2', {
        images: ['https://example.com/reference.png'],
        prompt: '保持角色一致',
        aspect_ratio: '16:9',
        resolution: '2K',
      }),
    ).toMatchObject({ valid: false });
  });

  it('rejects the unsupported Vidu 2.0 combination of 8 seconds and 1080p', () => {
    const base = {
      images: ['https://example.com/start.png'],
      duration: 8,
      movement_amplitude: 'auto',
    };
    expect(
      validateAdapterParameters('IMAGE_TO_VIDEO:vidu:vidu2.0:v2', {
        ...base,
        resolution: '1080p',
      }),
    ).toMatchObject({ valid: false });
    expect(
      validateAdapterParameters('IMAGE_TO_VIDEO:vidu:vidu2.0:v2', {
        ...base,
        resolution: '720p',
      }),
    ).toMatchObject({ valid: true });
  });

  it('exposes distinct video production modes and validates text-to-video parameters', () => {
    const catalog = getAdapterCatalog();
    expect(catalog.capabilities.map((item) => item.key)).toEqual([
      'TEXT_TO_IMAGE',
      'REFERENCE_TO_IMAGE',
      'TEXT_TO_VIDEO',
      'IMAGE_TO_VIDEO',
      'REFERENCE_TO_VIDEO',
      'START_END_TO_VIDEO',
    ]);
    expect(
      validateAdapterParameters('TEXT_TO_VIDEO:vidu:viduq3-pro:v2', {
        prompt: '镜头穿过清晨薄雾中的城市街道',
        duration: 5,
        aspect_ratio: '16:9',
        resolution: '720p',
        audio: true,
      }),
    ).toMatchObject({ valid: true });
    expect(
      validateAdapterParameters('TEXT_TO_VIDEO:vidu:viduq3-pro:v2', {
        duration: 5,
        aspect_ratio: '16:9',
        resolution: '720p',
        audio: true,
      }),
    ).toMatchObject({ valid: false });
  });

  it('enforces the official reference-video image count and fields', () => {
    const key = 'REFERENCE_TO_VIDEO:vidu:viduq3:v2';
    const base = {
      prompt: '角色在雨夜街道行走',
      duration: 5,
      aspect_ratio: '16:9',
      resolution: '720p',
      audio: true,
    };
    expect(
      validateAdapterParameters(key, {
        ...base,
        images: ['https://example.com/reference.png'],
      }),
    ).toMatchObject({ valid: true });
    expect(
      validateAdapterParameters(key, {
        ...base,
        images: Array.from({ length: 8 }, (_, index) => `https://example.com/${index}.png`),
      }),
    ).toMatchObject({ valid: false });
    expect(
      validateAdapterParameters(key, {
        ...base,
        images: ['https://example.com/reference.png'],
        callback_url: 'https://attacker.invalid/callback',
      }),
    ).toMatchObject({ valid: false });
  });

  it('enforces the official Vidu Q3-Drama reference-video limits', () => {
    const key = 'REFERENCE_TO_VIDEO:vidu:viduq3-drama:v2';
    const base = {
      images: ['https://example.com/reference.png'],
      prompt: '古装人物在宫殿中自然对话',
      duration: 8,
      aspect_ratio: '16:9',
      resolution: '1080p',
      audio: true,
    };
    expect(validateAdapterParameters(key, base)).toMatchObject({ valid: true });
    expect(validateAdapterParameters(key, { ...base, duration: 16 })).toMatchObject({
      valid: false,
    });
    expect(validateAdapterParameters(key, { ...base, aspect_ratio: '1:1' })).toMatchObject({
      valid: false,
    });
    expect(validateAdapterParameters(key, { ...base, resolution: '540p' })).toMatchObject({
      valid: false,
    });
  });

  it('requires exactly two ordered images for start-end video', () => {
    const key = 'START_END_TO_VIDEO:vidu:viduq3-pro:v2';
    const base = { duration: 5, resolution: '720p', audio: true };
    expect(
      validateAdapterParameters(key, {
        ...base,
        images: ['https://example.com/start.png'],
      }),
    ).toMatchObject({ valid: false });
    expect(
      validateAdapterParameters(key, {
        ...base,
        images: ['https://example.com/start.png', 'https://example.com/end.png'],
      }),
    ).toMatchObject({ valid: true });
  });

  it('keeps legacy video adapter keys available without exposing them in the catalog', () => {
    expect(
      validateAdapterParameters('IMAGE_TO_VIDEO:vidu:viduq3-pro:v2', {
        images: ['https://example.com/start.png', 'https://example.com/end.png'],
        duration: 5,
        resolution: '720p',
        audio: true,
      }),
    ).toMatchObject({ valid: true });
    expect(
      getAdapterCatalog().adapters.some(
        (adapter) => adapter.key === 'IMAGE_TO_VIDEO:vidu:viduq3-pro:v2',
      ),
    ).toBe(false);
  });

  it('publishes only explicitly contracted UniCompAPI media adapters', () => {
    const catalog = getAdapterCatalog();
    expect(
      catalog.adapters.find(
        (adapter) =>
          adapter.key === 'TEXT_TO_IMAGE:unicompapi:doubao-seedream-5-0-260128:v1',
      ),
    ).toMatchObject({
      provider: 'unicompapi',
      model: 'doubao-seedream-5-0-260128',
      endpoint: 'https://unicompapi.com/v1/images/generations',
    });
    expect(
      catalog.adapters.find(
        (adapter) => adapter.key === 'REFERENCE_TO_IMAGE:unicompapi:qwen-image-edit-2509:v1',
      ),
    ).toMatchObject({ endpoint: 'https://unicompapi.com/v1/images/edits/' });
    expect(
      catalog.adapters.some((adapter) => adapter.model === 'happyhorse-1.0-video-edit'),
    ).toBe(false);
    expect(() =>
      resolveAdapter({ capability: 'TEXT_TO_VIDEO', provider: 'unicompapi', model: 'qwen-image' }),
    ).toThrow('No adapter matches');
  });

  it('validates UniCompAPI reference input and rejects undeclared request fields', () => {
    const key = 'IMAGE_TO_VIDEO:unicompapi:kling-v3-turbo:v1';
    expect(
      validateAdapterParameters(key, {
        images: ['https://example.com/reference.png'],
        prompt: 'camera push',
        duration: 5,
        ratio: '16:9',
      }),
    ).toMatchObject({ valid: true });
    expect(
      validateAdapterParameters(key, {
        images: ['https://example.com/one.png', 'https://example.com/two.png'],
        prompt: 'camera push',
      }),
    ).toMatchObject({ valid: false });
    expect(
      validateAdapterParameters('TEXT_TO_IMAGE:unicompapi:qwen-image:v1', {
        prompt: 'frame',
        apiKey: 'must-not-persist',
      }),
    ).toMatchObject({ valid: false });
  });

  it('requires a defaulted size only for the qwen-image model family', () => {
    const qwen = getAdapter('TEXT_TO_IMAGE:unicompapi:qwen-image:v1');
    const seedream = getAdapter(
      'TEXT_TO_IMAGE:unicompapi:doubao-seedream-5-0-260128:v1',
    );
    expect(qwen?.parameterSchema.required).toContain('size');
    expect(qwen?.parameterSchema.properties.size?.default).toBe('1024x1024');
    expect(seedream?.parameterSchema.required).not.toContain('size');
    expect(seedream?.parameterSchema.properties.size?.default).toBeUndefined();
    expect(
      validateAdapterParameters('TEXT_TO_IMAGE:unicompapi:qwen-image:v1', {
        prompt: 'frame',
      }),
    ).toMatchObject({ valid: false });
    expect(
      validateAdapterParameters('TEXT_TO_IMAGE:unicompapi:qwen-image:v1', {
        prompt: 'frame',
        size: '1024x1024',
      }),
    ).toMatchObject({ valid: true });
  });
});
