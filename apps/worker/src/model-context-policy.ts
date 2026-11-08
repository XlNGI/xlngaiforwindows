import type { ModelCapabilities } from '@ai-video/contracts';

export const DEFAULT_UNKNOWN_MODEL_CONTEXT_WINDOW = 512_000;
/** Unknown-model defaults guide projection; they do not establish a provider hard limit. */
export function hasVerifiedContextLimit(runtime: {
  modelCapabilities?: { capabilitySource: string };
  contextWindowSource?: string;
}): boolean {
  return runtime.modelCapabilities
    ? runtime.modelCapabilities.capabilitySource !== 'fallback'
    : runtime.contextWindowSource === 'contract';
}
export function validateContextLimits(
  value: Omit<ModelCapabilities, 'modelId'>,
): Omit<ModelCapabilities, 'modelId'> {
  if (!value || !Number.isSafeInteger(value.contextWindow) || value.contextWindow < 1)
    throw new Error('contextWindow must be a positive integer.');
  if (
    value.tokenizer !== undefined &&
    (typeof value.tokenizer !== 'string' || !value.tokenizer.trim())
  )
    throw new Error('Invalid tokenizer.');
  if (value.supportsCompaction !== undefined && typeof value.supportsCompaction !== 'boolean')
    throw new Error('Invalid compaction support.');
  for (const [key, n] of Object.entries({
    contextWindow: value.contextWindow,
    maxInputTokens: value.maxInputTokens,
    maxOutputTokens: value.maxOutputTokens,
  }))
    if (n !== undefined && (!Number.isSafeInteger(n) || n < 1))
      throw new Error(`${key} must be a positive integer.`);
  if (value.maxInputTokens !== undefined && value.maxInputTokens > value.contextWindow)
    throw new Error('Max input exceeds context window.');
  if (value.maxOutputTokens !== undefined && value.maxOutputTokens > value.contextWindow)
    throw new Error('Max output exceeds context window.');
  if (!['provider', 'model_registry', 'manual_config', 'fallback'].includes(value.capabilitySource))
    throw new Error('Invalid capability source.');
  return { ...value };
}
export function conservativeModelCapabilities(modelId: string): ModelCapabilities {
  const configured = Number(
    process.env.AGENT_UNKNOWN_MODEL_CONTEXT_WINDOW ?? DEFAULT_UNKNOWN_MODEL_CONTEXT_WINDOW,
  );
  const contextWindow =
    Number.isSafeInteger(configured) && configured >= 4096
      ? configured
      : DEFAULT_UNKNOWN_MODEL_CONTEXT_WINDOW;
  return {
    modelId,
    contextWindow,
    capabilitySource: 'fallback',
  };
}
