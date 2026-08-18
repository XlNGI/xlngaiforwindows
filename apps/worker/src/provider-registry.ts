import type {
  ProviderDefinitionInfo,
  ProviderModelCapabilities,
  ProviderModelInfo,
  ProviderProfileInfo,
  ProviderProfileCreateParams,
} from '@ai-video/contracts';

export class ProviderRegistryValidationError extends Error {}

export type AgentProviderCapabilityErrorCode =
  'MODEL_TOOLS_REQUIRED' | 'PROVIDER_TOOL_LOOP_REQUIRED';

export class AgentProviderCapabilityError extends Error {
  constructor(
    readonly code: AgentProviderCapabilityErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export type ProviderToolLoopRoute = {
  id: 'openai-responses-official-v1' | 'unicompapi-chat-completions-gpt-5.6-sol-v1';
  providerType: 'openai' | 'unicompapi';
  accessType: 'official';
  protocol: 'openai-responses' | 'openai-chat-completions';
  baseUrl: 'https://api.openai.com/v1' | 'https://unicompapi.com/v1';
  toolCallFormat: 'responses-function-call' | 'chat-completions-tool-calls';
  toolResultFormat: 'responses-function-call-output' | 'chat-completions-tool-message';
  verifiedAt: '2026-08-17' | '2026-08-18';
};

const VERIFIED_AGENT_TOOL_LOOP_ROUTE: ProviderToolLoopRoute = {
  id: 'openai-responses-official-v1',
  providerType: 'openai',
  accessType: 'official',
  protocol: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1',
  toolCallFormat: 'responses-function-call',
  toolResultFormat: 'responses-function-call-output',
  verifiedAt: '2026-08-17',
};

const VERIFIED_UNICOMPAPI_TOOL_LOOP_ROUTE: ProviderToolLoopRoute = {
  id: 'unicompapi-chat-completions-gpt-5.6-sol-v1',
  providerType: 'unicompapi',
  accessType: 'official',
  protocol: 'openai-chat-completions',
  baseUrl: 'https://unicompapi.com/v1',
  toolCallFormat: 'chat-completions-tool-calls',
  toolResultFormat: 'chat-completions-tool-message',
  verifiedAt: '2026-08-18',
};

const OPENAI_RESPONSES_AGENT_MODEL_ALLOWLIST = [
  /^(?:gpt-4o|gpt-4\.1)(?:-|$)/,
  /^gpt-5(?:[-.].*)?$/,
  /^o[134](?:-|$)/,
] as const;

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
    id: 'unicompapi',
    name: 'UniCompAPI',
    category: 'multi',
    providerType: 'unicompapi',
    protocol: 'openai-chat-completions',
    baseUrl: 'https://unicompapi.com/v1',
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
    imageEditing: false,
    videoGeneration: false,
  };
}

