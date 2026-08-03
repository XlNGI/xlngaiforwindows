import { useEffect, useState } from 'react';
import { CircleDollarSign, Plus, RefreshCw, TriangleAlert } from 'lucide-react';
import type {
  ModelPricingInfo,
  ModelPricingUpdateParams,
  ProviderDefaultInfo,
  ProviderDefaultRole,
  ProviderDefaultUpdateParams,
  ProviderModelCapabilities,
  ProviderModelCreateParams,
  ProviderModelInfo,
  ProviderModelUpdateParams,
  ProviderProfileInfo,
} from '@ai-video/contracts';

const capabilityOptions: Array<{ key: keyof ProviderModelCapabilities; label: string }> = [
  { key: 'text', label: '文本' },
  { key: 'vision', label: '视觉' },
  { key: 'streaming', label: '流式' },
  { key: 'reasoning', label: '推理' },
  { key: 'tools', label: '工具' },
  { key: 'structuredOutput', label: '结构化输出' },
  { key: 'embeddings', label: '向量' },
  { key: 'imageGeneration', label: '图片生成' },
  { key: 'videoGeneration', label: '视频生成' },
];

const defaultRoleOptions: Array<{ role: ProviderDefaultRole; label: string }> = [
  { role: 'quality', label: '高质量创作' },
  { role: 'balanced', label: '日常平衡' },
  { role: 'fast', label: '快速处理' },
  { role: 'vision', label: '视觉模型' },
  { role: 'embedding', label: '向量模型' },
];

function emptyCapabilities(): ProviderModelCapabilities {
  return {
    text: false,
    vision: false,
    streaming: false,
    reasoning: false,
    tools: false,
    structuredOutput: false,
    embeddings: false,
    imageGeneration: false,
    videoGeneration: false,
  };
}

interface ModelManagementViewProps {
  profile?: ProviderProfileInfo;
  models: ProviderModelInfo[];
  pricing: ModelPricingInfo[];
  defaults: ProviderDefaultInfo[];
  busy: boolean;
  onSynchronize: () => Promise<void>;
  onCreate: (params: ProviderModelCreateParams) => Promise<void>;
  onUpdate: (params: ProviderModelUpdateParams) => Promise<void>;
  onUpdatePricing: (params: ModelPricingUpdateParams) => Promise<void>;
  onUpdateDefault: (params: ProviderDefaultUpdateParams) => Promise<void>;
}

