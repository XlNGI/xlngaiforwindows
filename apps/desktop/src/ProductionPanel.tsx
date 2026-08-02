import { useEffect, useMemo, useState } from 'react';
import {
  CircleAlert,
  CircleCheck,
  KeyRound,
  Plus,
  Save,
  Trash2,
  WandSparkles,
  Square,
} from 'lucide-react';
import type {
  AdapterCatalogResult,
  AdapterDescriptor,
  AdapterParameterProperty,
  AdapterParameters,
  AdapterUiField,
  AdapterValidationError,
  AssetInfo,
  GenerationCapability,
} from '@ai-video/contracts';
import {
  canUseSecureCredentials,
  deleteCredential,
  getCredentialStatus,
  setCredential,
  type CredentialStatus,
} from './credential-client';
import { callWorker } from './worker-client';
import { submitProviderRequest, type ProviderRegion } from './provider-client';

interface ProductionPanelProps {
  projectId?: string;
  shotId?: string;
  writable: boolean;
}

const PROVIDER_REGION_STORAGE_KEY = 'ai-video.vidu-provider-region';

function initialProviderRegion(): ProviderRegion {
  try {
    const stored = window.localStorage.getItem(PROVIDER_REGION_STORAGE_KEY);
    if (stored === 'global' || stored === 'cn') return stored;
  } catch {
    // The native WebView normally exposes localStorage; use the domestic default if it does not.
  }
  return 'cn';
}

function defaultParameters(adapter: AdapterDescriptor): AdapterParameters {
  return Object.fromEntries(
    Object.entries(adapter.parameterSchema.properties)
      .filter(([, property]) => property.default !== undefined)
      .map(([key, property]) => [key, property.default!]),
  );
}