export function inferKnownModelCapabilities(
  providerType: string,
  modelId: string,
): ProviderModelCapabilities {
  const capabilities = emptyModelCapabilities();
  const normalized = modelId.toLowerCase();
  if (providerType === 'unicompapi') return inferUniCompApiCapabilities(normalized);
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

function inferUniCompApiCapabilities(modelId: string): ProviderModelCapabilities {
  const capabilities = emptyModelCapabilities();
  const features = new Set(UNICOMPAPI_MODEL_FEATURES[modelId] ?? []);
  capabilities.text = features.has('text_chat');
  capabilities.streaming = capabilities.text;
  capabilities.reasoning = features.has('text_reasoning');
  capabilities.tools = features.has('tools');
  capabilities.imageGeneration = features.has('text_to_image');
  capabilities.imageEditing = features.has('image_edit');
  capabilities.videoGeneration = features.has('text_to_video') || features.has('image_to_video');
  return capabilities;
}

const UNICOMPAPI_MODEL_FEATURES: Record<string, readonly string[]> = {
  'deepseek-r1-0528': ['text_chat', 'text_reasoning'],
  'deepseek-v3': ['text_chat', 'text_reasoning'],
  'deepseek-v3.2': ['text_chat', 'text_reasoning'],
  'deepseek-v3.2-exp': ['text_chat', 'text_reasoning'],
  'deepseek-v4-flash': ['text_chat', 'text_reasoning'],
  'deepseek-v4-pro': ['text_chat', 'text_reasoning'],
  'doubao-seedance-2-0-260128': ['text_to_video', 'image_to_video'],
  'doubao-seedance-2-0-fast-260128': ['text_to_video', 'image_to_video'],
  'doubao-seedream-5-0-260128': ['text_to_image'],
  'glm-4.6': ['text_chat', 'text_reasoning'],
  'glm-4.7': ['text_chat', 'text_reasoning'],
  'glm-5': ['text_chat', 'text_reasoning'],
  'glm-5.1': ['text_chat', 'text_reasoning'],
  'glm-5.2': ['text_chat', 'text_reasoning'],
  'gpt-5.6-luna': ['text_chat'],
  'gpt-5.6-sol': ['text_chat', 'tools'],
  'gpt-5.6-terra': ['text_chat'],
  'happyhorse-1.0-i2v': ['image_to_video'],
  'happyhorse-1.0-r2v': [],
  'happyhorse-1.0-t2v': ['text_to_video'],
  'happyhorse-1.0-video-edit': [],
  'happyhorse-1.1-i2v': ['image_to_video'],
  'happyhorse-1.1-r2v': [],
  'happyhorse-1.1-t2v': ['text_to_video'],
  'kimi-k2.6': ['text_chat'],
  'kling-v3-turbo': ['text_to_video', 'image_to_video'],
  'qwen-image': ['text_to_image'],
  'qwen-image-edit-2509': ['image_edit'],
  'qwen3-235b-a22b': ['text_chat', 'text_reasoning'],
  'qwen3-32b': ['text_chat', 'text_reasoning'],
  viduq3: ['image_to_video'],
  'viduq3-mix': ['image_to_video'],
  'viduq3-pro': ['text_to_video'],
  'viduq3-turbo': ['text_to_video', 'image_to_video'],
};

export function hasAnyModelCapability(capabilities: ProviderModelCapabilities): boolean {
  return Object.values(capabilities).some(Boolean);
}

/**
 * Resolves the independently verified transport gate for Agent tool loops.
 * Model capabilities are intentionally checked separately so a manually
 * labelled model can never grant an unverified provider route access.
 */
export function resolveAgentToolLoopRoute(
  profile: ProviderProfileInfo,
  model: ProviderModelInfo,
): ProviderToolLoopRoute | undefined {
  if (
    profile.providerType !== VERIFIED_AGENT_TOOL_LOOP_ROUTE.providerType ||
    profile.accessType !== VERIFIED_AGENT_TOOL_LOOP_ROUTE.accessType ||
    profile.protocol !== VERIFIED_AGENT_TOOL_LOOP_ROUTE.protocol ||
    profile.baseUrl !== VERIFIED_AGENT_TOOL_LOOP_ROUTE.baseUrl ||
    model.providerProfileId !== profile.id
  ) {
    if (
      profile.providerType === VERIFIED_UNICOMPAPI_TOOL_LOOP_ROUTE.providerType &&
      profile.accessType === VERIFIED_UNICOMPAPI_TOOL_LOOP_ROUTE.accessType &&
      profile.protocol === VERIFIED_UNICOMPAPI_TOOL_LOOP_ROUTE.protocol &&
      profile.baseUrl === VERIFIED_UNICOMPAPI_TOOL_LOOP_ROUTE.baseUrl &&
      model.providerProfileId === profile.id &&
      model.remoteModelId.trim().toLowerCase() === 'gpt-5.6-sol'
    ) {
      return VERIFIED_UNICOMPAPI_TOOL_LOOP_ROUTE;
    }
    return undefined;
  }
  return OPENAI_RESPONSES_AGENT_MODEL_ALLOWLIST.some((pattern) =>
    pattern.test(model.remoteModelId.trim().toLowerCase()),
  )
    ? VERIFIED_AGENT_TOOL_LOOP_ROUTE
    : undefined;
}

export function assertAgentToolLoopSelection(
  profile: ProviderProfileInfo,
  model: ProviderModelInfo | undefined,
): ProviderToolLoopRoute {
  if (!model?.capabilities.text || !model.capabilities.streaming || !model.capabilities.tools) {
    throw new AgentProviderCapabilityError(
      'MODEL_TOOLS_REQUIRED',
      'The selected Agent model must support text generation, streaming, and tools.',
    );
  }
  const route = resolveAgentToolLoopRoute(profile, model);
  if (!route) {
    throw new AgentProviderCapabilityError(
      'PROVIDER_TOOL_LOOP_REQUIRED',
      'The selected Provider route has not passed the Agent tool-loop verification gate.',
    );
  }
  return route;
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
