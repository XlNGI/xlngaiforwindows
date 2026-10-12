import type {
  ContractFieldMapping,
  ContractTransport,
  ModelBinding,
  ModelContract,
  ModelContractCapabilities,
  ModelCatalogStatus,
  TaskAdapter,
  ProtocolAdapter,
} from '@ai-video/contracts';
import {
  officialImageContracts,
  officialVideoContracts,
  mediaModelBindings,
} from '@ai-video/contracts';

/**
 * Canonical model contracts are deliberately data-only.  Provider and task
 * adapters consume these records; they must not infer capabilities from a
 * remote model name.
 */
const CONTRACTS: readonly ModelContract[] = [
  ...officialVideoContracts.map((contract) => structuredClone(contract)),
  ...officialImageContracts.map((contract) => structuredClone(contract)),
  textContract(
    'cn.deepseek.v4-pro',
    'DeepSeek-V4-Pro-0813',
    'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
  ),
  textContract(
    'cn.deepseek.v4.1-flash',
    'DeepSeek-V4.1-Flash',
    'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
    { vision: true, imageInput: true },
  ),
  textContract('cn.zhipu.glm-5', 'GLM-5', 'https://docs.bigmodel.cn/cn/guide/models/text/glm-5'),
  textContract(
    'cn.zhipu.glm-5.3',
    'GLM-5.3',
    'https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3',
  ),
  textContract(
    'cn.zhipu.glm-5.3-flash',
    'GLM-5.3-Flash',
    'https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash',
    { vision: true, imageInput: true },
  ),
  textContract('cn.kimi.k3', 'Kimi K3', 'https://platform.kimi.com/docs/guide/kimi-k3-quickstart'),
  textContract('cn.minimax.m3', 'MiniMax-M3', 'https://www.minimax.cn/models/text/m3'),
  textContract('cn.minimax.h3', 'MiniMax-H3', 'https://www.minimax.io/blog/minimax-h3'),
  imageContract(
    'cn.qwen.image.latest',
    'Qwen-Image latest',
    'https://www.alibabacloud.com/help/en/model-studio/',
  ),
  imageContract(
    'media.openai-compatible-image',
    'OpenAI-compatible image generation',
    'https://unicompapi.com',
  ),
  videoContract(
    'media.openai-compatible-video',
    'OpenAI-compatible video generation',
    'https://unicompapi.com',
  ),
  videoContract(
    'vidu.q3.start-end-video',
    'Vidu Q3 start/end video',
    'https://platform.vidu.com/docs/start-end-to-video',
  ),
  videoContract(
    'vidu.q3.reference-video',
    'Vidu Q3 reference video',
    'https://platform.vidu.com/docs/reference-to-video',
  ),
];

