import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ProviderDefinitionInfo,
  ProviderModelCapabilities,
  ProviderProfileInfo,
} from '@ai-video/contracts';
import {
  canUseSecureCredentials,
  deleteCredential,
  getCredentialStatus,
  getLegacyProviderMigrationReport,
  setCredential,
} from '../credential-client';
import { providerProfileClient } from '../provider-profile-client';
import { ModelManagementView } from './ModelManagementView';
import { ProviderConnectionsView } from './ProviderConnectionsView';

vi.mock('../credential-client', () => ({
  canUseSecureCredentials: vi.fn(() => true),
  deleteCredential: vi.fn(),
  getCredentialStatus: vi.fn(),
  getLegacyProviderMigrationReport: vi.fn(),
  setCredential: vi.fn(),
}));

vi.mock('../provider-profile-client', () => ({
  providerProfileClient: {
    listDefinitions: vi.fn(),
    listProfiles: vi.fn(),
    createProfile: vi.fn(),
    updateProfile: vi.fn(),
    archiveProfile: vi.fn(),
    listModels: vi.fn(),
    listModelPricing: vi.fn(),
    listProviderDefaults: vi.fn(),
    createManualModel: vi.fn(),
    updateModel: vi.fn(),
    updateModelPricing: vi.fn(),
    updateProviderDefault: vi.fn(),
    testConnection: vi.fn(),
  },
}));

const definition: ProviderDefinitionInfo = {
  id: 'openai',
  name: 'OpenAI',
  category: 'llm',
  providerType: 'openai',
  accessType: 'official',
  protocol: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1',
};

const profile: ProviderProfileInfo = {
  id: '123e4567-e89b-42d3-a456-426614174000',
  name: 'OpenAI 主账号',
  category: 'llm',
  providerType: 'openai',
  accessType: 'official',
  protocol: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1',
  enabled: false,
  connectionStatus: 'draft',
  createdAt: '2026-08-03T00:00:00.000Z',
  updatedAt: '2026-08-03T00:00:00.000Z',
};

function capabilities(change: Partial<ProviderModelCapabilities> = {}): ProviderModelCapabilities {
  return {
    text: false,
    vision: false,
    streaming: false,
    reasoning: false,
    tools: false,
    structuredOutput: false,
    embeddings: false,
    imageGeneration: false,
    imageEditing: false,
    videoGeneration: false,
    ...change,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(canUseSecureCredentials).mockReturnValue(true);
  vi.mocked(providerProfileClient.listDefinitions).mockResolvedValue([definition]);
  vi.mocked(providerProfileClient.listModels).mockResolvedValue([]);
  vi.mocked(providerProfileClient.listModelPricing).mockResolvedValue([]);
  vi.mocked(providerProfileClient.listProviderDefaults).mockResolvedValue([]);
  vi.mocked(getCredentialStatus).mockResolvedValue({
    provider: profile.id,
    configured: true,
  });
  vi.mocked(getLegacyProviderMigrationReport).mockResolvedValue({ entries: [] });
  vi.mocked(setCredential).mockResolvedValue({ provider: profile.id, configured: true });
  vi.mocked(deleteCredential).mockResolvedValue({ provider: profile.id, configured: false });
});

afterEach(cleanup);

