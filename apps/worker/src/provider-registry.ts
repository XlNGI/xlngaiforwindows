import type {
  ProviderDefinitionInfo,
  ProviderModelCapabilities,
  ProviderProfileCreateParams,
} from '@ai-video/contracts';

export class ProviderRegistryValidationError extends Error {}

const OFFICIAL_PROVIDER_DEFINITIONS: readonly ProviderDefinitionInfo[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    category: 'llm',
    providerType: 'openai',
    protocol: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
    accessType: 'official',
  },
  {
    id: 'vidu-global',
    name: 'Vidu 国际站',
    category: 'multi',
    providerType: 'vidu',
    protocol: 'vidu-v2',
    baseUrl: 'https://api.vidu.com',
    accessType: 'official',
  },
  {
    id: 'vidu-china',
    name: 'Vidu 中国站',
    category: 'multi',
    providerType: 'vidu',
    protocol: 'vidu-v2',
    baseUrl: 'https://api.vidu.cn',
    accessType: 'official',
  },
];

export interface BuiltInProviderModelDefinition {
  remoteModelId: string;
  displayName: string;
  capabilities: ProviderModelCapabilities;
}

const VIDU_BUILT_IN_MODELS: readonly BuiltInProviderModelDefinition[] = [
  viduModel('viduq1', 'Vidu Q1', 'image'),
  viduModel('viduq2', 'Vidu Q2', 'image'),
  viduModel('viduq3', 'Vidu Q3', 'video'),
  viduModel('viduq3-pro', 'Vidu Q3 Pro', 'video'),
  viduModel('viduq3-drama', 'Vidu Q3-Drama', 'video'),
  viduModel('vidu2.0', 'Vidu 2.0', 'video'),
];

const CUSTOM_PROTOCOLS = new Set(['openai-responses', 'openai-chat-completions']);

export function listProviderDefinitions(): ProviderDefinitionInfo[] {
  return OFFICIAL_PROVIDER_DEFINITIONS.map((definition) => ({ ...definition }));
}

export function listBuiltInProviderModels(providerType: string): BuiltInProviderModelDefinition[] {
  if (providerType !== 'vidu') return [];
  return VIDU_BUILT_IN_MODELS.map((model) => ({
    ...model,
    capabilities: { ...model.capabilities },
  }));
}

export function validateProviderConfiguration(
  profile: Pick<
    ProviderProfileCreateParams,
    'category' | 'providerType' | 'accessType' | 'protocol' | 'baseUrl'
  >,
): void {
  if (profile.accessType === 'official') {
    const matched = OFFICIAL_PROVIDER_DEFINITIONS.some(
      (definition) =>
        definition.category === profile.category &&
        definition.providerType === profile.providerType &&
        definition.protocol === profile.protocol &&
        definition.baseUrl === profile.baseUrl,
    );
    if (!matched) {
      throw new ProviderRegistryValidationError(
        'Official provider type, protocol, category, and Base URL must match a built-in definition.',
      );
    }
    return;
  }

  if (profile.category !== 'llm') {
    throw new ProviderRegistryValidationError(
      'Custom providers currently support the LLM category only.',
    );
  }
  if (!CUSTOM_PROTOCOLS.has(profile.protocol)) {
    throw new ProviderRegistryValidationError(
      'Custom providers must use OpenAI Responses or OpenAI-compatible Chat Completions.',
    );
  }
}

export function emptyModelCapabilities(): ProviderModelCapabilities {
  return {
    text: false,
    vision: false,
    streaming: false,
    reasoning: false,
    tools: false,
    structuredOutput: false,
    embeddings: false,
    imageGeneration: false,
    videoGeneration: false,
  };
}

export function inferKnownModelCapabilities(
  providerType: string,
  modelId: string,
): ProviderModelCapabilities {
  const capabilities = emptyModelCapabilities();
  const normalized = modelId.toLowerCase();
  if (providerType !== 'openai') return capabilities;

  if (normalized.startsWith('text-embedding-')) {
    capabilities.embeddings = true;
    return capabilities;
  }
  if (normalized.startsWith('gpt-image-')) {
    capabilities.imageGeneration = true;
    return capabilities;
  }
  const isReasoning = /^(o1|o3|o4|gpt-5)(-|$)/.test(normalized);
  const isKnownGpt = /^(gpt-4o|gpt-4\.1|gpt-5)(-|$)/.test(normalized);
  if (!isReasoning && !isKnownGpt) return capabilities;

  capabilities.text = true;
  capabilities.streaming = true;
  capabilities.reasoning = isReasoning;
  capabilities.vision = isKnownGpt;
  capabilities.tools = true;
  capabilities.structuredOutput = true;
  return capabilities;
}

export function hasAnyModelCapability(capabilities: ProviderModelCapabilities): boolean {
  return Object.values(capabilities).some(Boolean);
}

function viduModel(
  remoteModelId: string,
  displayName: string,
  kind: 'image' | 'video',
): BuiltInProviderModelDefinition {
  const capabilities = emptyModelCapabilities();
  capabilities.imageGeneration = kind === 'image';
  capabilities.videoGeneration = kind === 'video';
  return { remoteModelId, displayName, capabilities };
}
