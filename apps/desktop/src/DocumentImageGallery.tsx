import { useEffect, useRef, useState } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import type { AssetInfo } from '@ai-video/contracts';
import { projectWorker } from './worker-scope';
import { useContinuityFileDrop } from './continuity-file-drop';
import { AssetImagePreview } from './AssetImagePreview';

export function DocumentImageGallery({
  projectId,
  documentId,
  writable,
  assets,
  onOpenAsset,
  onImported,
  onRemoved,
}: {
  projectId?: string;
  documentId?: string;
  writable: boolean;
  assets: AssetInfo[];
  onOpenAsset?: (assetId: string) => void;
  onImported?: (assets: AssetInfo[]) => void;
  onRemoved?: (assetId: string) => void;
}) {
  const worker = projectWorker();
  const ref = useRef<HTMLElement>(null);
  const running = useRef(false);
  const epoch = useRef(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [added, setAdded] = useState<AssetInfo[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [removing, setRemoving] = useState<string>();
  const enabled = writable && Boolean(projectId && documentId) && !busy;
  useEffect(() => {
    epoch.current++;
    setAdded([]);
    setRemoved([]);
    setRemoving(undefined);
    setMessage('');
    setBusy(false);
    running.current = false;
    return () => {
      epoch.current++;
    };
  }, [projectId, documentId]);
  useEffect(() => {
    setAdded((current) => current.filter((asset) => !assets.some((item) => item.id === asset.id)));
    setRemoved((current) => current.filter((id) => assets.some((item) => item.id === id)));
  }, [assets]);
  const latest = useRef({ writable, projectId, documentId, onImported, onRemoved });
  latest.current = { writable, projectId, documentId, onImported, onRemoved };
  const action = async (choose: () => Promise<string[]> | string[]) => {
    if (!enabled || running.current) return;
    const token = epoch.current;
    const valid = () => token === epoch.current && latest.current.writable;
    running.current = true;
    setBusy(true);
    setMessage('');
    try {
      const paths = await choose();
      if (!valid() || !paths.length) return;
      if (paths.length > 12) throw new Error('每次最多添加 12 张图片。');
      if (paths.some((path) => !/\.(png|jpe?g|webp)$/i.test(path)))
        throw new Error('仅支持 PNG、JPEG、WebP 图片。');
      const imported = await worker('document.images.import', {
        documentId: documentId!,
        sourcePaths: [...new Set(paths)],
      });
      if (!valid()) return;
      setRemoved((current) => current.filter((id) => !imported.some((asset) => asset.id === id)));
      setAdded((current) => [
        ...new Map([...current, ...imported].map((asset) => [asset.id, asset])).values(),
      ]);
      latest.current.onImported?.(imported);
      window.dispatchEvent(new CustomEvent('production-source-updated'));
      setMessage(`已添加并绑定 ${imported.length} 张图片。`);
    } catch (error) {
      if (valid()) setMessage(error instanceof Error ? error.message : '添加图片失败，请重试。');
    } finally {
      if (token === epoch.current) {
        running.current = false;
        setBusy(false);
      }
    }
  };
  const removeImage = async (asset: AssetInfo) => {
    if (!enabled || running.current) return;
    const token = epoch.current;
    const valid = () => token === epoch.current && latest.current.writable;
    running.current = true;
    setBusy(true);
    setRemoving(asset.id);
    setMessage('');
    try {
      await worker('document.images.unbind', {
        documentId: documentId!,
        assetId: asset.id,
      });
      if (!valid()) return;
      setAdded((current) => current.filter((item) => item.id !== asset.id));
      setRemoved((current) => [...new Set([...current, asset.id])]);
      latest.current.onRemoved?.(asset.id);
      window.dispatchEvent(new CustomEvent('production-source-updated'));
      setMessage('已解除图片绑定，素材保留在素材库。');
    } catch (error) {
      if (!valid()) return;
      const reason = error instanceof Error ? error.message : String(error);
      setMessage(reason || '移除图片失败，请重试。');
    } finally {
      if (token === epoch.current) {
        running.current = false;
        setBusy(false);
        setRemoving(undefined);
      }
    }
  };
  const hovering = useContinuityFileDrop(
    ref,
    enabled,
    (paths) => {
      void action(() => paths);
    },
    setMessage,
    '[data-document-image-drop]',
  );
  const images = [
    ...new Map([...assets, ...added].map((asset) => [asset.id, asset])).values(),
  ].filter((asset) => !asset.deletedAt && !removed.includes(asset.id));
  return (
    <section
      ref={ref}
      data-document-image-drop
      className={`character-scene-gallery document-image-gallery${images.length ? '' : ' is-empty'}${hovering ? ' is-file-drag-over' : ''}`}
      aria-label="绑定图片"
      aria-busy={busy}
      onDragOver={(event) => {
        if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!Array.from(event.dataTransfer.types).includes('Files')) return;
        event.preventDefault();
        if (enabled && !('__TAURI_INTERNALS__' in window))
          setMessage('请在 Windows 桌面应用中选择或拖入电脑图片。');
      }}
    >
      <div className="workspace-section-heading">
        <h2>绑定图片</h2>
        <span className="workspace-count">{images.length} 张</span>
        <button
          type="button"
          className="button secondary document-image-add"
          disabled={!enabled}
          onClick={() =>
            void action(async () => {
              if (!('__TAURI_INTERNALS__' in window))
                throw new Error('请在 Windows 桌面应用中选择或拖入电脑图片。');
              const paths = await openDialog({
                multiple: true,
                filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
              });
              return paths ? (typeof paths === 'string' ? [paths] : paths) : [];
            })
          }
        >
          <ImagePlus size={14} aria-hidden="true" />
          {busy && !removing ? '正在添加…' : '添加图片'}
        </button>
      </div>
      <p className="workspace-hint">
        {!writable
          ? '当前资料只读，可查看已绑定图片。'
          : !documentId
            ? '请先保存资料，再添加或拖入电脑图片。'
            : '选择电脑中的图片，或拖到此处，自动绑定到当前资料。支持 PNG、JPEG、WebP，单张不超过 20 MiB。'}
      </p>
      {message && (
        <p className="inline-status" role="status">
          {message}
        </p>
      )}
      {images.length === 0 ? (
        <p className="character-scene-gallery-empty">尚未绑定图片，可添加本地图片或生成新图片。</p>
      ) : (
        <ul className="character-scene-gallery-grid">
          {images.map((asset) => (
            <li key={asset.id}>
              <AssetImagePreview asset={asset} />
              {onOpenAsset && (
                <button
                  className="image-library-link"
                  type="button"
                  onClick={() => onOpenAsset(asset.id)}
                >
                  查看素材
                </button>
              )}
              <button
                className="document-image-remove danger"
                type="button"
                title="仅解除当前资料的图片绑定，素材仍保留在素材库"
                aria-label={`移除图片：${asset.alias || '未命名图片'}`}
                disabled={!enabled}
                onClick={() => void removeImage(asset)}
              >
                <Trash2 size={13} aria-hidden="true" />
                {removing === asset.id ? '正在移除…' : '移除图片'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