const BINDINGS: readonly ModelBinding[] = [
  ...mediaModelBindings.map((binding) => structuredClone(binding)),
  binding(
    'deepseek-v4-pro',
    'deepseek',
    'deepseek-v4-pro',
    'cn.deepseek.v4-pro',
    'deepseek-official',
  ),
  binding(
    'deepseek-flash',
    'deepseek',
    'deepseek-flash',
    'cn.deepseek.v4.1-flash',
    'deepseek-official',
  ),
  binding('glm-5', 'zhipu', 'glm-5', 'cn.zhipu.glm-5', 'zhipu-official'),
  binding('glm-5.3', 'zhipu', 'glm-5.3', 'cn.zhipu.glm-5.3', 'zhipu-official'),
  binding('glm-5.3-flash', 'zhipu', 'glm-5.3-flash', 'cn.zhipu.glm-5.3-flash', 'zhipu-official'),
  binding('kimi-k3', 'kimi', 'kimi-k3', 'cn.kimi.k3', 'kimi-official'),
  binding('minimax-m3', 'minimax', 'MiniMax-M3', 'cn.minimax.m3', 'minimax-official'),
  binding('minimax-h3', 'minimax', 'MiniMax-H3', 'cn.minimax.h3', 'minimax-official'),
  binding('qwen-image-latest', 'qwen', 'qwen-image', 'cn.qwen.image.latest', 'qwen-official'),
  binding('vidu-q3-reference-video', 'vidu', 'viduq3', 'vidu.q3.reference-video', 'vidu-official'),
  binding(
    'unicomp-deepseek-v4-pro',
    'unicompapi',
    'deepseek-v4-pro',
    'cn.deepseek.v4-pro',
    'unicompapi',
  ),
  binding(
    'unicomp-deepseek-flash',
    'unicompapi',
    'deepseek-flash',
    'cn.deepseek.v4.1-flash',
    'unicompapi',
  ),
  binding(
    'unicomp-deepseek-v4-flash',
    'unicompapi',
    'deepseek-v4-flash',
    'cn.deepseek.v4.1-flash',
    'unicompapi',
  ),
  binding(
    'unicomp-deepseek-v4-flash-0731',
    'unicompapi',
    'deepseek-v4-flash-0731',
    'cn.deepseek.v4.1-flash',
    'unicompapi',
  ),
  binding('unicomp-glm-5', 'unicompapi', 'glm-5', 'cn.zhipu.glm-5', 'unicompapi'),
  binding('unicomp-glm-5.3', 'unicompapi', 'glm-5.3', 'cn.zhipu.glm-5.3', 'unicompapi'),
  binding(
    'unicomp-glm-5.3-flash',
    'unicompapi',
    'glm-5.3-flash',
    'cn.zhipu.glm-5.3-flash',
    'unicompapi',
  ),
  binding('unicomp-kimi-k3', 'unicompapi', 'kimi-k3', 'cn.kimi.k3', 'unicompapi'),
  binding('unicomp-minimax-m3', 'unicompapi', 'MiniMax-M3', 'cn.minimax.m3', 'unicompapi'),
  binding('unicomp-minimax-h3', 'unicompapi', 'MiniMax-H3', 'cn.minimax.h3', 'unicompapi'),
  binding('unicomp-qwen-image', 'unicompapi', 'qwen-image', 'cn.qwen.image.latest', 'unicompapi'),
  binding('unicomp-viduq3', 'unicompapi', 'viduq3', 'vidu.q3.reference-video', 'unicompapi'),
];

const CONFIRMED_CONTRACT_IDS = new Set([
  'cn.deepseek.v4-pro',
  'cn.deepseek.v4.1-flash',
  'cn.zhipu.glm-5',
  'cn.zhipu.glm-5.3',
  'cn.zhipu.glm-5.3-flash',
  'cn.kimi.k3',
  'cn.minimax.m3',
  'cn.minimax.h3',
  'cn.qwen.image.latest',
  'vidu.q3.reference-video',
]);

for (const contract of CONTRACTS) {
  if (CONFIRMED_CONTRACT_IDS.has(contract.contractId)) contract.status = 'enabled';
}
for (const binding of BINDINGS) {
  if (binding.providerType === 'unicompapi') binding.status = 'enabled';
}

const PROTOCOL_ADAPTERS: readonly ProtocolAdapter[] = [
  {
    id: 'openai-compatible-video-v1',
    protocol: 'openai-compatible-video',
    providerTypes: ['unicompapi'],
    transport: { protocolFamily: 'openai-compatible-video', request: [], response: [] },
    supportsStreaming: false,
    supportsToolCalls: false,
  },
  {
    id: 'dashscope-video-v1',
    protocol: 'dashscope-video',
    providerTypes: ['qwen'],
    transport: { protocolFamily: 'dashscope-video', request: [], response: [] },
    supportsStreaming: false,
    supportsToolCalls: false,
  },
  {
    id: 'openai-chat-completions-v1',
    protocol: 'openai-chat-completions',
    providerTypes: ['deepseek', 'minimax', 'qwen', 'zhipu', 'unicompapi', 'custom'],
    transport: chatTransport(),
    supportsStreaming: true,
    supportsToolCalls: true,
  },
  {
    id: 'openai-responses-v1',
    protocol: 'openai-responses',
    providerTypes: ['openai', 'zhipu', 'custom'],
    transport: {
      protocolFamily: 'openai-responses',
      request: [{ operation: 'copy', from: 'input', to: 'input' }],
      response: [
        { operation: 'extract', from: 'id', to: 'providerResponseId' },
        { operation: 'extract', from: 'output_text', to: 'content' },
      ],
    },
    supportsStreaming: true,
    supportsToolCalls: true,
  },
  {
    id: 'vidu-v2-media-v1',
    protocol: 'vidu-v2',
    providerTypes: ['vidu'],
    transport: {
      protocolFamily: 'vidu-v2',
      request: [],
      response: [],
    },
    supportsStreaming: false,
    supportsToolCalls: false,
  },
];

