import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import {
  Check,
  ChevronDown,
  ExternalLink,
  FolderOpen,
  Image,
  Images,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  Video,
  X,
} from 'lucide-react';
import type {
  AssetGroupInfo,
  AssetInfo,
  AssetMediaSourceInfo,
  AssetSourceInfo,
  AssetTagInfo,
} from '@ai-video/contracts';
import { callWorker } from '../worker-client';

type MediaFilter = 'all' | 'image' | 'video';
const PAGE_SIZE = 60;
const DRAG_MIME = 'application/x-ai-video-asset+json';

interface AssetLibraryViewProps {
  writable: boolean;
  selectedAssetId?: string;
  onOpenSource?: (source: AssetSourceInfo) => void;
}

function displayName(asset: AssetInfo) {
  return asset.alias?.trim() || asset.relativePath.split(/[\\/]/).pop() || '未命名素材';
}

function cursorFor(asset: AssetInfo) {
  return `${asset.createdAt}|${asset.id}`;
}

function mediaSrcFor(assetId: string, absolutePath: string): string | undefined {
  if (!('__TAURI_INTERNALS__' in window)) return `/worker-media/${encodeURIComponent(assetId)}`;
  try {
    return convertFileSrc(absolutePath);
  } catch {
    return undefined;
  }
}