describe('ProviderConnectionsView', () => {
  it('clears a stored secret while retaining the form after a failed connection test', async () => {
    let profiles: ProviderProfileInfo[] = [];
    vi.mocked(providerProfileClient.listProfiles).mockImplementation(() =>
      Promise.resolve(profiles),
    );
    vi.mocked(providerProfileClient.createProfile).mockImplementation(() => {
      profiles = [profile];
      return Promise.resolve(profile);
    });
    vi.mocked(providerProfileClient.testConnection).mockResolvedValue({
      profile: {
        ...profile,
        connectionStatus: 'auth-failed',
        lastErrorMessage: 'Authentication failed.',
      },
      models: [],
      modelSyncStatus: 'not-attempted',
    });

    render(<ProviderConnectionsView />);
    fireEvent.click(await screen.findByRole('button', { name: /添加第一个供应商/ }));
    fireEvent.change(screen.getByLabelText('连接名称'), {
      target: { value: 'OpenAI 睡前账号' },
    });
    const secretInput = screen.getByLabelText('API Key');
    fireEvent.change(secretInput, { target: { value: 'test-only-secret' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并测试' }));

    await waitFor(() => expect(setCredential).toHaveBeenCalledWith(profile.id, 'test-only-secret'));
    expect(secretInput).toHaveValue('');
    expect(screen.getByLabelText('连接名称')).toHaveValue('OpenAI 睡前账号');
    expect(await screen.findByText('Authentication failed.')).toBeInTheDocument();
  });

  it('saves an OpenAI-compatible custom provider with an explicit protocol and Base URL', async () => {
    const customProfile: ProviderProfileInfo = {
      ...profile,
      name: 'Relay',
      providerType: 'custom',
      accessType: 'custom',
      protocol: 'openai-chat-completions',
      baseUrl: 'https://relay.example/v1',
      enabled: true,
      connectionStatus: 'ready',
    };
    let profiles: ProviderProfileInfo[] = [];
    vi.mocked(providerProfileClient.listProfiles).mockImplementation(() =>
      Promise.resolve(profiles),
    );
    vi.mocked(providerProfileClient.createProfile).mockImplementation(() => {
      profiles = [customProfile];
      return Promise.resolve(customProfile);
    });
    vi.mocked(providerProfileClient.testConnection).mockResolvedValue({
      profile: customProfile,
      models: [],
      modelSyncStatus: 'unsupported',
    });

    render(<ProviderConnectionsView />);
    fireEvent.click(await screen.findByRole('button', { name: /添加第一个供应商/ }));
    fireEvent.click(screen.getByRole('button', { name: /自定义供应商/ }));
    fireEvent.change(screen.getByLabelText('连接名称'), { target: { value: 'Relay' } });
    fireEvent.change(screen.getByLabelText('兼容协议'), {
      target: { value: 'openai-chat-completions' },
    });
    fireEvent.change(screen.getByLabelText('Base URL'), {
      target: { value: 'https://relay.example/v1' },
    });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'relay-key' } });
    fireEvent.click(screen.getByRole('button', { name: '保存并测试' }));

    await waitFor(() =>
      expect(providerProfileClient.createProfile).toHaveBeenCalledWith({
        name: 'Relay',
        category: 'llm',
        providerType: 'custom',
        accessType: 'custom',
        protocol: 'openai-chat-completions',
        baseUrl: 'https://relay.example/v1',
      }),
    );
  });

  it('surfaces completed legacy Vidu credential migration without removing rollback data', async () => {
    const migratedProfile = {
      ...profile,
      name: 'Vidu 中国站（旧版迁移）',
      category: 'multi' as const,
      providerType: 'vidu',
      protocol: 'vidu-v2',
      baseUrl: 'https://api.vidu.cn',
      migrationSource: 'vidu-cn' as const,
    };
    vi.mocked(providerProfileClient.listProfiles).mockResolvedValue([migratedProfile]);
    vi.mocked(getLegacyProviderMigrationReport).mockResolvedValue({
      entries: [
        {
          source: 'vidu-cn',
          status: 'migrated',
          profileId: migratedProfile.id,
          message: 'retained',
        },
      ],
    });

    render(<ProviderConnectionsView />);

    expect(await screen.findByText(/旧版密钥已复制到独立连接/)).toBeInTheDocument();
    expect(screen.getByText(/旧版迁移 · vidu-v2/)).toBeInTheDocument();
  });
});