const TASK_ADAPTERS: readonly TaskAdapter[] = [
  ...officialVideoContracts.map((contract): TaskAdapter => ({
    id: `${contract.contractId}-v${contract.contractRevision}`,
    capability: contract.taskCapability!,
    contractId: contract.contractId,
    contractRevision: contract.contractRevision,
    protocolAdapterId:
      mediaModelBindings.find((binding) => binding.contractId === contract.contractId)
        ?.providerType === 'unicompapi'
        ? 'openai-compatible-video-v1'
        : 'dashscope-video-v1',
    lifecycle: structuredClone(contract.lifecycle),
    parameterSchema: structuredClone(contract.parameterSchema),
  })),
  {
    id: 'image-generation-v1',
    capability: 'image-generation',
    contractId: 'media.openai-compatible-image',
    contractRevision: 1,
    protocolAdapterId: 'openai-chat-completions-v1',
    lifecycle: { mode: 'synchronous', output: 'data[0].url' },
    parameterSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: { prompt: { type: 'string' } },
    },
  },
  {
    id: 'video-generation-v1',
    capability: 'video-generation',
    contractId: 'media.openai-compatible-video',
    contractRevision: 1,
    protocolAdapterId: 'openai-chat-completions-v1',
    lifecycle: {
      mode: 'asynchronous',
      submit: '/v1/videos',
      status: '/v1/videos/{taskId}',
      output: 'content.url',
    },
    parameterSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: { prompt: { type: 'string' } },
    },
  },
  {
    id: 'vidu-reference-video-v1',
    capability: 'reference-video',
    contractId: 'vidu.q3.reference-video',
    contractRevision: 1,
    protocolAdapterId: 'vidu-v2-media-v1',
    lifecycle: {
      mode: 'asynchronous',
      submit: '/ent/v2/reference2video',
      status: '/ent/v2/tasks/{taskId}',
      cancel: '/ent/v2/tasks/{taskId}/cancel',
      output: 'creations[0].url',
    },
    parameterSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt', 'images'],
      properties: { prompt: { type: 'string' }, images: { type: 'array' } },
    },
  },
];

export class ModelContractRegistryError extends Error {}

export function listModelContracts(status?: ModelCatalogStatus): ModelContract[] {
  return CONTRACTS.filter((contract) => !status || contract.status === status).map(cloneContract);
}

export function getModelContract(
  contractId: string,
  contractRevision = 1,
): ModelContract | undefined {
  const contract = CONTRACTS.find(
    (candidate) =>
      candidate.contractId === contractId && candidate.contractRevision === contractRevision,
  );
  return contract ? cloneContract(contract) : undefined;
}

export function listModelBindings(status?: ModelCatalogStatus): ModelBinding[] {
  return BINDINGS.filter((binding) => !status || binding.status === status).map(cloneBinding);
}

export function listProtocolAdapters(): ProtocolAdapter[] {
  return PROTOCOL_ADAPTERS.map((adapter) => structuredClone(adapter));
}

export function resolveProtocolAdapter(protocol: string): ProtocolAdapter | undefined {
  const adapter = PROTOCOL_ADAPTERS.find((candidate) => candidate.protocol === protocol);
  return adapter ? structuredClone(adapter) : undefined;
}

export function listTaskAdapters(): TaskAdapter[] {
  return TASK_ADAPTERS.map((adapter) => structuredClone(adapter));
}

export function setCatalogStatus<T extends ModelContract | ModelBinding>(
  item: T,
  enabled: boolean,
): T {
  return {
    ...structuredClone(item),
    status: enabled ? 'enabled' : 'verified',
  };
}

export function setRegisteredContractStatus(
  contractId: string,
  contractRevision: number,
  status: ModelCatalogStatus,
): void {
  const contract = CONTRACTS.find(
    (candidate) =>
      candidate.contractId === contractId && candidate.contractRevision === contractRevision,
  );
  if (contract) contract.status = status;
}

export function setRegisteredBindingStatus(bindingId: string, status: ModelCatalogStatus): void {
  const binding = BINDINGS.find((candidate) => candidate.bindingId === bindingId);
  if (binding) binding.status = status;
}

export function resolveModelBinding(
  providerType: string,
  remoteModelId: string,
): { binding: ModelBinding; contract: ModelContract } | undefined {
  const binding = BINDINGS.find(
    (candidate) =>
      candidate.providerType === providerType && candidate.remoteModelId === remoteModelId,
  );
  if (!binding) return undefined;
  const contract = getModelContract(binding.contractId, binding.contractRevision);
  if (!contract) {
    throw new ModelContractRegistryError(
      `Model binding ${binding.bindingId} references a missing contract.`,
    );
  }
  return { binding: cloneBinding(binding), contract };
}

