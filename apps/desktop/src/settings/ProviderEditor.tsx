import { useEffect, useState } from 'react';
import { KeyRound, Server, Sparkles, X } from 'lucide-react';
import { wanVideoWorkspaceId } from '@ai-video/contracts';
import type {
  ProviderDefinitionInfo,
  ProviderProfileCreateParams,
  ProviderProfileInfo,
} from '@ai-video/contracts';

interface ProviderEditorProps {
  profile?: ProviderProfileInfo;
  definitions: ProviderDefinitionInfo[];
  credentialConfigured: boolean;
  onCancel: () => void;
  onSubmit: (
    params: ProviderProfileCreateParams,
    secret: string,
  ) => Promise<{ secretStored: boolean; completed: boolean }>;
}

export function ProviderEditor({
  profile,
  definitions,
  credentialConfigured,
  onCancel,
  onSubmit,
}: ProviderEditorProps) {
  const initialDefinition =
    definitions.find(
      (definition) =>
        definition.providerType === profile?.providerType &&
        definition.protocol === profile.protocol &&
        (definition.baseUrl === profile.baseUrl ||
          (definition.providerType === 'wan-video' &&
            Boolean(wanVideoWorkspaceId(profile.baseUrl)))),
    ) ?? definitions[0];
  const [accessType, setAccessType] = useState<'official' | 'custom'>(
    profile?.accessType ?? 'official',
  );
  const [definitionId, setDefinitionId] = useState(initialDefinition?.id ?? '');
  const [name, setName] = useState(profile?.name ?? initialDefinition?.name ?? '');
  const [protocol, setProtocol] = useState(
    profile?.accessType === 'custom' ? profile.protocol : 'openai-responses',
  );
  const [baseUrl, setBaseUrl] = useState(profile?.accessType === 'custom' ? profile.baseUrl : '');
  const [secret, setSecret] = useState('');
  const [workspaceId, setWorkspaceId] = useState(wanVideoWorkspaceId(profile?.baseUrl ?? '') ?? '');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    const definition =
      definitions.find(
        (candidate) =>
          candidate.providerType === profile?.providerType &&
          candidate.protocol === profile?.protocol &&
          (candidate.baseUrl === profile?.baseUrl ||
            (candidate.providerType === 'wan-video' &&
              Boolean(wanVideoWorkspaceId(profile?.baseUrl ?? '')))),
      ) ?? definitions[0];
    setAccessType(profile?.accessType ?? 'official');
    setDefinitionId(definition?.id ?? '');
    setName(profile?.name ?? definition?.name ?? '');
    setProtocol(profile?.accessType === 'custom' ? profile.protocol : 'openai-responses');
    setBaseUrl(profile?.accessType === 'custom' ? profile.baseUrl : '');
    setSecret('');
    setWorkspaceId(wanVideoWorkspaceId(profile?.baseUrl ?? '') ?? '');
  }, [profile?.id, definitions]);

  const selectedDefinition =
    definitions.find((definition) => definition.id === definitionId) ?? definitions[0];
  const wanOfficial = accessType === 'official' && selectedDefinition?.providerType === 'wan-video';
  const officialBaseUrl = wanOfficial
    ? `https://${workspaceId.trim()}.cn-beijing.maas.aliyuncs.com`
    : (selectedDefinition?.baseUrl ?? '');
  const canSubmit =
    name.trim() &&
    (accessType === 'official'
      ? Boolean(selectedDefinition)
      : Boolean(protocol && baseUrl.trim())) &&
    (credentialConfigured || Boolean(secret.trim())) &&
    (!wanOfficial || Boolean(wanVideoWorkspaceId(officialBaseUrl)));

  const submit = async () => {
    if (!canSubmit || submitting) return;
    const params: ProviderProfileCreateParams =
      accessType === 'official' && selectedDefinition
        ? {
            name: name.trim(),
            category: selectedDefinition.category,
            providerType: selectedDefinition.providerType,
            accessType: 'official',
            protocol: selectedDefinition.protocol,
            baseUrl: officialBaseUrl,
          }
        : {
            name: name.trim(),
            category: 'llm',
            providerType: profile?.accessType === 'custom' ? profile.providerType : 'custom',
            accessType: 'custom',
            protocol,
            baseUrl: baseUrl.trim(),
          };
    setSubmitting(true);
    try {
      const result = await onSubmit(params, secret.trim());
      if (result.secretStored) setSecret('');
      if (result.completed) onCancel();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="provider-editor" aria-label={profile ? '编辑供应商连接' : '添加供应商连接'}>
      <header>
        <div>
          <span className="eyebrow">{profile ? '连接设置' : '新建连接'}</span>
          <h3>{profile ? profile.name : '添加供应商'}</h3>
        </div>
        <button className="icon-button subtle" type="button" title="关闭编辑器" onClick={onCancel}>
          <X size={16} />
        </button>
      </header>

      <div className="provider-access-tabs" role="tablist" aria-label="供应商类型">
        <button
          type="button"
          className={accessType === 'official' ? 'active' : ''}
          onClick={() => setAccessType('official')}
        >
          <Sparkles size={14} />
          官方 API
        </button>
        <button
          type="button"
          className={accessType === 'custom' ? 'active' : ''}
          onClick={() => setAccessType('custom')}
        >
          <Server size={14} />
          自定义供应商
        </button>
      </div>

      {accessType === 'official' ? (
        <div className="official-provider-grid">
          {definitions.map((definition) => (
            <button
              key={definition.id}
              type="button"
              className={definition.id === selectedDefinition?.id ? 'selected' : ''}
              onClick={() => {
                setDefinitionId(definition.id);
                if (!profile) setName(definition.name);
              }}
            >
              <span className="provider-logo">{definition.name.slice(0, 2)}</span>
              <strong>{definition.name}</strong>
              <small>{definition.protocol}</small>
            </button>
          ))}
        </div>
      ) : (
        <label>
          兼容协议
          <select value={protocol} onChange={(event) => setProtocol(event.target.value)}>
            <option value="openai-responses">OpenAI Responses</option>
            <option value="openai-chat-completions">OpenAI-compatible Chat Completions</option>
          </select>
        </label>
      )}

      <label>
        连接名称
        <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
      </label>

      {wanOfficial && (
        <label>
          百炼业务空间 ID（北京地域）
          <input
            aria-label="百炼业务空间 ID（北京地域）"
            value={workspaceId}
            maxLength={63}
            onChange={(event) => setWorkspaceId(event.target.value)}
          />
          <small>填写百炼控制台中的业务空间 ID，API Key 和模型权限须属于同一地域及业务空间。</small>
        </label>
      )}

      <label>
        Base URL
        <input
          value={accessType === 'official' ? officialBaseUrl : baseUrl}
          readOnly={accessType === 'official'}
          placeholder="https://relay.example/v1"
          onChange={(event) => setBaseUrl(event.target.value)}
        />
      </label>

      <label>
        API Key
        <span className="secret-input-row">
          <KeyRound size={14} />
          <input
            type="password"
            aria-label="API Key"
            value={secret}
            autoComplete="new-password"
            placeholder={credentialConfigured ? '已配置；留空则不修改' : '填写供应商密钥'}
            onChange={(event) => setSecret(event.target.value)}
          />
        </span>
        <small>
          {credentialConfigured
            ? '密钥已保存在 Windows 安全凭据中，界面不会回显。'
            : '保存后密钥会立即移出表单，仅写入 Windows 安全凭据。'}
        </small>
      </label>

      <footer>
        <button className="button secondary" type="button" onClick={onCancel}>
          取消
        </button>
        <button
          className="button primary"
          type="button"
          disabled={!canSubmit || submitting}
          onClick={() => void submit()}
        >
          {submitting ? '保存并测试中…' : '保存并测试'}
        </button>
      </footer>
    </section>
  );
}
