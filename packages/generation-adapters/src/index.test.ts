import { describe, expect, it } from 'vitest';
import { getAdapterCatalog, resolveAdapter, validateAdapterParameters } from './index.js';

describe('adapter registry', () => {
  it('resolves every capability/provider/model tuple to exactly one adapter', () => {
    const catalog = getAdapterCatalog();
    const keys = catalog.adapters.map((adapter) => adapter.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const adapter of catalog.adapters) {
      expect(resolveAdapter(adapter)).toMatchObject({ key: adapter.key });
    }
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
});
