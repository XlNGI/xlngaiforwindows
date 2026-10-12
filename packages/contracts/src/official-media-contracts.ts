import contracts from './official-video-contracts.json' with { type: 'json' };
import imageContracts from './official-image-contracts.json' with { type: 'json' };
import bindings from './media-model-bindings.json' with { type: 'json' };
import type { ModelBinding, ModelContract } from './index.js';

/** Official semantics and channel bindings are separate, shared data records. */
export const officialVideoContracts: readonly ModelContract[] = contracts as ModelContract[];
export const officialImageContracts: readonly ModelContract[] = imageContracts as ModelContract[];
export const mediaModelBindings: readonly ModelBinding[] = bindings as ModelBinding[];

export function adapterBindsCatalogModel(
  adapter: { provider: string; model: string; contractId?: string; apiVersion?: string },
  selection: {
    providerType: string;
    remoteModelId: string;
    parameterTemplateKey?: string;
    contractStatus?: string;
  },
): boolean {
  if (adapter.provider !== selection.providerType) return false;
  if (adapter.apiVersion === 'contract-1') {
    if (selection.contractStatus && selection.contractStatus !== 'enabled') return false;
    return mediaModelBindings.some(
      (binding) =>
        binding.providerType === selection.providerType &&
        binding.remoteModelId === selection.remoteModelId &&
        binding.contractId === adapter.contractId &&
        binding.status === 'enabled',
    );
  }
  return selection.providerType === 'unicompapi'
    ? Boolean(selection.parameterTemplateKey) && adapter.model === selection.parameterTemplateKey
    : adapter.model === selection.remoteModelId;
}
