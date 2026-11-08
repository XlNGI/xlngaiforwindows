import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AssetInfo } from '@ai-video/contracts';
import { projectWorker } from './worker-scope';
import { AssetImagePreview } from './AssetImagePreview';
import { referenceAssetName } from './ReferenceCard';

const PAGE_SIZE = 30;

/** Project-wide, paginated selection. Filter changes never discard the user's selection. */
export function ContinuityAssetPicker({
  projectId,
  selectedIds,
  onToggle,
  disabled,
  imagesOnly = false,
  label,
  actions,
}: {
  projectId: string;
  selectedIds: string[];
  onToggle: (asset: AssetInfo) => void;
  disabled: boolean;
  imagesOnly?: boolean;
  label: string;
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [kind, setKind] = useState(imagesOnly ? 'image' : 'all');
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(0);
  const worker = projectWorker();
  const load = async (append = false) => {
    const token = ++request.current;
    setBusy(true);
    setError('');
    const last = append ? assets.at(-1) : undefined;
    try {
      const result = await worker('asset.list', {
        kind: kind === 'all' ? undefined : kind,
        keyword: keyword.trim() || undefined,
        deleted: 'active',
        sort: 'created-desc',
        limit: PAGE_SIZE,
        cursor: last ? `${last.createdAt}|${last.id}` : undefined,
      });
      if (token !== request.current) return;
      const valid = (result ?? []).filter(
        (asset) => asset.projectId === projectId && !asset.deletedAt,
      );
      setAssets((current) => (append ? [...current, ...valid] : valid));
      setMore(valid.length === PAGE_SIZE);
    } catch (reason) {
      if (token === request.current)
        setError(reason instanceof Error ? reason.message : '项目素材读取失败。');
    } finally {
      if (token === request.current) setBusy(false);
    }
  };
  useEffect(() => {
    if (!open) return;
    setAssets([]);
    setMore(false);
    setBusy(true);
    const timer = window.setTimeout(() => void load(), 250);
    return () => {
      window.clearTimeout(timer);
      request.current++;
    };
  }, [open, projectId, keyword, kind]);
  return (
    <div className="continuity-project-picker">
      <div className="shot-continuity-actions">
        <button
          type="button"
          disabled={disabled}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {label}
        </button>
        {actions}
      </div>
      {open && (
        <div role="group" aria-label={label}>
          <div className="shot-continuity-actions">
            <label>
              搜索
              <input
                aria-label={`${label}搜索`}
                value={keyword}
                disabled={disabled}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="别名、文件名或标签"
              />
            </label>
            {!imagesOnly && (
              <label>
                素材类型
                <select
                  value={kind}
                  disabled={disabled}
                  onChange={(event) => setKind(event.target.value)}
                >
                  <option value="all">图片和视频</option>
                  <option value="image">图片</option>
                  <option value="video">视频</option>
                </select>
              </label>
            )}
          </div>
          <div className="shot-continuity-frames continuity-project-results">
            {assets.map((asset) => (
              <article key={asset.id}>
                {!asset.kind.includes('video') && <AssetImagePreview asset={asset} />}
                <label>
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={selectedIds.includes(asset.id)}
                    onChange={() => onToggle(asset)}
                  />
                  <span title={referenceAssetName(asset)}>{referenceAssetName(asset)}</span>
                </label>
                {asset.kind.includes('video') && <small>视频</small>}
              </article>
            ))}
          </div>
          {!busy && !assets.length && !error && <p>没有符合条件的项目素材。</p>}
          {busy && <p role="status">正在读取项目素材…</p>}
          {error && <p role="status">{error}</p>}
          {more && (
            <button type="button" disabled={disabled || busy} onClick={() => void load(true)}>
              加载更多素材
            </button>
          )}
        </div>
      )}
    </div>
  );
}