/** Apply only declarative overrides. Unknown mapping operations fail closed. */
export function resolveEffectiveTransport(
  contract: ModelContract,
  binding: ModelBinding,
): ContractTransport {
  assertBindingContract(binding, contract);
  const transport = binding.transportOverride
    ? {
        ...contract.transport,
        ...binding.transportOverride,
        request: binding.transportOverride.request ?? contract.transport.request,
        response: binding.transportOverride.response ?? contract.transport.response,
      }
    : contract.transport;
  validateMappings(transport.request);
  validateMappings(transport.response);
  return structuredClone(transport);
}

export function resolveEffectiveCapabilities(
  contract: ModelContract,
  binding: ModelBinding,
): ModelContractCapabilities {
  assertBindingContract(binding, contract);
  return {
    ...contract.capabilities,
    ...binding.capabilitiesOverride,
  };
}

function assertBindingContract(binding: ModelBinding, contract: ModelContract): void {
  if (
    binding.contractId !== contract.contractId ||
    binding.contractRevision !== contract.contractRevision
  ) {
    throw new ModelContractRegistryError('Model binding and contract revision do not match.');
  }
  if (binding.compatibility === 'incompatible') {
    throw new ModelContractRegistryError('Incompatible model bindings cannot be resolved.');
  }
  if (binding.status !== 'enabled') {
    throw new ModelContractRegistryError('Only enabled model bindings can be used at runtime.');
  }
  if (contract.status !== 'enabled') {
    throw new ModelContractRegistryError('Only enabled model contracts can be used at runtime.');
  }
}

function validateMappings(mappings: readonly ContractFieldMapping[]): void {
  const allowed = new Set<ContractFieldMapping['operation']>([
    'copy',
    'rename',
    'constant',
    'template',
    'enumMap',
    'unitConvert',
    'arrayMap',
    'conditional',
    'extract',
  ]);
  for (const mapping of mappings) {
    if (!allowed.has(mapping.operation) || !mapping.to.trim()) {
      throw new ModelContractRegistryError('Model contract contains an invalid transport mapping.');
    }
    if (mapping.operation !== 'constant' && !mapping.from?.trim()) {
      throw new ModelContractRegistryError(
        `Transport mapping ${mapping.operation} requires a source path.`,
      );
    }
  }
}

function textContract(
  contractId: string,
  officialModelName: string,
  sourceUrl: string,
  capabilityOverrides: Partial<ModelContractCapabilities> = {},
): ModelContract {
  return {
    contractId,
    contractRevision: 1,
    providerFamily: officialModelName.split('-')[0] ?? officialModelName,
    officialModelName,
    capabilities: {
      text: true,
      vision: false,
      imageInput: false,
      audioInput: false,
      videoInput: false,
      streaming: true,
      reasoning: true,
      tools: true,
      parallelToolCalls: true,
      toolChoice: true,
      structuredOutput: true,
      jsonMode: true,
      imageGeneration: false,
      imageEditing: false,
      videoGeneration: false,
      videoAsync: false,
      videoPolling: false,
      videoCancellation: false,
      maxContextTokens: 1_000_000,
      ...capabilityOverrides,
    },
    parameterSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['messages'],
      properties: {
        messages: { type: 'array', minItems: 1, description: '官方对话消息列表。' },
        temperature: { type: 'number', minimum: 0, maximum: 2, description: '采样温度。' },
        max_tokens: { type: 'integer', minimum: 1, description: '最大输出 token 数。' },
        tools: { type: 'array', description: '工具定义列表。' },
      },
    },
    transport: chatTransport(),
    lifecycle: { mode: 'synchronous' },
    source: {
      url: sourceUrl,
      title: `${officialModelName} API documentation`,
      checkedAt: '2026-10-10',
      locale: 'zh-CN',
      verificationStatus: 'pending',
    },
    status: 'discovered',
  };
}

