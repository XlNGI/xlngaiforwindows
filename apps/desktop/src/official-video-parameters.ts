import type { AdapterDescriptor } from '@ai-video/contracts';
import { productionAudioSupport, supportsProductionAudioUpload } from '@ai-video/contracts';
export { addProductionRoleVoices as addOfficialRoleVoices } from '@ai-video/contracts';

export const isOfficialVoiceVideo = (adapter: AdapterDescriptor | undefined) =>
  Boolean(
    adapter &&
    supportsProductionAudioUpload(adapter) &&
    (productionAudioSupport(adapter).voiceReference ||
      productionAudioSupport(adapter).dialogueDriven),
  );
export const usesStructuredVideoParameters = (adapter: AdapterDescriptor | undefined) =>
  Boolean(
    adapter &&
    (adapter.parameterSchema.properties.media || adapter.parameterSchema.properties.content),
  );

// Compatibility export; all model input assembly lives in the shared projector.
import { seedProductionInputs } from '@ai-video/contracts';
export function seedOfficialVideoParameters(
  adapter: AdapterDescriptor,
  parameters: import('@ai-video/contracts').AdapterParameters,
  prompt?: string,
  images: string[] = [],
  replaceImages = false,
) {
  return seedProductionInputs(
    adapter,
    parameters,
    prompt,
    images.length || replaceImages ? images.map((url) => ({ url })) : undefined,
  );
}
