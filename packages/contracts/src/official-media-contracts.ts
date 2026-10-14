import contracts from './official-video-contracts.json' with { type: 'json' };
import imageContracts from './official-image-contracts.json' with { type: 'json' };
import videoAudioContracts from './official-video-audio-contracts.json' with { type: 'json' };
import bindings from './media-model-bindings.json' with { type: 'json' };
import type { ModelBinding, ModelContract } from './index.js';

/** Official semantics and channel bindings are separate, shared data records. */
export const officialVideoContracts: readonly ModelContract[] = contracts as ModelContract[];
export const officialImageContracts: readonly ModelContract[] = imageContracts as ModelContract[];
/** Verified semantics only: channel enablement still requires a separate binding. */
export const officialVideoAudioContracts: readonly ModelContract[] =
  videoAudioContracts as ModelContract[];
export const mediaModelBindings: readonly ModelBinding[] = bindings as ModelBinding[];

export function adapterBindsCatalogModel(
  adapter: {
    provider: string;
    model: string;
    contractId?: string;
    contractRevision?: number;
    apiVersion?: string;
  },
  selection: {
    providerType: string;
    remoteModelId: string;
    parameterTemplateKey?: string;
    contractStatus?: string;
  },
): boolean {
  if (adapter.provider !== selection.providerType) return false;
  if (/^contract-\d+$/u.test(adapter.apiVersion ?? '')) {
    if (selection.contractStatus && selection.contractStatus !== 'enabled') return false;
    return mediaModelBindings.some(
      (binding) =>
        binding.providerType === selection.providerType &&
        binding.remoteModelId === selection.remoteModelId &&
        binding.contractId === adapter.contractId &&
        binding.contractRevision === (adapter.contractRevision ?? 1) &&
        binding.status === 'enabled',
    );
  }
  return selection.providerType === 'unicompapi'
    ? Boolean(selection.parameterTemplateKey) && adapter.model === selection.parameterTemplateKey
    : adapter.model === selection.remoteModelId;
}