function imageContract(
  contractId: string,
  officialModelName: string,
  sourceUrl: string,
): ModelContract {
  return {
    contractId,
    contractRevision: 1,
    providerFamily: 'qwen',
    officialModelName,
    capabilities: {
      text: false,
      vision: false,
      imageInput: true,
      audioInput: false,
      videoInput: false,
      streaming: false,
      reasoning: false,
      tools: false,
      parallelToolCalls: false,
      toolChoice: false,
      structuredOutput: false,
      jsonMode: false,
      imageGeneration: true,
      imageEditing: true,
      videoGeneration: false,
      videoAsync: false,
      videoPolling: false,
      videoCancellation: false,
      maxImages: 8,
      supportedImageFormats: ['png', 'jpeg', 'webp'],
    },
    parameterSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', minLength: 1, description: '官方图像提示词。' },
        images: { type: 'array', maxItems: 8, items: { type: 'string', format: 'uri' } },
        size: { type: 'string', description: '官方尺寸参数。' },
      },
    },
    transport: {
      protocolFamily: 'image-generation',
      request: [
        { operation: 'copy', from: 'prompt', to: 'prompt' },
        { operation: 'copy', from: 'images', to: 'images' },
        { operation: 'copy', from: 'size', to: 'size' },
      ],
      response: [{ operation: 'extract', from: 'data[0].url', to: 'outputUrl' }],
    },
    lifecycle: { mode: 'synchronous', output: 'outputUrl' },
    source: {
      url: sourceUrl,
      title: `${officialModelName} API documentation`,
      checkedAt: '2026-10-10',
      locale: 'zh-CN',
      verificationStatus: 'pending',
    },
    status: 'discovered',
  };
}

function videoContract(
  contractId: string,
  officialModelName: string,
  sourceUrl: string,
): ModelContract {
  return {
    contractId,
    contractRevision: 1,
    providerFamily: 'vidu',
    officialModelName,
    capabilities: {
      text: false,
      vision: false,
      imageInput: true,
      audioInput: false,
      videoInput: false,
      streaming: false,
      reasoning: false,
      tools: false,
      parallelToolCalls: false,
      toolChoice: false,
      structuredOutput: false,
      jsonMode: false,
      imageGeneration: false,
      imageEditing: false,
      videoGeneration: true,
      videoAsync: true,
      videoPolling: true,
      videoCancellation: true,
      maxImages: 7,
      supportedImageFormats: ['png', 'jpeg', 'webp'],
    },
    parameterSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt', 'images'],
      properties: {
        prompt: { type: 'string', minLength: 1, description: '官方视频提示词。' },
        images: {
          type: 'array',
          minItems: 1,
          maxItems: 7,
          items: { type: 'string', format: 'uri' },
        },
        duration: { type: 'integer', minimum: 1, maximum: 16, description: '视频时长（秒）。' },
      },
    },
    transport: {
      protocolFamily: 'vidu-v2',
      request: [
        { operation: 'copy', from: 'prompt', to: 'prompt' },
        { operation: 'copy', from: 'images', to: 'images' },
        { operation: 'copy', from: 'duration', to: 'duration' },
      ],
      response: [
        { operation: 'extract', from: 'task_id', to: 'taskId' },
        { operation: 'extract', from: 'state', to: 'state' },
      ],
    },
    lifecycle: {
      mode: 'asynchronous',
      submit: '/ent/v2/reference2video',
      status: '/ent/v2/tasks/{taskId}',
      cancel: '/ent/v2/tasks/{taskId}/cancel',
      output: 'creations[0].url',
    },
    source: {
      url: sourceUrl,
      title: `${officialModelName} API documentation`,
      checkedAt: '2026-10-10',
      locale: 'en-US',
      verificationStatus: 'pending',
    },
    status: 'discovered',
  };
}

function chatTransport(): ContractTransport {
  return {
    protocolFamily: 'openai-chat-completions',
    request: [{ operation: 'copy', from: 'messages', to: 'messages' }],
    response: [
      { operation: 'extract', from: 'id', to: 'providerResponseId' },
      { operation: 'extract', from: 'choices[0].message.content', to: 'content' },
    ],
  };
}

function binding(
  bindingId: string,
  providerType: string,
  remoteModelId: string,
  contractId: string,
  providerProfileId: string,
): ModelBinding {
  return {
    bindingId,
    providerProfileId,
    providerType,
    remoteModelId,
    contractId,
    contractRevision: 1,
    protocol: providerType === 'vidu' ? 'vidu-v2' : 'openai-chat-completions',
    compatibility: 'exact',
    status: 'discovered',
  };
}

function cloneContract(contract: ModelContract): ModelContract {
  return structuredClone(contract);
}

function cloneBinding(binding: ModelBinding): ModelBinding {
  return structuredClone(binding);
}
