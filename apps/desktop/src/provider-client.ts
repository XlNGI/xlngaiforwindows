import { invoke } from '@tauri-apps/api/core';
import type { AdapterParameters } from '@ai-video/contracts';

export interface NativeProviderResponse {
  status: number;
  body: unknown;
}

export async function submitProviderRequest(
  adapterKey: string,
  payload: AdapterParameters,
): Promise<NativeProviderResponse> {
  if (!('__TAURI_INTERNALS__' in window)) {
    throw new Error('供应商请求只能由桌面应用的安全传输层发送。');
  }
  return invoke<NativeProviderResponse>('provider_submit', { adapterKey, payload });
}
