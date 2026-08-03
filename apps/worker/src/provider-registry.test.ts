import { describe, expect, it } from 'vitest';
import {
  hasAnyModelCapability,
  inferKnownModelCapabilities,
  listBuiltInProviderModels,
  listProviderDefinitions,
  validateProviderConfiguration,
} from './provider-registry.js';

describe('provider registry', () => {
  it('locks official provider configuration to a built-in definition', () => {
    expect(listProviderDefinitions().map((definition) => definition.id)).toEqual([
      'openai',
      'vidu-global',
      'vidu-china',
    ]);
    expect(() =>
      validateProviderConfiguration({
        category: 'llm',
        providerType: 'openai',
        accessType: 'official',
        protocol: 'openai-responses',
        baseUrl: 'https://relay.example/v1',
      }),
    ).toThrow('must match a built-in definition');
  });

  it('publishes a conservative built-in media catalog for Vidu profiles', () => {
    const models = listBuiltInProviderModels('vidu');
    expect(models.map((model) => model.remoteModelId)).toEqual([
      'viduq1',
      'viduq2',
      'viduq3',
      'viduq3-pro',
      'viduq3-drama',
      'vidu2.0',
    ]);
    expect(models.find((model) => model.remoteModelId === 'viduq2')?.capabilities).toMatchObject({
      imageGeneration: true,
      videoGeneration: false,
    });
    expect(models.find((model) => model.remoteModelId === 'viduq3')?.capabilities).toMatchObject({
      imageGeneration: false,
      videoGeneration: true,
    });
  });

  it('restricts custom providers to an explicit supported protocol', () => {
    expect(() =>
      validateProviderConfiguration({
        category: 'llm',
        providerType: 'relay',
        accessType: 'custom',
        protocol: 'anthropic-messages',
        baseUrl: 'https://relay.example/v1',
      }),
    ).toThrow('must use OpenAI Responses');
  });

  it('does not grant capabilities to unknown remote models', () => {
    const unknown = inferKnownModelCapabilities('openai', 'vendor-experimental-model');
    expect(hasAnyModelCapability(unknown)).toBe(false);
    expect(inferKnownModelCapabilities('openai', 'gpt-5').reasoning).toBe(true);
    expect(inferKnownModelCapabilities('openai', 'text-embedding-3-large').embeddings).toBe(true);
  });
});
