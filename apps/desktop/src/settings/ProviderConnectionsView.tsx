import { useEffect, useMemo, useState } from 'react';
import { KeyRound, Pencil, Plus, Server, Trash2 } from 'lucide-react';
import type {
  ModelPricingInfo,
  ModelPricingUpdateParams,
  ProviderDefaultInfo,
  ProviderDefaultUpdateParams,
  ProviderDefinitionInfo,
  ProviderModelCreateParams,
  ProviderModelInfo,
  ProviderModelUpdateParams,
  ProviderProfileCreateParams,
  ProviderProfileInfo,
} from '@ai-video/contracts';
import {
  canUseSecureCredentials,
  deleteCredential,
  getCredentialStatus,
  getLegacyProviderMigrationReport,
  setCredential,
  type LegacyProviderMigrationEntry,
} from '../credential-client';
import { providerProfileClient } from '../provider-profile-client';
import { ModelManagementView } from './ModelManagementView';
import { ProviderEditor } from './ProviderEditor';

type EditorState = { kind: 'new' } | { kind: 'edit'; profileId: string } | undefined;

const statusLabels: Record<ProviderProfileInfo['connectionStatus'], string> = {
  draft: '待测试',
  testing: '测试中',
  ready: '可用',
  'auth-failed': '认证失败',
  'network-failed': '网络失败',
  'protocol-failed': '协议失败',
  'sync-failed': '模型同步失败',
  disabled: '已停用',
};

