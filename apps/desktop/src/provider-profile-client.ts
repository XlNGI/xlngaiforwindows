import { invoke } from '@tauri-apps/api/core';
import type {
  ModelPricingInfo,
  ModelPricingUpdateParams,
  ProviderConnectionResult,
  ProviderDefaultUpdateParams,
  ProviderModelCreateParams,
  ProviderModelInfo,
  ProviderModelUpdateParams,
  ProviderProfileCreateParams,
  ProviderProfileInfo,
  ProviderProfileUpdateParams,
  ModelBinding,
  ModelBindingEnableParams,
  ModelContract,
  ModelContractEnableParams,
  ProtocolAdapter,
  TaskAdapter,
} from '@ai-video/contracts';
import { callWorker } from './worker-client';

function requireTauri(): void {
  if (!('__TAURI_INTERNALS__' in window)) {
    throw new Error('连接测试和安全密钥仅能在桌面应用中使用。');
  }
}

export const providerProfileClient = {
  listDefinitions: () => callWorker('provider.definition.list', {}),
  listProfiles: () => callWorker('provider.profile.list', {}),
  createProfile: (params: ProviderProfileCreateParams): Promise<ProviderProfileInfo> =>
    callWorker('provider.profile.create', params),
  updateProfile: (params: ProviderProfileUpdateParams): Promise<ProviderProfileInfo> =>
    callWorker('provider.profile.update', params),
  archiveProfile: (profileId: string): Promise<ProviderProfileInfo> =>
    callWorker('provider.profile.archive', { profileId }),
  listModels: (profileId: string): Promise<ProviderModelInfo[]> =>
    callWorker('provider.model.list', { profileId }),
  createManualModel: (params: ProviderModelCreateParams): Promise<ProviderModelInfo> =>
    callWorker('provider.model.createManual', params),
  updateModel: (params: ProviderModelUpdateParams): Promise<ProviderModelInfo> =>
    callWorker('provider.model.update', params),
  listModelContracts: (status?: ModelContract['status']): Promise<ModelContract[]> =>
    callWorker('model.contract.list', status ? { status } : {}),
  getModelContract: (contractId: string, contractRevision = 1): Promise<ModelContract | null> =>
    callWorker('model.contract.get', { contractId, contractRevision }),
  setModelContractEnabled: (params: ModelContractEnableParams): Promise<ModelContract> =>
    callWorker('model.contract.setEnabled', params),
  listModelBindings: (providerType?: string): Promise<ModelBinding[]> =>
    callWorker('model.binding.list', providerType ? { providerType } : {}),
  setModelBindingEnabled: (params: ModelBindingEnableParams): Promise<ModelBinding> =>
    callWorker('model.binding.setEnabled', params),
  listProtocolAdapters: (): Promise<ProtocolAdapter[]> => callWorker('model.protocol.list', {}),
  listTaskAdapters: (): Promise<TaskAdapter[]> => callWorker('model.task-adapter.list', {}),
  listModelPricing: (profileId: string): Promise<ModelPricingInfo[]> =>
    callWorker('provider.model.pricing.list', { profileId }),
  updateModelPricing: (params: ModelPricingUpdateParams): Promise<ModelPricingInfo> =>
    callWorker('provider.model.pricing.update', params),
  listProviderDefaults: () => callWorker('provider.default.list', {}),
  updateProviderDefault: (params: ProviderDefaultUpdateParams) =>
    callWorker('provider.default.update', params),
  testConnection: async (profileId: string): Promise<ProviderConnectionResult> => {
    requireTauri();
    return invoke<ProviderConnectionResult>('provider_test_connection', { profileId });
  },
};