function normalizeErrorPath(path: string): string {
  return path.replace(/^\//, '');
}

function errorMessage(reason: unknown, fallback: string): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  if (typeof reason === 'string' && reason.trim()) return reason.trim();
  if (reason && typeof reason === 'object' && 'message' in reason) {
    const message = (reason as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return fallback;
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

export function ProductionPanel({ projectId, shotId, writable }: ProductionPanelProps) {
  const [catalog, setCatalog] = useState<AdapterCatalogResult>();
  const [capability, setCapability] = useState<GenerationCapability>();
  const [provider, setProvider] = useState('');
  const [providerRegion, setProviderRegion] = useState<ProviderRegion>(initialProviderRegion);
  const [adapterKey, setAdapterKey] = useState('');
  const [adapter, setAdapter] = useState<AdapterDescriptor>();
  const [parameters, setParameters] = useState<AdapterParameters>({});
  const [errors, setErrors] = useState<AdapterValidationError[]>([]);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const [credential, setCredentialState] = useState<CredentialStatus>();
  const [credentialSecret, setCredentialSecret] = useState('');
  const [credentialMessage, setCredentialMessage] = useState('');
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [generationJobId, setGenerationJobId] = useState<string>();
  const [generationStatus, setGenerationStatus] = useState('');
  const [assetKind, setAssetKind] = useState<
    'character' | 'scene' | 'first-frame' | 'last-frame' | 'generated-image'
  >('generated-image');
  const [assets, setAssets] = useState<AssetInfo[]>([]);

  const credentialProvider =
    adapter?.provider === 'vidu' && providerRegion === 'cn'
      ? `${adapter.credentialProvider}-cn`
      : adapter?.credentialProvider;

  useEffect(() => {
    try {
      window.localStorage.setItem(PROVIDER_REGION_STORAGE_KEY, providerRegion);
    } catch {
      // Region remains valid for the current session when storage is unavailable.
    }
  }, [providerRegion]);

  useEffect(() => {
    void callWorker('adapter.catalog', {})
      .then((nextCatalog) => {
        setCatalog(nextCatalog);
        const first = nextCatalog.adapters[0];
        if (first) {
          setCapability(first.capability);
          setProvider(first.provider);
          setAdapterKey(first.key);
        }
      })
      .catch((reason) => setMessage(errorMessage(reason, '适配器目录读取失败')));
  }, []);

  useEffect(() => {
    const selected = catalog?.adapters.find((item) => item.key === adapterKey);
    if (!selected) {
      setAdapter(undefined);
      setParameters({});
      return;
    }
    let active = true;
    void callWorker('adapter.resolve', {
      capability: selected.capability,
      provider: selected.provider,
      model: selected.model,
      apiVersion: selected.apiVersion,
    })
      .then(async (resolved) => {
        if (!active) return;
        setAdapter(resolved);
        setErrors([]);
        setMessage('');
        const defaults = defaultParameters(resolved);
        if (!shotId) {
          setParameters(defaults);
          return;
        }
        const draft = await callWorker('generation.draft.get', {
          shotId,
          adapterKey: resolved.key,
        });
        if (active) setParameters(draft?.parameters ?? defaults);
      })
      .catch((reason) => {
        if (active) {
          setAdapter(undefined);
          setParameters({});
          setMessage(errorMessage(reason, '适配器解析失败'));
        }
      });
    return () => {
      active = false;
    };
  }, [adapterKey, catalog, shotId]);

  useEffect(() => {
    setCredentialState(undefined);
    setCredentialMessage('');
    if (!credentialProvider || !canUseSecureCredentials()) return;
    void getCredentialStatus(credentialProvider)
      .then(setCredentialState)
      .catch((reason) => setCredentialMessage(errorMessage(reason, '凭据状态读取失败')));
  }, [credentialProvider]);

  useEffect(() => {
    let active = true;
    setAssets([]);
    if (!projectId) return () => undefined;
    void callWorker('asset.list', {})
      .then((items) => {
        if (active) setAssets(items);
      })
      .catch((reason) => {
        if (active) setGenerationStatus(errorMessage(reason, '素材列表读取失败。'));
      });
    return () => {
      active = false;
    };
  }, [projectId]);

  const capabilityAdapters = useMemo(
    () => catalog?.adapters.filter((item) => item.capability === capability) ?? [],
    [catalog, capability],
  );
  const providerOptions = useMemo(
    () => uniqueBy(capabilityAdapters, (item) => item.provider),
    [capabilityAdapters],
  );
  const modelOptions = useMemo(
    () => capabilityAdapters.filter((item) => item.provider === provider),
    [capabilityAdapters, provider],
  );

  const chooseCapability = (next: GenerationCapability) => {
    const first = catalog?.adapters.find((item) => item.capability === next);
    setCapability(next);
    setProvider(first?.provider ?? '');
    setAdapterKey(first?.key ?? '');
  };

  const chooseProvider = (next: string) => {
    const first = capabilityAdapters.find((item) => item.provider === next);
    setProvider(next);
    setAdapterKey(first?.key ?? '');
  };

  const chooseProviderRegion = (next: ProviderRegion) => {
    setProviderRegion(next);
    setCredentialState(undefined);
    setCredentialSecret('');
    setCredentialMessage('');
    setGenerationStatus('');
  };

  const updateParameter = (key: string, value: AdapterParameters[string] | undefined) => {
    setParameters((current) => {
      if (value === undefined || value === '') {
        const next = { ...current };
        delete next[key];
        return next;
      }
      return { ...current, [key]: value };
    });
    setErrors((current) => current.filter((error) => normalizeErrorPath(error.path) !== key));
    setMessage('');
    setGenerationStatus('');
  };

  const saveDraft = async () => {
    if (!adapter || !shotId) return;
    setBusy(true);
    setMessage('');
    try {
      const validation = await callWorker('adapter.validate', {
        adapterKey: adapter.key,
        parameters,
      });
      setErrors(validation.errors);
      if (!validation.valid) {
        setMessage(`${validation.errors.length} 项参数需要修正`);
        return;
      }
      const saved = await callWorker('generation.draft.save', {
        shotId,
        adapterKey: adapter.key,
        parameters,
      });
      setMessage(`草稿已保存 · ${new Date(saved.updatedAt).toLocaleTimeString()}`);
    } catch (reason) {
      setMessage(errorMessage(reason, '草稿保存失败'));
    } finally {
      setBusy(false);
    }
  };

  const saveCredential = async () => {
    if (!adapter || !credentialProvider || !credentialSecret) return;
    setCredentialBusy(true);
    setCredentialMessage('');
    try {
      setCredentialState(await setCredential(credentialProvider, credentialSecret));
      setCredentialSecret('');
      setCredentialMessage('凭据已保存到 Windows 凭据管理器');
    } catch (reason) {
      setCredentialMessage(errorMessage(reason, '凭据保存失败'));
    } finally {
      setCredentialBusy(false);
    }
  };

  const generateImage = async () => {
    if (!adapter || !writable) return;
    if (canUseSecureCredentials() && credential?.configured !== true) {
      setGenerationStatus(
        credential
          ? '请先为当前 Vidu 服务区域保存 API Key。'
          : '正在读取当前 Vidu 服务区域的凭据状态，请稍后重试。',
      );
      return;
    }
    let preparedJobId: string | undefined;
    setBusy(true);
    setGenerationStatus('');
    try {
      const validation = await callWorker('adapter.validate', {
        adapterKey: adapter.key,
        parameters,
      });
      setErrors(validation.errors);
      if (!validation.valid) {
        setGenerationStatus('请先修正参数。');
        return;
      }
      const job = await callWorker('image.generate.prepare', {
        shotId,
        adapterKey: adapter.key,
        parameters,
      });
      preparedJobId = job.id;
      setGenerationJobId(job.id);
      setGenerationStatus('正在请求 Provider...');
      const response = await submitProviderRequest(adapter.key, parameters, providerRegion);
      const completed = await callWorker('image.generate.complete', {
        jobId: job.id,
        providerStatus: response.status,
        providerBody: response.body,
        assetKind,
      });
      setGenerationStatus(
        completed.status === 'succeeded'
          ? '图片已保存到资产库。'
          : completed.status === 'cancelled'
            ? '已取消图片生成。'
            : (completed.error ?? '生成失败。'),
      );
      if (completed.status === 'succeeded') setAssets(await callWorker('asset.list', {}));
    } catch (reason) {
      if (preparedJobId) {
        try {
          await callWorker('image.generate.fail', { jobId: preparedJobId });
        } catch {
          // Project close/restart recovery owns terminalization when the Worker is unavailable.
        }
      }
      setGenerationStatus(errorMessage(reason, '图片生成失败。'));
    } finally {
      setGenerationJobId(undefined);
      setBusy(false);
    }
  };

  const renameAsset = async (asset: AssetInfo) => {
    const currentName = asset.relativePath.split(/[\\/]/).pop() ?? 'image.png';
    const name = window.prompt('请输入新文件名，并保留扩展名：', currentName);
    if (!name) return;
    try {
      const renamed = await callWorker('asset.rename', { assetId: asset.id, name });
      setAssets((current) => current.map((item) => (item.id === renamed.id ? renamed : item)));
    } catch (reason) {
      setGenerationStatus(errorMessage(reason, '素材重命名失败。'));
    }
  };

  const removeAsset = async (asset: AssetInfo) => {
    if (!window.confirm('确定删除此图片素材？')) return;
    try {
      await callWorker('asset.delete', { assetId: asset.id });
      setAssets((current) => current.filter((item) => item.id !== asset.id));
    } catch (reason) {
      setGenerationStatus(errorMessage(reason, '素材删除失败。'));
    }
  };

  const cancelImage = async () => {
    if (!generationJobId) return;
    try {
      await callWorker('image.generate.cancel', { jobId: generationJobId });
      setGenerationStatus('已取消图片生成。');
    } catch (reason) {
      setGenerationStatus(errorMessage(reason, '取消失败。'));
    }
  };

  const removeCredential = async () => {
    if (!credentialProvider) return;
    if (!adapter || !window.confirm('删除此供应商的本机凭据？')) return;
    setCredentialBusy(true);
    setCredentialMessage('');
    try {
      setCredentialState(await deleteCredential(credentialProvider));
      setCredentialMessage('凭据已删除');
    } catch (reason) {
      setCredentialMessage(errorMessage(reason, '凭据删除失败'));
    } finally {
      setCredentialBusy(false);
    }
  };

  const fields: AdapterUiField[] = [...(adapter?.uiSchema.fields ?? [])].sort(
    (a, b) => a.order - b.order,
  );
  const basicFields = fields.filter((field) => field.group === 'basic');
  const advancedFields = fields.filter((field) => field.group === 'advanced');

  return (
    <aside className="production-panel panel-border">
      <div className="panel-heading">
        <span>生产参数</span>
        {adapter && <small>Schema {adapter.schemaVersion}</small>}
      </div>
      {!catalog ? (
        <div className="parameter-placeholder">正在读取适配器目录</div>
      ) : (
        <>
          <div className="field-group">
            <label htmlFor="capability">生产方式</label>
            <select
              id="capability"
              value={capability ?? ''}
              onChange={(event) => chooseCapability(event.target.value as GenerationCapability)}
            >
              {catalog.capabilities.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field-group">
            <label htmlFor="provider">供应商</label>
            <select
              id="provider"
              value={provider}
              onChange={(event) => chooseProvider(event.target.value)}
            >
              {providerOptions.map((item) => (
                <option key={item.provider} value={item.provider}>
                  {item.providerLabel}
                </option>
              ))}
            </select>
          </div>
          <div className="field-group">
            <label htmlFor="model">模型</label>
            <select
              id="model"
              value={adapterKey}
              onChange={(event) => setAdapterKey(event.target.value)}
            >
              {modelOptions.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.modelLabel} · {item.apiVersion}
                </option>
              ))}
            </select>
          </div>

          {provider === 'vidu' && (
            <div className="field-group">
              <label htmlFor="provider-region">Vidu 服务区域</label>
              <select
                id="provider-region"
                value={providerRegion}
                onChange={(event) => chooseProviderRegion(event.target.value as ProviderRegion)}
                disabled={busy || credentialBusy}
              >
                <option value="cn">中国站 (api.vidu.cn)</option>
                <option value="global">国际站 (api.vidu.com)</option>
              </select>
            </div>
          )}

          {adapter && (
            <>
              <div className="adapter-meta">
                <strong>{adapter.modelLabel}</strong>
                <span>
                  {adapter.providerLabel} · API {adapter.apiVersion}
                </span>
              </div>
              <div className="parameter-fields">
                {basicFields.map((field) => (
                  <ParameterField
                    key={field.key}
                    field={field}
                    property={adapter.parameterSchema.properties[field.key]!}
                    value={parameters[field.key]}
                    required={adapter.parameterSchema.required.includes(field.key)}
                    error={
                      errors.find((item) => normalizeErrorPath(item.path) === field.key)?.message
                    }
                    onChange={(value) => updateParameter(field.key, value)}
                  />
                ))}
              </div>
              {advancedFields.length > 0 && (
                <details className="advanced-parameters">
                  <summary>专业参数</summary>
                  <div className="parameter-fields">
                    {advancedFields.map((field) => (
                      <ParameterField
                        key={field.key}
                        field={field}
                        property={adapter.parameterSchema.properties[field.key]!}
                        value={parameters[field.key]}
                        required={adapter.parameterSchema.required.includes(field.key)}
                        error={
                          errors.find((item) => normalizeErrorPath(item.path) === field.key)
                            ?.message
                        }
                        onChange={(value) => updateParameter(field.key, value)}
                      />
                    ))}
                  </div>
                </details>
              )}

              <div className="draft-actions">
                <button
                  className="button primary"
                  type="button"
                  onClick={() => void saveDraft()}
                  disabled={!writable || !shotId || busy}
                >
                  <Save size={14} />
                  保存草稿
                </button>
                {message && (
                  <span className={errors.length > 0 ? 'validation-error' : 'validation-ok'}>
                    {errors.length > 0 ? <CircleAlert size={13} /> : <CircleCheck size={13} />}
                    {message}
                  </span>
                )}
                <button
                  className="button primary"
                  type="button"
                  onClick={() => void generateImage()}
                  disabled={!writable || busy || !adapter}
                >
                  <WandSparkles size={14} />
                  生成图片
                </button>
                {generationJobId && busy && (
                  <button
                    className="icon-button danger"
                    type="button"
                    title="取消生成"
                    onClick={() => void cancelImage()}
                  >
                    <Square size={13} />
                  </button>
                )}
                <label className="asset-kind-field">
                  保存为
                  <select
                    value={assetKind}
                    onChange={(event) => setAssetKind(event.target.value as typeof assetKind)}
                    disabled={busy}
                  >
                    <option value="generated-image">普通素材</option>
                    <option value="character">角色</option>
                    <option value="scene">场景</option>
                    <option value="first-frame">首帧</option>
                    <option value="last-frame">尾帧</option>
                  </select>
                </label>
                {generationStatus && <span className="credential-message">{generationStatus}</span>}
              </div>
              {assets.length > 0 && (
                <div className="asset-list" aria-label="素材列表">
                  {assets.map((asset) => (
                    <div className="asset-row" key={asset.id}>
                      <span title={asset.sourceUrl}>{asset.relativePath}</span>
                      <small>
                        {asset.kind} · {(asset.sizeBytes / 1024).toFixed(1)} KiB
                      </small>
                      <button
                        className="icon-button subtle"
                        type="button"
                        title="重命名素材"
                        onClick={() => void renameAsset(asset)}
                      >
                        <Save size={13} />
                      </button>
                      <button
                        className="icon-button danger"
                        type="button"
                        title="删除素材"
                        onClick={() => void removeAsset(asset)}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <details className="credential-section">
                <summary>
                  <KeyRound size={14} />
                  供应商凭据
                  <span className={credential?.configured ? 'configured' : ''}>
                    {credential?.configured ? '已配置' : '未配置'}
                  </span>
                </summary>
                <div className="credential-controls">
                  <input
                    type="password"
                    value={credentialSecret}
                    onChange={(event) => setCredentialSecret(event.target.value)}
                    placeholder={`${adapter.providerLabel} API Key`}
                    autoComplete="new-password"
                    disabled={!canUseSecureCredentials() || credentialBusy}
                  />
                  <button
                    className="icon-button"
                    type="button"
                    title="保存凭据"
                    onClick={() => void saveCredential()}
                    disabled={!credentialSecret || !canUseSecureCredentials() || credentialBusy}
                  >
                    <Save size={15} />
                  </button>
                  <button
                    className="icon-button danger"
                    type="button"
                    title="删除凭据"
                    onClick={() => void removeCredential()}
                    disabled={!credential?.configured || credentialBusy}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
                {credentialMessage && (
                  <span className="credential-message">{credentialMessage}</span>
                )}
              </details>
            </>
          )}
        </>
      )}
    </aside>
  );
}

interface ParameterFieldProps {
  field: AdapterUiField;
  property: AdapterParameterProperty;
  value?: AdapterParameters[string];
  required: boolean;
  error?: string;
  onChange: (value: AdapterParameters[string] | undefined) => void;
}

function ParameterField({
  field,
  property,
  value,
  required,
  error,
  onChange,
}: ParameterFieldProps) {
  const inputId = `parameter-${field.key}`;
  const label = (
    <label htmlFor={inputId}>
      {property.title}
      {required && <span aria-label="必填">*</span>}
    </label>
  );

  if (field.control === 'toggle') {
    return (
      <div className={`parameter-field toggle-field ${error ? 'invalid' : ''}`}>
        <label htmlFor={inputId}>
          <input
            id={inputId}
            type="checkbox"
            checked={value === true}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span>{property.title}</span>
        </label>
        {error && <small>{error}</small>}
      </div>
    );
  }

  if (field.control === 'url-list') {
    const items = Array.isArray(value) && value.length > 0 ? value : [''];
    return (
      <div className={`parameter-field ${error ? 'invalid' : ''}`}>
        {label}
        <div className="url-list">
          {items.map((item, index) => (
            <div className="url-row" key={`${field.key}-${index}`}>
              <input
                id={index === 0 ? inputId : undefined}
                type="url"
                value={item}
                onChange={(event) => {
                  const next = [...items];
                  next[index] = event.target.value;
                  onChange(next.filter((entry, entryIndex) => entry || entryIndex <= index));
                }}
              />
              <button
                className="icon-button subtle"
                type="button"
                title="移除 URL"
                onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}
                disabled={items.length === 1}
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          <button
            className="icon-button subtle"
            type="button"
            title="添加 URL"
            onClick={() => onChange([...items, ''])}
            disabled={property.maxItems !== undefined && items.length >= property.maxItems}
          >
            <Plus size={14} />
          </button>
        </div>
        {error && <small>{error}</small>}
      </div>
    );
  }

  const enumValues = property.enum ?? [];
  return (
    <div className={`parameter-field ${error ? 'invalid' : ''}`}>
      {label}
      {field.control === 'select' ? (
        <select
          id={inputId}
          value={value === undefined ? '' : String(value)}
          onChange={(event) =>
            onChange(property.type === 'integer' ? Number(event.target.value) : event.target.value)
          }
        >
          {enumValues.map((item) => (
            <option key={String(item)} value={String(item)}>
              {String(item)}
            </option>
          ))}
        </select>
      ) : field.control === 'textarea' ? (
        <textarea
          id={inputId}
          value={typeof value === 'string' ? value : ''}
          maxLength={property.maxLength}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          id={inputId}
          type={field.control === 'number' ? 'number' : 'text'}
          value={typeof value === 'number' || typeof value === 'string' ? value : ''}
          min={property.minimum}
          max={property.maximum}
          onChange={(event) =>
            onChange(
              field.control === 'number'
                ? event.target.value
                  ? Number(event.target.value)
                  : undefined
                : event.target.value,
            )
          }
        />
      )}
      {error && <small>{error}</small>}
    </div>
  );
}