export function ProviderConnectionsView() {
  const [definitions, setDefinitions] = useState<ProviderDefinitionInfo[]>([]);
  const [profiles, setProfiles] = useState<ProviderProfileInfo[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState<string>();
  const [models, setModels] = useState<ProviderModelInfo[]>([]);
  const [pricing, setPricing] = useState<ModelPricingInfo[]>([]);
  const [defaults, setDefaults] = useState<ProviderDefaultInfo[]>([]);
  const [credentialStatus, setCredentialStatus] = useState<Record<string, boolean>>({});
  const [legacyMigrations, setLegacyMigrations] = useState<LegacyProviderMigrationEntry[]>([]);
  const [editor, setEditor] = useState<EditorState>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const selectedProfile = profiles.find((profile) => profile.id === selectedProfileId);
  const editedProfile =
    editor?.kind === 'edit'
      ? profiles.find((profile) => profile.id === editor.profileId)
      : undefined;

  const loadProfiles = async (preferredProfileId?: string) => {
    const [definitionResult, profileResult, defaultResult] = await Promise.all([
      providerProfileClient.listDefinitions(),
      providerProfileClient.listProfiles(),
      providerProfileClient.listProviderDefaults(),
    ]);
    const nextDefinitions = definitionResult ?? [];
    const nextProfiles = profileResult ?? [];
    setDefinitions(nextDefinitions);
    setProfiles(nextProfiles);
    setDefaults(defaultResult ?? []);
    const nextSelected =
      preferredProfileId && nextProfiles.some((profile) => profile.id === preferredProfileId)
        ? preferredProfileId
        : selectedProfileId && nextProfiles.some((profile) => profile.id === selectedProfileId)
          ? selectedProfileId
          : nextProfiles[0]?.id;
    setSelectedProfileId(nextSelected);
    if (canUseSecureCredentials()) {
      const [statuses, migrationReport] = await Promise.all([
        Promise.all(
          nextProfiles.map(async (profile) => {
            try {
              const status = await getCredentialStatus(profile.id);
              return [profile.id, status.configured] as const;
            } catch {
              return [profile.id, false] as const;
            }
          }),
        ),
        getLegacyProviderMigrationReport().catch(() => ({ entries: [] })),
      ]);
      setCredentialStatus(Object.fromEntries(statuses));
      setLegacyMigrations(migrationReport.entries.filter((entry) => entry.status !== 'not-found'));
    }
  };

  useEffect(() => {
    let active = true;
    void loadProfiles().catch((reason) => {
      if (active) setMessage(reason instanceof Error ? reason.message : '供应商列表加载失败。');
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    if (!selectedProfileId) {
      setModels([]);
      setPricing([]);
      return;
    }
    void Promise.all([
      providerProfileClient.listModels(selectedProfileId),
      providerProfileClient.listModelPricing(selectedProfileId),
    ])
      .then(([modelItems, pricingItems]) => {
        if (active) {
          setModels(modelItems);
          setPricing(pricingItems);
        }
      })
      .catch((reason) => {
        if (active) setMessage(reason instanceof Error ? reason.message : '模型列表加载失败。');
      });
    return () => {
      active = false;
    };
  }, [selectedProfileId]);

  const duplicateNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const profile of profiles) counts.set(profile.name, (counts.get(profile.name) ?? 0) + 1);
    return counts;
  }, [profiles]);

  const saveProfile = async (params: ProviderProfileCreateParams, secret: string) => {
    setBusy(true);
    setMessage('');
    let secretStored = false;
    try {
      const profile = editedProfile
        ? await providerProfileClient.updateProfile({
            ...params,
            profileId: editedProfile.id,
            enabled: editedProfile.enabled,
          })
        : await providerProfileClient.createProfile(params);
      const wasConfigured = credentialStatus[profile.id] === true;
      if (secret) {
        await setCredential(profile.id, secret);
        secretStored = true;
        setCredentialStatus((current) => ({ ...current, [profile.id]: true }));
      } else if (!wasConfigured) {
        setMessage('连接已保存，但还需要填写 API Key 才能测试。');
        await loadProfiles(profile.id);
        return { secretStored, completed: false };
      }

      const tested = await providerProfileClient.testConnection(profile.id);
      setModels(tested.models);
      setPricing(await providerProfileClient.listModelPricing(profile.id));
      await loadProfiles(profile.id);
      if (tested.profile.connectionStatus === 'ready') {
        setMessage(
          tested.modelSyncStatus === 'unsupported'
            ? tested.profile.protocol === 'vidu-v2'
              ? `连接测试成功，已载入 ${tested.models.length} 个内置媒体模型。`
              : '连接测试成功；供应商不支持模型列表，请手动添加模型 ID。'
            : `连接测试成功，已同步 ${tested.models.length} 个模型。`,
        );
        return { secretStored, completed: true };
      }
      setMessage(tested.profile.lastErrorMessage ?? statusLabels[tested.profile.connectionStatus]);
      return { secretStored, completed: false };
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '供应商连接保存失败。');
      return { secretStored, completed: false };
    } finally {
      setBusy(false);
    }
  };

  const synchronize = async () => {
    if (!selectedProfile) return;
    setBusy(true);
    setMessage('');
    try {
      const result = await providerProfileClient.testConnection(selectedProfile.id);
      setModels(result.models);
      setPricing(await providerProfileClient.listModelPricing(selectedProfile.id));
      await loadProfiles(selectedProfile.id);
      setMessage(
        result.profile.connectionStatus === 'ready'
          ? result.modelSyncStatus === 'unsupported'
            ? result.profile.protocol === 'vidu-v2'
              ? `连接可用，保留 ${result.models.length} 个内置媒体模型。`
              : '连接可用，但该供应商不提供模型列表。'
            : `模型同步完成：${result.models.length} 个。`
          : (result.profile.lastErrorMessage ?? statusLabels[result.profile.connectionStatus]),
      );
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '模型同步失败。');
    } finally {
      setBusy(false);
    }
  };

  const createModel = async (params: ProviderModelCreateParams) => {
    setBusy(true);
    setMessage('');
    try {
      const model = await providerProfileClient.createManualModel(params);
      setModels((current) => [...current, model]);
      setMessage('手动模型已添加，请确认能力后启用。');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '手动模型添加失败。');
    } finally {
      setBusy(false);
    }
  };

  const updateModel = async (params: ProviderModelUpdateParams) => {
    setBusy(true);
    setMessage('');
    try {
      const updated = await providerProfileClient.updateModel(params);
      setModels((current) => current.map((model) => (model.id === updated.id ? updated : model)));
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '模型设置保存失败。');
    } finally {
      setBusy(false);
    }
  };

  const updatePricing = async (params: ModelPricingUpdateParams) => {
    setBusy(true);
    setMessage('');
    try {
      const updated = await providerProfileClient.updateModelPricing(params);
      setPricing((current) => [
        ...current.filter((item) => item.modelId !== updated.modelId),
        updated,
      ]);
      setMessage('模型单价已保存；后续调用会使用新的价格快照。');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '模型单价保存失败。');
    } finally {
      setBusy(false);
    }
  };

  const updateDefault = async (params: ProviderDefaultUpdateParams) => {
    setBusy(true);
    setMessage('');
    try {
      const updated = await providerProfileClient.updateProviderDefault(params);
      setDefaults((current) => [
        ...current.filter((item) => item.role !== params.role),
        ...(updated ? [updated] : []),
      ]);
      setMessage(updated ? '默认模型角色已保存。' : '默认模型角色已清除。');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '默认模型角色保存失败。');
    } finally {
      setBusy(false);
    }
  };

  const archiveSelected = async () => {
    if (!selectedProfile) return;
    if (!window.confirm(`删除连接“${selectedProfile.name}”？对应安全密钥也会被删除。`)) return;
    setBusy(true);
    setMessage('');
    try {
      await deleteCredential(selectedProfile.id);
      await providerProfileClient.archiveProfile(selectedProfile.id);
      setEditor(undefined);
      await loadProfiles();
      setMessage('供应商连接和安全密钥已删除。');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '供应商连接删除失败。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="provider-connections-view">
      <aside className="provider-list-pane">
        <header className="settings-section-header">
          <div>
            <span className="eyebrow">应用级配置</span>
            <h3>供应商连接</h3>
          </div>
          <button
            className="icon-button"
            type="button"
            title="添加供应商"
            onClick={() => setEditor({ kind: 'new' })}
          >
            <Plus size={17} />
          </button>
        </header>
        <div className="provider-list">
          {profiles.length === 0 ? (
            <button
              className="empty-provider-cta"
              type="button"
              onClick={() => setEditor({ kind: 'new' })}
            >
              <Server size={22} />
              <strong>添加第一个供应商</strong>
              <span>支持官方 OpenAI、Vidu 中国站/国际站，以及 OpenAI 兼容中转站。</span>
            </button>
          ) : (
            profiles.map((profile) => (
              <button
                key={profile.id}
                type="button"
                className={
                  profile.id === selectedProfileId
                    ? 'provider-list-item selected'
                    : 'provider-list-item'
                }
                onClick={() => setSelectedProfileId(profile.id)}
              >
                <span className="provider-logo">{profile.name.slice(0, 2)}</span>
                <span>
                  <strong>{profile.name}</strong>
                  <small>
                    {duplicateNames.get(profile.name)! > 1 ? `${profile.id.slice(-6)} · ` : ''}
                    {profile.migrationSource ? '旧版迁移 · ' : ''}
                    {profile.protocol}
                  </small>
                </span>
                <span className={`connection-status status-${profile.connectionStatus}`}>
                  {statusLabels[profile.connectionStatus]}
                </span>
              </button>
            ))
          )}
        </div>
        {selectedProfile && (
          <div className="provider-list-actions">
            <span>
              <KeyRound size={13} />
              {credentialStatus[selectedProfile.id] ? '密钥已配置' : '密钥未配置'}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => setEditor({ kind: 'edit', profileId: selectedProfile.id })}
            >
              <Pencil size={13} />
              编辑
            </button>
            <button
              className="danger-command"
              type="button"
              disabled={busy}
              onClick={() => void archiveSelected()}
            >
              <Trash2 size={13} />
              删除
            </button>
          </div>
        )}
      </aside>

      <main className="provider-detail-pane">
        {legacyMigrations.length > 0 && (
          <div className="legacy-migration-list">
            {legacyMigrations.map((entry) => (
              <div key={entry.source} data-status={entry.status}>
                <strong>{entry.source === 'vidu-cn' ? 'Vidu 中国站' : 'Vidu 国际站'}</strong>
                <span>{legacyMigrationMessage(entry)}</span>
              </div>
            ))}
          </div>
        )}
        {editor ? (
          <ProviderEditor
            profile={editedProfile}
            definitions={definitions}
            credentialConfigured={
              editedProfile ? credentialStatus[editedProfile.id] === true : false
            }
            onCancel={() => setEditor(undefined)}
            onSubmit={saveProfile}
          />
        ) : (
          <ModelManagementView
            profile={selectedProfile}
            models={models}
            pricing={pricing}
            defaults={defaults}
            busy={busy}
            onSynchronize={synchronize}
            onCreate={createModel}
            onUpdate={updateModel}
            onUpdatePricing={updatePricing}
            onUpdateDefault={updateDefault}
          />
        )}
        {message && (
          <div className="settings-message" role="status">
            {message}
          </div>
        )}
      </main>
    </div>
  );
}

function legacyMigrationMessage(entry: LegacyProviderMigrationEntry): string {
  if (entry.status === 'migrated') return '旧版密钥已复制到独立连接；旧凭据仍保留用于回退。';
  if (entry.status === 'existing') return '已存在迁移连接；旧凭据仍保留用于回退。';
  if (entry.status === 'archived') return '之前的迁移连接已删除，请新建连接并重新输入密钥。';
  return '自动迁移未完成，旧凭据仍保留；请编辑迁移连接并重新输入密钥。';
}