export function AssetLibraryView({
  writable,
  selectedAssetId,
  onOpenSource,
}: AssetLibraryViewProps) {
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>('all');
  const [showTrash, setShowTrash] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [createdFrom, setCreatedFrom] = useState('');
  const [createdTo, setCreatedTo] = useState('');
  const [sort, setSort] = useState<'created-asc' | 'created-desc'>('created-desc');
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [tags, setTags] = useState<AssetTagInfo[]>([]);
  const [groups, setGroups] = useState<AssetGroupInfo[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>(
    selectedAssetId ? [selectedAssetId] : [],
  );
  const [mediaSourceById, setMediaSourceById] = useState<Record<string, AssetMediaSourceInfo>>({});
  const [groupAssets, setGroupAssets] = useState<Record<string, AssetInfo[]>>({});
  const [message, setMessage] = useState('');
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [tagManagerOpen, setTagManagerOpen] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [editingTag, setEditingTag] = useState<AssetTagInfo>();
  const [groupEditor, setGroupEditor] = useState<Partial<AssetGroupInfo>>();
  const [bulkTagId, setBulkTagId] = useState('');
  const selectionAnchor = useRef<string | undefined>(undefined);

  const kind = mediaFilter === 'all' ? undefined : mediaFilter;
  const selected = assets.find((asset) => asset.id === selectedIds.at(-1));

  const loadTags = useCallback(async (filter = '') => {
    const result = await callWorker('tag.list', { keyword: filter || undefined });
    setTags(result);
    return result;
  }, []);

  const loadGroups = useCallback(async (filter = '') => {
    const result = await callWorker('assetGroup.list', { keyword: filter || undefined });
    setGroups(result);
    const resolved = await Promise.all(
      result.map(
        async (group) =>
          [group.id, await callWorker('assetGroup.resolve', { groupId: group.id })] as const,
      ),
    );
    setGroupAssets(Object.fromEntries(resolved));
  }, []);

  const loadAssets = useCallback(
    async (append = false) => {
      const cursor = append && assets.length ? cursorFor(assets.at(-1)!) : undefined;
      const result = await callWorker('asset.list', {
        keyword: keyword || undefined,
        kind,
        tagIds: tagFilter,
        deleted: showTrash ? 'trash' : 'active',
        createdFrom: createdFrom ? new Date(`${createdFrom}T00:00:00`).toISOString() : undefined,
        createdTo: createdTo ? new Date(`${createdTo}T23:59:59.999`).toISOString() : undefined,
        sort,
        cursor,
        limit: PAGE_SIZE,
      });
      setAssets((current) => (append ? [...current, ...result] : result));
      setHasMore(result.length === PAGE_SIZE);
      if (!append) {
        setSelectedIds((current) => {
          const preferred = current.at(-1);
          const next =
            preferred && result.some((asset) => asset.id === preferred) ? preferred : result[0]?.id;
          return next ? [next] : [];
        });
      }
    },
    [assets, createdFrom, createdTo, keyword, kind, showTrash, sort, tagFilter],
  );

  useEffect(() => {
    if (selectedAssetId) setSelectedIds([selectedAssetId]);
  }, [selectedAssetId]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setMessage('');
      const action = Promise.all([loadAssets(), loadTags(), loadGroups()]).then(() => undefined);
      void action.catch((error) => setMessage(String(error)));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [mediaFilter, showTrash, keyword, createdFrom, createdTo, sort, tagFilter.join(',')]);

  useEffect(() => {
    const media = assets.filter((asset) => !mediaSourceById[asset.id] && !asset.deletedAt);
    if (!media.length) return;
    let active = true;
    void Promise.all(
      media.map(async (asset) => {
        try {
          return [asset.id, await callWorker('asset.mediaSource', { assetId: asset.id })] as const;
        } catch {
          return undefined;
        }
      }),
    ).then((entries) => {
      if (active)
        setMediaSourceById((current) => ({
          ...current,
          ...Object.fromEntries(
            entries.filter(Boolean) as Array<readonly [string, AssetMediaSourceInfo]>,
          ),
        }));
    });
    return () => {
      active = false;
    };
  }, [assets]);

  const beginDrag = (
    event: React.DragEvent,
    items: AssetInfo[],
    sourceType = 'asset',
    sourceId?: string,
  ) => {
    if (!items.length) {
      event.preventDefault();
      return;
    }
    const ordered = [...items].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
    const payload = {
      version: 1,
      projectId: ordered[0]!.projectId,
      sourceType,
      sourceId,
      snapshotAt: new Date().toISOString(),
      assets: ordered.map(({ id, kind: assetKind, createdAt }) => ({
        id,
        kind: assetKind,
        createdAt,
      })),
    };
    event.dataTransfer.setData(DRAG_MIME, JSON.stringify(payload));
    event.dataTransfer.setData('text/plain', JSON.stringify(payload));
    event.dataTransfer.effectAllowed = 'copy';
  };

  const selectAsset = (event: React.MouseEvent, asset: AssetInfo) => {
    if (event.shiftKey && selectionAnchor.current) {
      const start = assets.findIndex((item) => item.id === selectionAnchor.current);
      const end = assets.findIndex((item) => item.id === asset.id);
      if (start >= 0 && end >= 0) {
        const range = assets
          .slice(Math.min(start, end), Math.max(start, end) + 1)
          .map((item) => item.id);
        setSelectedIds(
          event.ctrlKey || event.metaKey ? [...new Set([...selectedIds, ...range])] : range,
        );
        return;
      }
    }
    selectionAnchor.current = asset.id;
    setSelectedIds((current) =>
      event.ctrlKey || event.metaKey
        ? current.includes(asset.id)
          ? current.filter((id) => id !== asset.id)
          : [...current, asset.id]
        : [asset.id],
    );
  };

  const reloadCurrent = async () => {
    await Promise.all([loadAssets(), loadTags(), loadGroups()]);
  };

  const deleteAsset = async (asset: AssetInfo) => {
    try {
      await callWorker('asset.delete', { assetId: asset.id });
    } catch (error) {
      if (
        !String(error).includes('referenced by') ||
        !window.confirm(`${String(error)}\n仍要移到回收站吗？`)
      )
        throw error;
      await callWorker('asset.delete', { assetId: asset.id, confirm: true });
    }
    await loadAssets();
  };

  const saveTag = async () => {
    const name = (editingTag?.name ?? newTagName).trim();
    if (!name) return;
    if (editingTag) await callWorker('tag.update', { tagId: editingTag.id, name });
    else await callWorker('tag.create', { name });
    setNewTagName('');
    setEditingTag(undefined);
    await reloadCurrent();
  };

  const saveGroup = async () => {
    const name = groupEditor?.name?.trim();
    const tagIds = groupEditor?.tagIds ?? [];
    if (!name || !tagIds.length) return;
    if (groupEditor?.id)
      await callWorker('assetGroup.update', { groupId: groupEditor.id, name, tagIds });
    else await callWorker('assetGroup.create', { name, tagIds });
    setGroupEditor(undefined);
    await loadGroups();
  };

  const selectedAssets = useMemo(
    () => assets.filter((asset) => selectedIds.includes(asset.id)),
    [assets, selectedIds],
  );

  const selectGroup = (group?: AssetGroupInfo) => {
    setSelectedGroupId(group?.id ?? '');
    setTagFilter(group?.tagIds ?? []);
    setSelectedIds([]);
  };

  const clearFilters = () => {
    setKeyword('');
    setMediaFilter('all');
    setCreatedFrom('');
    setCreatedTo('');
    setTagFilter([]);
    setSelectedGroupId('');
  };

  return (
    <div className="asset-library-shell">
      <section className="asset-library-main">
        <header className="asset-library-toolbar">
          <div>
            <span className="eyebrow">项目素材</span>
            <h1>{showTrash ? '回收站' : '素材库'}</h1>
          </div>
          <div className="asset-toolbar-actions">
            <label className="asset-search">
              <Search size={16} />
              <input
                aria-label="搜索"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="搜索别名、文件名或标签"
              />
            </label>
            <button
              type="button"
              className={showTrash ? 'button danger active' : 'button subtle'}
              onClick={() => {
                setShowTrash((current) => !current);
                setSelectedIds([]);
              }}
            >
              {showTrash ? <RotateCcw size={15} /> : <Trash2 size={15} />}
              {showTrash ? '返回素材库' : '回收站'}
            </button>
          </div>
        </header>

        <div className="asset-filter-bar">
          <label className="asset-type-select">
            {mediaFilter === 'image' ? (
              <Image size={14} />
            ) : mediaFilter === 'video' ? (
              <Video size={14} />
            ) : (
              <Images size={14} />
            )}
            <select
              aria-label="素材类型"
              value={mediaFilter}
              onChange={(event) => setMediaFilter(event.target.value as MediaFilter)}
            >
              <option value="all">全部素材</option>
              <option value="image">图片</option>
              <option value="video">视频</option>
            </select>
            <ChevronDown size={13} />
          </label>
          {!showTrash && (
            <>
              <details className="asset-filter-menu asset-manager-menu">
                <summary>
                  <FolderOpen size={14} />
                  素材组{selectedGroupId ? ' (1)' : ''}
                  <ChevronDown size={13} />
                </summary>
                <div>
                  <button
                    type="button"
                    className={
                      !selectedGroupId ? 'asset-filter-choice active' : 'asset-filter-choice'
                    }
                    onClick={() => selectGroup()}
                  >
                    全部素材组
                  </button>
                  {groups.map((group) => (
                    <div
                      className="asset-filter-option"
                      key={group.id}
                      draggable={Boolean(groupAssets[group.id]?.length)}
                      onDragStart={(event) =>
                        beginDrag(event, groupAssets[group.id] ?? [], 'asset-group', group.id)
                      }
                    >
                      <button
                        type="button"
                        className={
                          selectedGroupId === group.id
                            ? 'asset-filter-choice active'
                            : 'asset-filter-choice'
                        }
                        onClick={() => selectGroup(group)}
                      >
                        <span>{group.name}</span>
                        <small>{group.assetCount ?? 0}</small>
                      </button>
                      <button
                        type="button"
                        className="icon-button"
                        title="编辑素材组"
                        disabled={!writable}
                        onClick={() => setGroupEditor(group)}
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        className="icon-button danger"
                        title="删除素材组"
                        disabled={!writable}
                        onClick={() => {
                          if (window.confirm(`删除素材组“${group.name}”？`))
                            void callWorker('assetGroup.delete', { groupId: group.id })
                              .then(reloadCurrent)
                              .catch((error) => setMessage(String(error)));
                        }}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="asset-filter-new"
                    disabled={!writable}
                    onClick={() => setGroupEditor({ name: '', tagIds: [] })}
                  >
                    <Plus size={13} /> 新建素材组
                  </button>
                </div>
              </details>
            </>
          )}
          <div className="asset-filter-spacer" />
          <label>
            起始日期
            <input
              aria-label="起始日期"
              type="date"
              value={createdFrom}
              onChange={(event) => setCreatedFrom(event.target.value)}
            />
          </label>
          <label>
            结束日期
            <input
              aria-label="结束日期"
              type="date"
              value={createdTo}
              onChange={(event) => setCreatedTo(event.target.value)}
            />
          </label>
          <label>
            排序
            <select
              aria-label="排序"
              value={sort}
              onChange={(event) => setSort(event.target.value as typeof sort)}
            >
              <option value="created-desc">最新优先</option>
              <option value="created-asc">最早优先</option>
            </select>
          </label>
          {(keyword ||
            mediaFilter !== 'all' ||
            createdFrom ||
            createdTo ||
            tagFilter.length > 0) && (
            <button type="button" className="button subtle" onClick={clearFilters}>
              <X size={14} />
              清空筛选
            </button>
          )}
          {!showTrash && selectedIds.length > 0 && (
            <span className="asset-selection-count">已选 {selectedIds.length} 项</span>
          )}
          {!showTrash && selectedIds.length > 0 && writable && (
            <div className="asset-bulk-tags">
              <select
                aria-label="批量标签"
                value={bulkTagId}
                onChange={(event) => setBulkTagId(event.target.value)}
              >
                <option value="">选择标签</option>
                {tags.map((tag) => (
                  <option key={tag.id} value={tag.id}>
                    {tag.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!bulkTagId}
                onClick={() =>
                  void callWorker('asset.tags.add', {
                    assetIds: selectedIds,
                    tagIds: [bulkTagId],
                  })
                    .then(reloadCurrent)
                    .catch((error) => setMessage(String(error)))
                }
              >
                添加
              </button>
              <button
                type="button"
                disabled={!bulkTagId}
                onClick={() =>
                  void callWorker('asset.tags.remove', {
                    assetIds: selectedIds,
                    tagIds: [bulkTagId],
                  })
                    .then(reloadCurrent)
                    .catch((error) => setMessage(String(error)))
                }
              >
                移除
              </button>
            </div>
          )}
        </div>

        {groupEditor && (
          <div className="asset-editor-strip">
            <form
              className="asset-group-editor"
              onSubmit={(event) => {
                event.preventDefault();
                void saveGroup().catch((error) => setMessage(String(error)));
              }}
            >
              <label>
                名称
                <input
                  aria-label="素材组名称"
                  value={groupEditor.name ?? ''}
                  onChange={(event) => setGroupEditor({ ...groupEditor, name: event.target.value })}
                />
              </label>
              <fieldset>
                <legend>标签条件（同时满足）</legend>
                {tags.map((tag) => (
                  <label key={tag.id}>
                    <input
                      type="checkbox"
                      checked={groupEditor.tagIds?.includes(tag.id) ?? false}
                      onChange={() =>
                        setGroupEditor({
                          ...groupEditor,
                          tagIds: groupEditor.tagIds?.includes(tag.id)
                            ? groupEditor.tagIds.filter((id) => id !== tag.id)
                            : [...(groupEditor.tagIds ?? []), tag.id],
                        })
                      }
                    />
                    {tag.name}
                  </label>
                ))}
              </fieldset>
              <div>
                <button
                  type="submit"
                  className="button primary"
                  disabled={!groupEditor.name?.trim() || !groupEditor.tagIds?.length}
                >
                  <Check size={14} />
                  保存
                </button>
                <button type="button" className="button" onClick={() => setGroupEditor(undefined)}>
                  取消
                </button>
              </div>
            </form>
          </div>
        )}

        {tagManagerOpen && (
          <div className="asset-editor-strip">
            <div className="asset-tag-manager">
              <form
                className="asset-inline-editor"
                onSubmit={(event) => {
                  event.preventDefault();
                  void saveTag().catch((error) => setMessage(String(error)));
                }}
              >
                <input
                  aria-label="标签名称"
                  placeholder="新建标签"
                  value={editingTag?.name ?? newTagName}
                  onChange={(event) =>
                    editingTag
                      ? setEditingTag({ ...editingTag, name: event.target.value })
                      : setNewTagName(event.target.value)
                  }
                />
                <button
                  type="submit"
                  className="button primary"
                  disabled={!writable || !(editingTag?.name ?? newTagName).trim()}
                >
                  <Check size={14} />
                  {editingTag ? '保存' : '新建'}
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    setTagManagerOpen(false);
                    setEditingTag(undefined);
                    setNewTagName('');
                  }}
                >
                  关闭
                </button>
              </form>
              <div className="asset-tag-manager-list">
                {tags.map((tag) => (
                  <div className="asset-tag-manager-row" key={tag.id}>
                    <span>{tag.name}</span>
                    <small>{tag.assetCount ?? 0} 项素材</small>
                    <button
                      type="button"
                      className="icon-button"
                      title="编辑标签"
                      disabled={!writable}
                      onClick={() => setEditingTag(tag)}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      className="icon-button danger"
                      title="删除标签"
                      disabled={!writable}
                      onClick={() => {
                        if (window.confirm(`删除标签“${tag.name}”？`))
                          void callWorker('tag.delete', { tagId: tag.id })
                            .then(reloadCurrent)
                            .catch((error) => setMessage(String(error)));
                      }}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                ))}
                {tags.length === 0 && <span className="asset-filter-empty">暂无标签</span>}
              </div>
            </div>
          </div>
        )}

        <div className="asset-library-content">
          <div className="asset-grid" role="listbox" aria-label="素材">
            {assets.map((asset) => {
              const isSelected = selectedIds.includes(asset.id);
              const dragItems = isSelected && selectedAssets.length > 1 ? selectedAssets : [asset];
              return (
                <div
                  role="option"
                  tabIndex={0}
                  aria-selected={isSelected}
                  draggable={!asset.deletedAt}
                  onDragStart={(event) =>
                    beginDrag(event, dragItems, dragItems.length > 1 ? 'selection' : 'asset')
                  }
                  key={asset.id}
                  className={isSelected ? 'asset-card selected' : 'asset-card'}
                  onClick={(event) => selectAsset(event, asset)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      selectAsset(event as unknown as React.MouseEvent, asset);
                    }
                  }}
                >
                  <div className="asset-thumb">
                    {!asset.kind.includes('video') && mediaSourceById[asset.id] ? (
                      <img src={mediaSrcFor(asset.id, mediaSourceById[asset.id]!.path)} alt="" />
                    ) : asset.kind.includes('video') && mediaSourceById[asset.id] ? (
                      <video
                        src={mediaSrcFor(asset.id, mediaSourceById[asset.id]!.path)}
                        controls
                        preload="metadata"
                        onClick={(event) => event.stopPropagation()}
                      />
                    ) : asset.kind.includes('video') ? (
                      <Video size={30} />
                    ) : (
                      <Image size={30} />
                    )}
                  </div>
                  <strong title={displayName(asset)}>{displayName(asset)}</strong>
                  <div className="asset-card-tags">
                    {asset.tags?.slice(0, 2).map((tag) => (
                      <span key={tag.id}>{tag.name}</span>
                    ))}
                    {(asset.tags?.length ?? 0) > 2 && <span>+{asset.tags!.length - 2}</span>}
                  </div>
                  <small>{new Date(asset.createdAt).toLocaleDateString()}</small>
                </div>
              );
            })}
            {assets.length === 0 && <div className="asset-empty">没有匹配的素材</div>}
            {hasMore && (
              <button
                type="button"
                className="asset-load-more"
                onClick={() => void loadAssets(true).catch((error) => setMessage(String(error)))}
              >
                加载更多
              </button>
            )}
          </div>
          <aside className="asset-inspector">
            {selected ? (
              <>
                <div className="asset-inspector-preview">
                  {selected.kind.includes('video') ? (
                    mediaSourceById[selected.id] ? (
                      <video
                        src={mediaSrcFor(selected.id, mediaSourceById[selected.id]!.path)}
                        controls
                        preload="metadata"
                      />
                    ) : (
                      <Video size={32} />
                    )
                  ) : mediaSourceById[selected.id] ? (
                    <img
                      src={mediaSrcFor(selected.id, mediaSourceById[selected.id]!.path)}
                      alt={displayName(selected)}
                    />
                  ) : (
                    <Image size={32} />
                  )}
                </div>
                <label>
                  别名
                  <input
                    key={`${selected.id}-${selected.alias}`}
                    defaultValue={selected.alias}
                    maxLength={120}
                    disabled={!writable || showTrash}
                    onBlur={(event) => {
                      if (event.target.value.trim() !== (selected.alias ?? ''))
                        void callWorker('asset.alias.update', {
                          assetId: selected.id,
                          alias: event.target.value,
                        })
                          .then(reloadCurrent)
                          .catch((error) => setMessage(String(error)));
                    }}
                  />
                </label>
                {!showTrash && (
                  <fieldset className="asset-tag-editor">
                    <legend>
                      <span>标签</span>
                      <button
                        type="button"
                        className="icon-button"
                        title="管理标签"
                        onClick={() => setTagManagerOpen(true)}
                      >
                        <Pencil size={13} />
                      </button>
                    </legend>
                    {tags.map((tag) => (
                      <label key={tag.id}>
                        <input
                          type="checkbox"
                          disabled={!writable}
                          checked={selected.tags?.some((item) => item.id === tag.id) ?? false}
                          onChange={() => {
                            const tagIds = selected.tags?.map((item) => item.id) ?? [];
                            const next = tagIds.includes(tag.id)
                              ? tagIds.filter((id) => id !== tag.id)
                              : [...tagIds, tag.id];
                            void callWorker('asset.tags.replace', {
                              assetIds: [selected.id],
                              tagIds: next,
                            })
                              .then(reloadCurrent)
                              .catch((error) => setMessage(String(error)));
                          }}
                        />
                        {tag.name}
                      </label>
                    ))}
                  </fieldset>
                )}
                <dl>
                  <dt>类型</dt>
                  <dd>{selected.kind}</dd>
                  <dt>大小</dt>
                  <dd>{(selected.sizeBytes / 1024).toFixed(1)} KiB</dd>
                  <dt>创建</dt>
                  <dd>{new Date(selected.createdAt).toLocaleString()}</dd>
                  <dt>路径</dt>
                  <dd>{selected.relativePath}</dd>
                </dl>
                <div className="asset-inspector-actions">
                  <button
                    type="button"
                    onClick={() => void callWorker('asset.reveal', { assetId: selected.id })}
                  >
                    <FolderOpen size={15} />
                    打开位置
                  </button>
                  {!showTrash && (
                    <button
                      type="button"
                      onClick={() =>
                        void callWorker('asset.source.locate', { assetId: selected.id })
                          .then((source) => onOpenSource?.(source))
                          .catch((error) => setMessage(String(error)))
                      }
                    >
                      <ExternalLink size={15} />
                      来源任务
                    </button>
                  )}
                  {showTrash ? (
                    <>
                      <button
                        type="button"
                        disabled={!writable}
                        onClick={() =>
                          void callWorker('asset.restore', { assetId: selected.id })
                            .then(reloadCurrent)
                            .catch((error) => setMessage(String(error)))
                        }
                      >
                        <RotateCcw size={15} />
                        恢复
                      </button>
                      <button
                        type="button"
                        className="danger"
                        disabled={!writable}
                        onClick={() => {
                          if (window.confirm('彻底删除后无法恢复，确认继续？'))
                            void callWorker('asset.purge', {
                              assetId: selected.id,
                              confirm: true,
                            })
                              .then(reloadCurrent)
                              .catch((error) => setMessage(String(error)));
                        }}
                      >
                        <Trash2 size={15} />
                        彻底删除
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={!writable}
                      onClick={() =>
                        void deleteAsset(selected).catch((error) => setMessage(String(error)))
                      }
                    >
                      <Trash2 size={15} />
                      移到回收站
                    </button>
                  )}
                </div>
              </>
            ) : (
              <div className="asset-empty">选择素材查看详情</div>
            )}
          </aside>
        </div>
        {message && (
          <div className="inline-status" role="status">
            {message}
          </div>
        )}
      </section>
    </div>
  );
}
