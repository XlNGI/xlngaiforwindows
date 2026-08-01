import { invoke } from '@tauri-apps/api/core';

export interface CredentialStatus {
  provider: string;
  configured: boolean;
}

function requireTauri(): void {
  if (!('__TAURI_INTERNALS__' in window)) {
    throw new Error('安全凭据仅能在桌面应用中配置。');
  }
}

export function canUseSecureCredentials(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

export async function getCredentialStatus(provider: string): Promise<CredentialStatus> {
  requireTauri();
  return invoke<CredentialStatus>('credential_status', { provider });
}

export async function setCredential(provider: string, secret: string): Promise<CredentialStatus> {
  requireTauri();
  return invoke<CredentialStatus>('credential_set', { provider, secret });
}

export async function deleteCredential(provider: string): Promise<CredentialStatus> {
  requireTauri();
  return invoke<CredentialStatus>('credential_delete', { provider });
}