export function ModelManagementView({
  profile,
  models,
  pricing,
  defaults,
  busy,
  onSynchronize,
  onCreate,
  onUpdate,
  onUpdatePricing,
  onUpdateDefault,
}: ModelManagementViewProps) {
  const [manualOpen, setManualOpen] = useState(false);
  const [remoteModelId, setRemoteModelId] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [manualCapabilities, setManualCapabilities] = useState(emptyCapabilities);

  if (!profile) {
    return (
      <section className="model-management empty-settings-state">
        <strong>选择一个供应商连接</strong>
        <span>模型目录、能力和启用状态会显示在这里。</span>
      </section>
    );
  }

  const update = (model: ProviderModelInfo, change: Partial<ProviderModelUpdateParams>) =>
    onUpdate({
      profileId: profile.id,
      modelId: model.id,
      displayName: model.displayName,
      capabilities: model.capabilities,
      enabled: model.enabled,
      ...change,
    });

  const createManual = async () => {
    if (!remoteModelId.trim()) return;
    await onCreate({
      profileId: profile.id,
      remoteModelId: remoteModelId.trim(),
      displayName: displayName.trim() || undefined,
      capabilities: manualCapabilities,
      enabled: false,
    });
    setRemoteModelId('');
    setDisplayName('');
    setManualCapabilities(emptyCapabilities());
    setManualOpen(false);
  };

  return (
    <section className="model-management">
      <header className="settings-section-header">
        <div>
          <span className="eyebrow">模型目录</span>
          <h3>{profile.name}</h3>
          <small>{models.length} 个模型 · 未知模型需先选择能力再启用</small>
        </div>
        <div className="settings-header-actions">
          <button
            className="button secondary"
            type="button"
            disabled={busy}
            onClick={() => void onSynchronize()}
          >
            <RefreshCw size={14} />
            测试并同步
          </button>
          <button className="button secondary" type="button" onClick={() => setManualOpen(true)}>
            <Plus size={14} />
            手动添加
          </button>
        </div>
      </header>

      {manualOpen && (
        <div className="manual-model-form">
          <label>
            模型 ID
            <input
              value={remoteModelId}
              placeholder="deployment-or-model-id"
              onChange={(event) => setRemoteModelId(event.target.value)}
            />
          </label>
          <label>
            显示名称
            <input value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          </label>
          <CapabilityEditor capabilities={manualCapabilities} onChange={setManualCapabilities} />
          <div className="manual-model-actions">
            <button className="button secondary" type="button" onClick={() => setManualOpen(false)}>
              取消
            </button>
            <button
              className="button primary"
              type="button"
              disabled={busy || !remoteModelId.trim()}
              onClick={() => void createManual()}
            >
              添加模型
            </button>
          </div>
        </div>
      )}

      <div className="model-list">
        {models.length === 0 ? (
          <div className="empty-settings-state compact">
            <strong>还没有模型</strong>
            <span>运行模型同步，或手动添加中转站提供的模型 ID。</span>
          </div>
        ) : (
          models.map((model) => (
            <article
              className="model-card"
              data-unavailable={Boolean(model.unavailableAt)}
              key={model.id}
            >
              <header>
                <div>
                  <input
                    className="model-name-input"
                    defaultValue={model.displayName}
                    aria-label={`${model.remoteModelId} 显示名称`}
                    onBlur={(event) => {
                      const next = event.target.value.trim();
                      if (next && next !== model.displayName)
                        void update(model, { displayName: next });
                    }}
                  />
                  <small>{model.remoteModelId}</small>
                </div>
                <label className="model-enabled-toggle">
                  <input
                    type="checkbox"
                    checked={model.enabled}
                    disabled={busy || Boolean(model.unavailableAt)}
                    onChange={(event) => void update(model, { enabled: event.target.checked })}
                  />
                  启用
                </label>
              </header>
              {model.unavailableAt && (
                <div className="model-warning">
                  <TriangleAlert size={13} />
                  最近一次同步未发现此模型，重新出现前不能启用。
                </div>
              )}
              <CapabilityEditor
                capabilities={model.capabilities}
                disabled={busy}
                onChange={(capabilities) => void update(model, { capabilities })}
              />
              <ModelRoleEditor
                profileId={profile.id}
                model={model}
                defaults={defaults}
                disabled={busy}
                onSave={onUpdateDefault}
              />
              <ModelPricingEditor
                profileId={profile.id}
                model={model}
                pricing={pricing.find((item) => item.modelId === model.id)}
                disabled={busy}
                onSave={onUpdatePricing}
              />
              <footer>
                <span>
                  {model.source === 'manual'
                    ? '手动模型'
                    : model.source === 'built-in'
                      ? '内置模型'
                      : '远程同步'}
                </span>
                <span>{model.lastSeenAt ? `最近发现 ${model.lastSeenAt}` : '尚未同步'}</span>
              </footer>
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function ModelRoleEditor({
  profileId,
  model,
  defaults,
  disabled,
  onSave,
}: {
  profileId: string;
  model: ProviderModelInfo;
  defaults: ProviderDefaultInfo[];
  disabled: boolean;
  onSave: (params: ProviderDefaultUpdateParams) => Promise<void>;
}) {
  return (
    <fieldset className="capability-editor model-role-editor">
      <legend>默认角色</legend>
      {defaultRoleOptions.map(({ role, label }) => {
        const assigned = defaults.find((item) => item.role === role);
        const checked = assigned?.modelId === model.id;
        const supported = supportsDefaultRole(role, model.capabilities);
        return (
          <label key={role} title={assigned && !checked ? '选择后会替换当前默认模型' : undefined}>
            <input
              type="checkbox"
              checked={checked}
              disabled={
                disabled ||
                !model.enabled ||
                Boolean(model.unavailableAt) ||
                (!checked && !supported)
              }
              onChange={(event) =>
                void onSave({
                  role,
                  providerProfileId: event.target.checked ? profileId : undefined,
                  modelId: event.target.checked ? model.id : undefined,
                })
              }
            />
            {label}
          </label>
        );
      })}
    </fieldset>
  );
}

function supportsDefaultRole(
  role: ProviderDefaultRole,
  capabilities: ProviderModelCapabilities,
): boolean {
  if (role === 'vision') return capabilities.vision;
  if (role === 'embedding') return capabilities.embeddings;
  return capabilities.text && capabilities.streaming;
}

function ModelPricingEditor({
  profileId,
  model,
  pricing,
  disabled,
  onSave,
}: {
  profileId: string;
  model: ProviderModelInfo;
  pricing?: ModelPricingInfo;
  disabled: boolean;
  onSave: (params: ModelPricingUpdateParams) => Promise<void>;
}) {
  const [currency, setCurrency] = useState(pricing?.currency ?? 'USD');
  const [inputPrice, setInputPrice] = useState(pricing?.inputPrice ?? '');
  const [cachedInputPrice, setCachedInputPrice] = useState(pricing?.cachedInputPrice ?? '');
  const [outputPrice, setOutputPrice] = useState(pricing?.outputPrice ?? '');

  useEffect(() => {
    setCurrency(pricing?.currency ?? 'USD');
    setInputPrice(pricing?.inputPrice ?? '');
    setCachedInputPrice(pricing?.cachedInputPrice ?? '');
    setOutputPrice(pricing?.outputPrice ?? '');
  }, [pricing]);

  const decimalPattern = /^(?:0|[1-9]\d{0,11})(?:\.\d{1,12})?$/;
  const valid =
    /^[A-Za-z]{3,8}$/.test(currency.trim()) &&
    decimalPattern.test(inputPrice.trim()) &&
    (!cachedInputPrice.trim() || decimalPattern.test(cachedInputPrice.trim())) &&
    decimalPattern.test(outputPrice.trim());

  return (
    <div className="model-pricing-editor">
      <div className="model-pricing-heading">
        <span>
          <CircleDollarSign size={13} />
          单价 / 100 万 Token
        </span>
        <small>{pricing ? `更新于 ${pricing.updatedAt}` : '尚未配置，费用将显示为未知'}</small>
      </div>
      <div className="model-pricing-fields">
        <label>
          币种
          <input
            aria-label={`${model.remoteModelId} 币种`}
            value={currency}
            maxLength={8}
            onChange={(event) => setCurrency(event.target.value.toUpperCase())}
          />
        </label>
        <label>
          输入
          <input
            aria-label={`${model.remoteModelId} 输入单价`}
            inputMode="decimal"
            value={inputPrice}
            onChange={(event) => setInputPrice(event.target.value)}
          />
        </label>
        <label>
          缓存输入
          <input
            aria-label={`${model.remoteModelId} 缓存输入单价`}
            inputMode="decimal"
            placeholder="默认同输入"
            value={cachedInputPrice}
            onChange={(event) => setCachedInputPrice(event.target.value)}
          />
        </label>
        <label>
          输出
          <input
            aria-label={`${model.remoteModelId} 输出单价`}
            inputMode="decimal"
            value={outputPrice}
            onChange={(event) => setOutputPrice(event.target.value)}
          />
        </label>
        <button
          className="button secondary"
          type="button"
          disabled={disabled || !valid}
          onClick={() =>
            void onSave({
              providerProfileId: profileId,
              modelId: model.id,
              currency: currency.trim(),
              inputPrice: inputPrice.trim(),
              cachedInputPrice: cachedInputPrice.trim() || undefined,
              outputPrice: outputPrice.trim(),
            })
          }
        >
          保存单价
        </button>
      </div>
    </div>
  );
}

function CapabilityEditor({
  capabilities,
  disabled = false,
  onChange,
}: {
  capabilities: ProviderModelCapabilities;
  disabled?: boolean;
  onChange: (capabilities: ProviderModelCapabilities) => void;
}) {
  return (
    <fieldset className="capability-editor">
      <legend>能力</legend>
      {capabilityOptions.map((option) => (
        <label key={option.key}>
          <input
            type="checkbox"
            checked={capabilities[option.key]}
            disabled={disabled}
            onChange={(event) => onChange({ ...capabilities, [option.key]: event.target.checked })}
          />
          {option.label}
        </label>
      ))}
    </fieldset>
  );
}