describe('ModelManagementView', () => {
  it('filters the flat model list by remote ID or display name', () => {
    const models = [
      {
        id: '123e4567-e89b-42d3-a456-426614174001',
        providerProfileId: profile.id,
        remoteModelId: 'qwen-image-plus',
        displayName: 'Qwen Image Plus',
        capabilities: capabilities({ imageGeneration: true }),
        source: 'remote' as const,
        enabled: false,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
      },
      {
        id: '123e4567-e89b-42d3-a456-426614174002',
        providerProfileId: profile.id,
        remoteModelId: 'deepseek-chat',
        displayName: 'DeepSeek Chat',
        capabilities: capabilities({ text: true, streaming: true }),
        source: 'remote' as const,
        enabled: false,
        createdAt: profile.createdAt,
        updatedAt: profile.updatedAt,
      },
    ];
    render(
      <ModelManagementView
        profile={profile}
        models={models}
        pricing={[]}
        defaults={[]}
        busy={false}
        onSynchronize={vi.fn()}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        onUpdatePricing={vi.fn()}
        onUpdateDefault={vi.fn()}
      />,
    );

    expect(screen.getByDisplayValue('Qwen Image Plus')).toBeInTheDocument();
    expect(screen.getByDisplayValue('DeepSeek Chat')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'deepseek' } });
    expect(screen.queryByDisplayValue('Qwen Image Plus')).not.toBeInTheDocument();
    expect(screen.getByDisplayValue('DeepSeek Chat')).toBeInTheDocument();
  });

  it('creates a manual model with user-selected capabilities and leaves it disabled', async () => {
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(
      <ModelManagementView
        profile={profile}
        models={[]}
        pricing={[]}
        defaults={[]}
        busy={false}
        onSynchronize={vi.fn()}
        onCreate={onCreate}
        onUpdate={vi.fn()}
        onUpdatePricing={vi.fn()}
        onUpdateDefault={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /手动添加/ }));
    fireEvent.change(screen.getByLabelText('模型 ID'), { target: { value: 'relay-model' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '文本' }));
    fireEvent.click(screen.getByRole('button', { name: '添加模型' }));

    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith({
        profileId: profile.id,
        remoteModelId: 'relay-model',
        displayName: undefined,
        capabilities: capabilities({ text: true }),
        enabled: false,
      }),
    );
  });

  it('validates and saves per-million-token model pricing', async () => {
    const onUpdatePricing = vi.fn().mockResolvedValue(undefined);
    const model = {
      id: '123e4567-e89b-42d3-a456-426614174001',
      providerProfileId: profile.id,
      remoteModelId: 'gpt-test',
      displayName: 'GPT Test',
      capabilities: capabilities({ text: true, streaming: true }),
      source: 'manual' as const,
      enabled: true,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
    render(
      <ModelManagementView
        profile={profile}
        models={[model]}
        pricing={[]}
        defaults={[]}
        busy={false}
        onSynchronize={vi.fn()}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        onUpdatePricing={onUpdatePricing}
        onUpdateDefault={vi.fn()}
      />,
    );

    const save = screen.getByRole('button', { name: '保存单价' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('gpt-test 币种'), { target: { value: 'cny' } });
    fireEvent.change(screen.getByLabelText('gpt-test 输入单价'), { target: { value: '10' } });
    fireEvent.change(screen.getByLabelText('gpt-test 缓存输入单价'), {
      target: { value: '2.5' },
    });
    fireEvent.change(screen.getByLabelText('gpt-test 输出单价'), { target: { value: '30' } });
    fireEvent.click(save);

    await waitFor(() =>
      expect(onUpdatePricing).toHaveBeenCalledWith({
        providerProfileId: profile.id,
        modelId: model.id,
        currency: 'CNY',
        inputPrice: '10',
        cachedInputPrice: '2.5',
        outputPrice: '30',
        creditPrice: undefined,
      }),
    );
  });

  it('lets Vidu users configure a price per returned credit', async () => {
    const onUpdatePricing = vi.fn().mockResolvedValue(undefined);
    const viduProfile: ProviderProfileInfo = {
      ...profile,
      name: 'Vidu 中国站',
      category: 'multi',
      providerType: 'vidu',
      protocol: 'vidu-v2',
      baseUrl: 'https://api.vidu.cn',
    };
    const model = {
      id: '123e4567-e89b-42d3-a456-426614174002',
      providerProfileId: viduProfile.id,
      remoteModelId: 'viduq3-pro',
      displayName: 'Vidu Q3 Pro',
      capabilities: capabilities({ videoGeneration: true }),
      source: 'built-in' as const,
      enabled: true,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
    render(
      <ModelManagementView
        profile={viduProfile}
        models={[model]}
        pricing={[]}
        defaults={[]}
        busy={false}
        onSynchronize={vi.fn()}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        onUpdatePricing={onUpdatePricing}
        onUpdateDefault={vi.fn()}
      />,
    );

    expect(screen.getByText('每积分单价')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: '保存单价' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('viduq3-pro 币种'), { target: { value: 'cny' } });
    fireEvent.change(screen.getByLabelText('viduq3-pro 每积分单价'), {
      target: { value: '0.03125' },
    });
    fireEvent.click(save);

    await waitFor(() =>
      expect(onUpdatePricing).toHaveBeenCalledWith({
        providerProfileId: viduProfile.id,
        modelId: model.id,
        currency: 'CNY',
        inputPrice: undefined,
        cachedInputPrice: undefined,
        outputPrice: undefined,
        creditPrice: '0.03125',
      }),
    );
  });

  it('assigns and clears an enabled model default role', () => {
    const onUpdateDefault = vi.fn().mockResolvedValue(undefined);
    const model = {
      id: '123e4567-e89b-42d3-a456-426614174001',
      providerProfileId: profile.id,
      remoteModelId: 'gpt-role-test',
      displayName: 'GPT Role Test',
      capabilities: capabilities({ text: true, streaming: true }),
      source: 'manual' as const,
      enabled: true,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
    const { rerender } = render(
      <ModelManagementView
        profile={profile}
        models={[model]}
        pricing={[]}
        defaults={[]}
        busy={false}
        onSynchronize={vi.fn()}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        onUpdatePricing={vi.fn()}
        onUpdateDefault={onUpdateDefault}
      />,
    );

    fireEvent.click(screen.getByRole('checkbox', { name: '日常平衡' }));
    expect(onUpdateDefault).toHaveBeenCalledWith({
      role: 'balanced',
      providerProfileId: profile.id,
      modelId: model.id,
    });

    rerender(
      <ModelManagementView
        profile={profile}
        models={[model]}
        pricing={[]}
        defaults={[
          {
            role: 'balanced',
            providerProfileId: profile.id,
            modelId: model.id,
            updatedAt: profile.updatedAt,
          },
        ]}
        busy={false}
        onSynchronize={vi.fn()}
        onCreate={vi.fn()}
        onUpdate={vi.fn()}
        onUpdatePricing={vi.fn()}
        onUpdateDefault={onUpdateDefault}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox', { name: '日常平衡' }));
    expect(onUpdateDefault).toHaveBeenLastCalledWith({
      role: 'balanced',
      providerProfileId: undefined,
      modelId: undefined,
    });
  });
});
