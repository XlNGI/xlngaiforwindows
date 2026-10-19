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

export function supportsProductionAudioUpload(
  adapter:
    | {
        provider: string;
        contractId?: string;
        contractRevision?: number;
      }
    | undefined,
): boolean {
  return Boolean(
    adapter &&
    mediaModelBindings.some(
      (binding) =>
        binding.providerType === adapter.provider &&
        binding.contractId === adapter.contractId &&
        binding.contractRevision === adapter.contractRevision &&
        binding.status === 'enabled' &&
        binding.inputTransport?.audio === 'upload',
    ),
  );
}

/** New tasks use the highest registered revision; older bindings remain for frozen task recovery. */
export function currentMediaModelBinding(providerType: string, remoteModelId: string) {
  return mediaModelBindings
    .filter(
      (binding) => binding.providerType === providerType && binding.remoteModelId === remoteModelId,
    )
    .sort((left, right) => right.contractRevision - left.contractRevision)[0];
}

export function isWanMediaAdapter(
  adapter: { provider: string; contractId?: string; contractRevision?: number } | undefined,
): boolean {
  return Boolean(
    adapter &&
    (adapter.provider === 'wan-video' || adapter.provider === 'unicompapi') &&
    (adapter.contractId === 'cn.qwen.wan3-0-video' ||
      adapter.contractId === 'cn.qwen.wan3-0-video-prime') &&
    adapter.contractRevision === 3,
  );
}

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
    const binding = currentMediaModelBinding(selection.providerType, selection.remoteModelId);
    return Boolean(
      binding &&
      binding.contractId === adapter.contractId &&
      binding.contractRevision === (adapter.contractRevision ?? 1) &&
      binding.status === 'enabled',
    );
  }
  return selection.providerType === 'unicompapi'
    ? Boolean(selection.parameterTemplateKey) && adapter.model === selection.parameterTemplateKey
    : adapter.model === selection.remoteModelId;
}
