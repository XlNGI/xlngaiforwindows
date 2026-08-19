import { describe, expect, it } from 'vitest';
import {
  AgentProviderCapabilityError,
  assertAgentToolLoopSelection,
  hasAnyModelCapability,
  inferKnownModelCapabilities,
  listBuiltInProviderModels,
  listProviderDefinitions,
  validateProviderConfiguration,
} from './provider-registry.js';

function model(
  profileId: string,
  remoteModelId: string,
  capabilities: ReturnType<typeof inferKnownModelCapabilities>,
) {
  return {
    id: 'model-id',
    providerProfileId: profileId,
    remoteModelId,
    displayName: remoteModelId,
    capabilities,
    source: 'manual' as const,
    enabled: true,
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
  };
}

function profile(overrides: Partial<Parameters<typeof assertAgentToolLoopSelection>[0]> = {}) {
  return {
    id: 'profile-id',
    name: 'OpenAI',
    category: 'llm' as const,
    providerType: 'openai',
    accessType: 'official' as const,
    protocol: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    enabled: true,
    connectionStatus: 'ready' as const,
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
    ...overrides,
  };
}

describe('provider registry', () => {
  it('locks official provider configuration to a built-in definition', () => {
    expect(listProviderDefinitions().map((definition) => definition.id)).toEqual([
      'openai',
      'unicompapi',
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
      'viduq3-ad',
      'viduq3-mix',
      'viduq3-turbo',
      'viduq2-pro',
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

  it('infers conservative UniCompAPI capabilities and leaves unknown models disabled', () => {
    expect(inferKnownModelCapabilities('unicompapi', 'qwen-image')).toMatchObject({
      imageGeneration: true,
      text: false,
    });
    expect(inferKnownModelCapabilities('unicompapi', 'qwen-image-edit-2509')).toMatchObject({
      imageEditing: true,
      imageGeneration: false,
    });
    expect(inferKnownModelCapabilities('unicompapi', 'doubao-seedance-2-0-260128')).toMatchObject({
      videoGeneration: true,
      text: false,
    });
    expect(inferKnownModelCapabilities('unicompapi', 'gpt-5.6-sol')).toMatchObject({
      text: true,
      streaming: true,
      tools: true,
    });
    expect(inferKnownModelCapabilities('unicompapi', 'vendor-experimental-model')).toEqual({
      text: false,
      vision: false,
      streaming: false,
      reasoning: false,
      tools: false,
      structuredOutput: false,
      embeddings: false,
      imageGeneration: false,
      imageEditing: false,
      videoGeneration: false,
    });
  });

  it('opens only the verified official OpenAI Responses route for Agent tools', () => {
    const selectedProfile = profile();
    const selectedModel = model(
      selectedProfile.id,
      'gpt-5',
      inferKnownModelCapabilities('openai', 'gpt-5'),
    );
    expect(assertAgentToolLoopSelection(selectedProfile, selectedModel)).toMatchObject({
      id: 'openai-responses-official-v1',
      toolCallFormat: 'responses-function-call',
      toolResultFormat: 'responses-function-call-output',
    });
  });

  it('rejects manually labelled models on unverified Chat Completions routes', () => {
    const selectedProfile = profile({
      id: 'unicomp-profile',
      name: 'UniCompAPI',
      category: 'multi',
      providerType: 'unicompapi',
      accessType: 'official',
      protocol: 'openai-chat-completions',
      baseUrl: 'https://unicompapi.com/v1',
    });
    const selectedModel = model(selectedProfile.id, 'experimental-tools', {
      ...inferKnownModelCapabilities('openai', 'gpt-5'),
      text: true,
      streaming: true,
      tools: true,
    });
    expect(() => assertAgentToolLoopSelection(selectedProfile, selectedModel)).toThrow(
      'verification gate',
    );
    try {
      assertAgentToolLoopSelection(selectedProfile, selectedModel);
    } catch (error) {
      expect(error).toBeInstanceOf(AgentProviderCapabilityError);
      expect(error).toMatchObject({ code: 'PROVIDER_TOOL_LOOP_REQUIRED' });
    }
  });

  it('opens only the verified UniCompAPI Chat Completions model', () => {
    const selectedProfile = profile({
      id: 'unicomp-profile',
      name: 'UniCompAPI',
      category: 'multi',
      providerType: 'unicompapi',
      accessType: 'official',
      protocol: 'openai-chat-completions',
      baseUrl: 'https://unicompapi.com/v1',
    });
    const selectedModel = model(
      selectedProfile.id,
      'gpt-5.6-sol',
      inferKnownModelCapabilities('unicompapi', 'gpt-5.6-sol'),
    );
    expect(assertAgentToolLoopSelection(selectedProfile, selectedModel)).toMatchObject({
      id: 'unicompapi-chat-completions-gpt-5.6-sol-v1',
      protocol: 'openai-chat-completions',
      toolCallFormat: 'chat-completions-tool-calls',
      toolResultFormat: 'chat-completions-tool-message',
      verifiedAt: '2026-08-18',
    });

    const otherModel = model(selectedProfile.id, 'gpt-5.6-terra', {
      ...inferKnownModelCapabilities('unicompapi', 'gpt-5.6-terra'),
      tools: true,
    });
    expect(() => assertAgentToolLoopSelection(selectedProfile, otherModel)).toThrow(
      'verification gate',
    );
  });

  it('rejects custom Responses endpoints even when the model advertises tools', () => {
    const selectedProfile = profile({
      providerType: 'relay',
      accessType: 'custom',
      baseUrl: 'https://relay.example/v1',
    });
    const selectedModel = model(
      selectedProfile.id,
      'gpt-5',
      inferKnownModelCapabilities('openai', 'gpt-5'),
    );

    expect(() => assertAgentToolLoopSelection(selectedProfile, selectedModel)).toThrow(
      'verification gate',
    );
  });

  it('rejects models outside the verified Responses allowlist', () => {
    const selectedProfile = profile();
    const selectedModel = model(selectedProfile.id, 'vendor-experimental-model', {
      ...inferKnownModelCapabilities('openai', 'gpt-5'),
      text: true,
      streaming: true,
      tools: true,
    });

    expect(() => assertAgentToolLoopSelection(selectedProfile, selectedModel)).toThrow(
      'verification gate',
    );
  });

  it('reports the model gate before route verification', () => {
    expect(() => assertAgentToolLoopSelection(profile(), undefined)).toThrow(
      'text generation, streaming, and tools',
    );
    try {
      assertAgentToolLoopSelection(profile(), undefined);
    } catch (error) {
      expect(error).toMatchObject({ code: 'MODEL_TOOLS_REQUIRED' });
    }
  });
});
