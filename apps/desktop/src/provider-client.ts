import { invoke } from '@tauri-apps/api/core';
import type { AdapterParameters } from '@ai-video/contracts';

export type ProviderRegion = 'global' | 'cn';

export interface NativeProviderResponse {
  status: number;
  body: unknown;
}

export interface NativeProviderTaskSubmitResponse {
  status: number;
  taskId?: string;
  state?: string;
}

export interface NativeProviderCancelResponse {
  supported: boolean;
  cancelled: boolean;
  status: number;
}

function requireDesktopTransport(): void {
  if (!('__TAURI_INTERNALS__' in window)) {
    throw new Error('供应商请求只能由桌面应用的安全传输层发送。');
  }
}

export async function submitProviderRequest(
  adapterKey: string,
  payload: AdapterParameters,
  providerProfileId: string,
  providerRegion?: ProviderRegion,
): Promise<NativeProviderResponse> {
  requireDesktopTransport();
  return invoke<NativeProviderResponse>('provider_submit', {
    adapterKey,
    payload,
    providerProfileId,
    providerRegion,
  });
}

export async function submitVideoProviderTask(
  adapterKey: string,
  payload: AdapterParameters,
  providerProfileId: string,
  providerRegion?: ProviderRegion,
): Promise<NativeProviderTaskSubmitResponse> {
  requireDesktopTransport();
  return invoke<NativeProviderTaskSubmitResponse>('provider_submit_task', {
    adapterKey,
    payload,
    providerProfileId,
    providerRegion,
  });
}

export async function pollVideoProviderTask(
  adapterKey: string,
  providerProfileId: string | undefined,
  taskId: string,
  providerRegion?: ProviderRegion,
): Promise<NativeProviderResponse> {
  requireDesktopTransport();
  return invoke<NativeProviderResponse>('provider_poll_task', {
    adapterKey,
    providerProfileId,
    providerRegion,
    taskId,
  });
}

export async function cancelVideoProviderTask(
  adapterKey: string,
  providerProfileId: string | undefined,
  taskId: string,
  providerRegion?: ProviderRegion,
): Promise<NativeProviderCancelResponse> {
  requireDesktopTransport();
  return invoke<NativeProviderCancelResponse>('provider_cancel_task', {
    adapterKey,
    providerProfileId,
    providerRegion,
    taskId,
  });
}
