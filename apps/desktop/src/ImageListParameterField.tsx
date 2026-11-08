import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, ImagePlus, Plus, Trash2 } from 'lucide-react';
import type {
  AdapterParameterProperty,
  AdapterParameters,
  AdapterUiField,
} from '@ai-video/contracts';
import { imageAssetId, ParameterImagePreview } from './ParameterImagePreview';
import { projectWorker, workerScope } from './worker-scope';
import { parseAssetDrop, useAssetDrop } from './assets/use-asset-drop';
import {
  isLocalImageDataUrl,
  MAX_LOCAL_IMAGE_TOTAL_BYTES,
  readLocalImageFile,
  totalLocalImageBytes,
  type LocalImageSelection,
} from './local-image-input';

/** Shared by the production panel and the Agent's reviewed generation form. */
export function ImageListParameterField({
  field,
  property,
  value,
  error,
  onChange,
  projectId,
  inputId,
  label,
  description,
  onPendingChange,
}: {
  field: Pick<AdapterUiField, 'key' | 'placeholder'>;
  property: AdapterParameterProperty;
  value?: AdapterParameters[string];
  error?: string;
  onChange: (value: AdapterParameters[string] | undefined) => void;
  projectId?: string;
  inputId: string;
  label: ReactNode;
  description: ReactNode;
  onPendingChange?: (pending: boolean) => void;
}) {
  const scope = workerScope(projectId);
  const callWorker = projectWorker(scope);
  const [localFiles, setLocalFiles] = useState<Array<LocalImageSelection | undefined>>([]);
  const [selectionError, setSelectionError] = useState('');
  const [busy, setBusy] = useState(false);
  const instanceId = useId();
  const fileInputs = useRef<Array<HTMLInputElement | null>>([]);
  const operation = useRef(0);
  const active = useRef(true);
  const latest = useRef({ value, projectId, sessionId: scope?.projectSessionId, onPendingChange });
  latest.current = { value, projectId, sessionId: scope?.projectSessionId, onPendingChange };
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      operation.current += 1;
      latest.current.onPendingChange?.(false);
    };
  }, []);
  const begin = () => {
    const token = ++operation.current;
    const snapshot = latest.current;
    setBusy(true);
    onPendingChange?.(true);
    const current = () =>
      active.current &&
      operation.current === token &&
      latest.current.value === snapshot.value &&
      latest.current.projectId === snapshot.projectId &&
      workerScope(projectId)?.projectSessionId === snapshot.sessionId;
    return {
      current,
      finish() {
        if (active.current && operation.current === token) {
          setBusy(false);
          latest.current.onPendingChange?.(false);
        }
      },
    };
  };
  const minimumRows = Math.max(1, property.minItems ?? 1);
  const currentItems = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
  const items = Array.from(
    { length: Math.max(minimumRows, currentItems.length) },
    (_, index) => currentItems[index] ?? '',
  );
  const commitItems = (next: string[]) => {
    operation.current += 1;
    setBusy(false);
    onPendingChange?.(false);
    setSelectionError('');
    onChange(next);
  };
  const chooseLocalFile = async (file: File | undefined, index: number) => {
    if (!file) return;
    const pending = begin();
    try {
      const selected = await readLocalImageFile(file);
      if (!pending.current()) return;
      const next = [...items];
      next[index] = selected.dataUrl;
      if (totalLocalImageBytes(next) > MAX_LOCAL_IMAGE_TOTAL_BYTES) {
        throw new Error('同一请求中的本地图片合计不能超过 20 MiB。');
      }
      setLocalFiles((current) => {
        const updated = [...current];
        updated[index] = selected;
        return updated;
      });
      commitItems(next);
    } catch (reason) {
      if (pending.current())
        setSelectionError(reason instanceof Error ? reason.message : '本地图片选择失败。');
    } finally {
      pending.finish();
    }
  };
  const clearItem = (index: number) => {
    if (items.length <= minimumRows) {
      const next = [...items];
      next[index] = '';
      setLocalFiles((current) => {
        const updated = [...current];
        updated[index] = undefined;
        return updated;
      });
      commitItems(next);
    } else {
      setLocalFiles((current) => current.filter((_, itemIndex) => itemIndex !== index));
      commitItems(items.filter((_, itemIndex) => itemIndex !== index));
    }
  };
  const moveItem = (index: number, offset: number) => {
    const destination = index + offset;
    if (destination < 0 || destination >= items.length) return;
    const next = [...items];
    [next[index], next[destination]] = [next[destination]!, next[index]!];
    setLocalFiles((current) => {
      const updated = [...current];
      [updated[index], updated[destination]] = [updated[destination], updated[index]];
      return updated;
    });
    commitItems(next);
  };
  const visibleError = selectionError || error;
  const dropAssets = async (raw: string, target: Element | null) => {
    const pending = begin();
    try {
      const payload = parseAssetDrop(raw);
      if (
        payload.version !== 1 ||
        !projectId ||
        payload.projectId !== projectId ||
        !payload.assets?.length
      )
        throw new Error('只能拖入当前项目的素材。');
      if (workerScope() && !scope) throw new Error('任务所属项目尚未挂接，请重新打开项目。');
      if (payload.assets.some((item) => item.kind.includes('video')))
        throw new Error('此参数只接受图片素材。');
      const maximum = property.maxItems ?? 20;
      if (payload.assets.length > maximum) throw new Error(`最多可拖入 ${maximum} 项素材。`);
      const sources = await Promise.all(
        payload.assets.map((item) => callWorker('asset.mediaSource', { assetId: item.id })),
      );
      if (!pending.current()) return;
      if (sources.some((source) => !source.contentType.startsWith('image/')))
        throw new Error('此参数只接受图片素材。');
      const row = target?.closest<HTMLElement>('[data-image-drop-index]');
      const index = row ? Number(row.dataset.imageDropIndex) : undefined;
      const next =
        index !== undefined && payload.assets.length === 1
          ? items.map((item, at) => (at === index ? `asset://${payload.assets[0]!.id}` : item))
          : payload.assets.map((item) => `asset://${item.id}`);
      while (next.length < minimumRows) next.push('');
      if (index !== undefined && payload.assets.length === 1)
        setLocalFiles((current) => current.map((item, at) => (at === index ? undefined : item)));
      else setLocalFiles([]);
      commitItems(next);
    } catch (reason) {
      if (pending.current())
        setSelectionError(reason instanceof Error ? reason.message : '素材拖入失败。');
    } finally {
      pending.finish();
    }
  };
  const drop = useAssetDrop<HTMLDivElement>({
    onDrop: (raw, target) => void dropAssets(raw, target),
  });
  return (
    <div
      ref={drop.ref}
      {...drop.handlers}
      className={`parameter-field asset-drop-target ${drop.hovering ? 'is-asset-drag-over' : ''} ${visibleError ? 'invalid' : ''}`}
      aria-busy={busy}
    >
      <div className="parameter-field-heading">
        {label}
        {(property.maxItems === undefined || items.length < property.maxItems) && (
          <button
            className="button secondary url-list-add"
            type="button"
            title="添加图片输入"
            onClick={() => commitItems([...items, ''])}
          >
            <Plus size={14} />
            添加图片
          </button>
        )}
      </div>
      {description}
      <div className="url-list">
        {items.map((item, index) => {
          const selectedFile = localFiles[index];
          const localFile = selectedFile?.dataUrl === item ? selectedFile : undefined;
          const orderedRole = property.minItems === 2 && property.maxItems === 2;
          const rowLabel = orderedRole ? (index === 0 ? '首帧' : '尾帧') : undefined;
          const fileInputId = `${inputId}-${instanceId}-file-${index}`;
          const assetId = imageAssetId(item);
          const hasImage = isLocalImageDataUrl(item) || Boolean(assetId);
          const imageName = assetId ? '素材库图片' : (localFile?.name ?? '本地图片');
          const previewLabel = `${rowLabel ?? property.title}：${imageName}`;
          return (
            <div
              data-image-drop-index={index}
              className={`url-list-item ${hasImage ? 'is-image' : 'is-url'}`}
              key={`${field.key}-${index}`}
            >
              {rowLabel && <span className="url-row-role">{rowLabel}</span>}
              <div className={`url-row${hasImage ? ' has-image' : ''}`}>
                {hasImage ? (
                  <div className="local-image-value" id={index === 0 ? inputId : undefined}>
                    <ParameterImagePreview
                      value={item}
                      projectId={projectId}
                      label={previewLabel}
                    />
                  </div>
                ) : (
                  <input
                    id={index === 0 ? inputId : undefined}
                    aria-label={rowLabel ? `${rowLabel} URL` : undefined}
                    type="url"
                    value={item}
                    placeholder={
                      rowLabel
                        ? `输入${rowLabel}公开 URL`
                        : (field.placeholder ?? '输入图片公开 URL，或选择本地图片')
                    }
                    onChange={(event) => {
                      const next = [...items];
                      next[index] = event.target.value;
                      setLocalFiles((current) => {
                        const updated = [...current];
                        updated[index] = undefined;
                        return updated;
                      });
                      commitItems(next);
                    }}
                  />
                )}
                <div className="url-row-actions">
                  <button
                    className="icon-button subtle file-picker-button"
                    type="button"
                    title={item ? '替换为本地图片' : '选择本地图片'}
                    onClick={() => fileInputs.current[index]?.click()}
                  >
                    <ImagePlus size={14} />
                    {!item && <span>选择图片</span>}
                  </button>
                  <input
                    id={fileInputId}
                    ref={(node) => {
                      fileInputs.current[index] = node;
                    }}
                    className="url-file-input"
                    type="file"
                    accept="image/png,image/jpeg,image/webp,.jpg,.jpeg,.png,.webp"
                    aria-label={`为${rowLabel ?? property.title}选择本地图片`}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = '';
                      void chooseLocalFile(file, index);
                    }}
                  />
                  <button
                    className="icon-button subtle"
                    type="button"
                    title="上移"
                    onClick={() => moveItem(index, -1)}
                    disabled={index === 0}
                  >
                    <ChevronUp size={13} />
                  </button>
                  <button
                    className="icon-button subtle"
                    type="button"
                    title="下移"
                    onClick={() => moveItem(index, 1)}
                    disabled={index >= items.length - 1}
                  >
                    <ChevronDown size={13} />
                  </button>
                  <button
                    className="icon-button subtle"
                    type="button"
                    title={item ? '清除此图片输入' : '移除此输入行'}
                    onClick={() => clearItem(index)}
                    disabled={!item && items.length <= minimumRows}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {busy && <small role="status">正在读取图片…</small>}
      {visibleError && <small className="parameter-error">{visibleError}</small>}
    </div>
  );
}
