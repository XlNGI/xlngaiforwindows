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
  SlidersHorizontal,
  Tags,
  Trash2,
  Archive,
  CheckSquare,
  Square,
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
import { ImagePreview } from '../ImagePreview';

type MediaFilter = 'all' | 'image' | 'video';
const PAGE_SIZE = 60;
const DRAG_MIME = 'application/x-ai-video-asset+json';

interface AssetLibraryViewProps {
  writable: boolean;
  selectedAssetId?: string;
  selectedAssetRevision?: number;
  openTrashRequest?: number;
  taskCompletionRevision?: number;
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

function normalizeTagName(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

export function AssetLibraryView({
  writable,
  selectedAssetId,
  selectedAssetRevision = 0,
  openTrashRequest = 0,
  taskCompletionRevision = 0,
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
  const [tagDraft, setTagDraft] = useState('');
  const [groupEditor, setGroupEditor] = useState<Partial<AssetGroupInfo>>();
  const [groupDropActive, setGroupDropActive] = useState(false);
  const [pointerDraggingIds, setPointerDraggingIds] = useState<string[]>([]);
  const [bulkTagId, setBulkTagId] = useState('');
  const selectionAnchor = useRef<string | undefined>(undefined);
  const groupMembersRef = useRef<HTMLFieldSetElement>(null);
  const pointerDragRef = useRef<
    | {
        pointerId: number;
        assetIds: string[];
        startX: number;
        startY: number;
        active: boolean;
      }
    | undefined
  >(undefined);
  const suppressCardClickRef = useRef(false);
  const tagCommitRef = useRef(false);
  const [aliasSavedId, setAliasSavedId] = useState<string | null>(null);

  const kind = mediaFilter === 'all' ? undefined : mediaFilter;
  const selected = assets.find((asset) => asset.id === selectedIds.at(-1));

  useEffect(() => {
    setTagDraft('');
  }, [selected?.id]);

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
      if (selectedGroupId) {
        const grouped = await callWorker('assetGroup.resolve', { groupId: selectedGroupId });
        const from = createdFrom ? new Date(`${createdFrom}T00:00:00`).toISOString() : undefined;
        const to = createdTo ? new Date(`${createdTo}T23:59:59.999`).toISOString() : undefined;
        const filtered = grouped
          .filter((asset) => {
            if (kind && !asset.kind.includes(kind)) return false;
            if (from && asset.createdAt < from) return false;
            if (to && asset.createdAt > to) return false;
            if (
              keyword &&
              !`${displayName(asset)} ${asset.relativePath} ${(asset.tags ?? []).map((tag) => tag.name).join(' ')}`
                .toLocaleLowerCase()
                .includes(keyword.toLocaleLowerCase())
            )
              return false;
            return true;
          })
          .sort((a, b) => {
            const direction = sort === 'created-asc' ? 1 : -1;
            return direction * (a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
          });
        setAssets(filtered);
        setHasMore(false);
        if (!append)
          setSelectedIds((current) =>
            current.length && filtered.some((asset) => asset.id === current.at(-1))
              ? current
              : filtered[0]
                ? [filtered[0].id]
                : [],
          );
        return;
      }
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
    [assets, createdFrom, createdTo, keyword, kind, selectedGroupId, showTrash, sort, tagFilter],
  );

  useEffect(() => {
    if (!selectedAssetId) return;
    setSelectedIds([selectedAssetId]);
    setMediaFilter('all');
    setShowTrash(false);
    setKeyword('');
    setCreatedFrom('');
    setCreatedTo('');
    setTagFilter([]);
    setSelectedGroupId('');
  }, [selectedAssetId, selectedAssetRevision]);

  useEffect(() => {
    if (openTrashRequest > 0) setShowTrash(true);
  }, [openTrashRequest]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setMessage('');
      const action = Promise.all([loadAssets(), loadTags(), loadGroups()]).then(() => undefined);
      void action.catch((error) => setMessage(String(error)));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    mediaFilter,
    showTrash,
    keyword,
    createdFrom,
    createdTo,
    sort,
    tagFilter.join(','),
    selectedGroupId,
    selectedAssetRevision,
    taskCompletionRevision,
  ]);

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
    const serialized = JSON.stringify(payload);
    event.dataTransfer.setData('text/plain', serialized);
    try {
      event.dataTransfer.setData(DRAG_MIME, serialized);
    } catch {
      // Some Windows WebView versions only allow standard drag data types.
    }
    event.dataTransfer.effectAllowed = 'copy';
  };

  const pointInGroupMembers = (clientX: number, clientY: number) => {
    const rect = groupMembersRef.current?.getBoundingClientRect();
    return Boolean(
      rect &&
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom,
    );
  };

  const resetPointerDrag = () => {
    pointerDragRef.current = undefined;
    setPointerDraggingIds([]);
    setGroupDropActive(false);
  };

  const beginPointerGroupDrag = (event: React.PointerEvent<HTMLDivElement>, items: AssetInfo[]) => {
    if (!groupEditor || event.button !== 0) return;
    if ((event.target as Element).closest('button, input, select, textarea, video')) return;
    pointerDragRef.current = {
      pointerId: event.pointerId,
      assetIds: items.map((item) => item.id),
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const updatePointerGroupDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (!drag.active && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) >= 6) {
      drag.active = true;
      setPointerDraggingIds(drag.assetIds);
    }
    if (!drag.active) return;
    event.preventDefault();
    setGroupDropActive(pointInGroupMembers(event.clientX, event.clientY));
  };

  const finishPointerGroupDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = pointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.active) {
      suppressCardClickRef.current = true;
      if (pointInGroupMembers(event.clientX, event.clientY)) {
        setGroupEditor((current) =>
          current
            ? {
                ...current,
                assetIds: [...new Set([...(current.assetIds ?? []), ...drag.assetIds])],
              }
            : current,
        );
      }
      event.preventDefault();
    }
    resetPointerDrag();
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

  const batchDeleteSelected = async () => {
    if (!selectedAssets.length) return;
    if (!window.confirm(`确定将选中的 ${selectedAssets.length} 项素材移到回收站吗？`)) return;
    try {
      for (const asset of selectedAssets) {
        await callWorker('asset.delete', { assetId: asset.id });
      }
    } catch (error) {
      if (
        String(error).includes('referenced by') &&
        window.confirm(`${String(error)}\n仍要移到回收站吗？`)
      ) {
        for (const asset of selectedAssets) {
          try {
            await callWorker('asset.delete', { assetId: asset.id, confirm: true });
          } catch {
            /* ignore */
          }
        }
      } else {
        setMessage(String(error));
      }
    }
    await reloadCurrent();
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

  const addTagToSelectedAsset = async () => {
    if (!selected || !writable || showTrash || tagCommitRef.current) return;
    const name = tagDraft.normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (!name) return;
    tagCommitRef.current = true;
    setTagDraft('');
    const normalizedName = normalizeTagName(name);
    try {
      const existing = tags.find((tag) => normalizeTagName(tag.name) === normalizedName);
      const tag = existing ?? (await callWorker('tag.create', { name }));
      const currentTagIds = selected.tags?.map((tag) => tag.id) ?? [];
      if (!currentTagIds.includes(tag.id)) {
        await callWorker('asset.tags.add', {
          assetIds: [selected.id],
          tagIds: [tag.id],
        });
        await reloadCurrent();
      }
    } catch (error) {
      setTagDraft(name);
      throw error;
    } finally {
      tagCommitRef.current = false;
    }
  };

  const saveGroup = async () => {
    const name = groupEditor?.name?.trim();
    const assetIds = groupEditor?.assetIds ?? [];
    if (!name || !assetIds.length) return;
    if (groupEditor?.id)
      await callWorker('assetGroup.update', { groupId: groupEditor.id, name, assetIds });
    else await callWorker('assetGroup.create', { name, assetIds });
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
    <div className="asset-library-shell asset-library-opt-theme">
      <section className="asset-library-main">
        <div className="asset-filter-bar opt-subbar">
          <div className="opt-filter-leading">
            <label className="asset-search opt-search-wrap">
              <Search size={15} />
              <input
                aria-label="搜索"
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="搜索别名、文件名或标签"
              />
            </label>
            <details className="asset-filter-menu asset-manager-menu opt-filter-menu">
              <summary className="opt-compact-btn opt-filter-trigger">
                <SlidersHorizontal size={14} />
                <span>筛选</span>
                {(mediaFilter !== 'all' || selectedGroupId || createdFrom || createdTo) && (
                  <small>已选</small>
                )}
                <ChevronDown size={13} />
              </summary>
              <div className="opt-filter-dropdown">
                <section className="opt-filter-section">
                  <span className="opt-filter-section-label">时间</span>
                  <div className="opt-filter-date-row">
                    <label>
                      <span>起始日期</span>
                      <input
                        aria-label="起始日期"
                        type="date"
                        value={createdFrom}
                        onChange={(event) => setCreatedFrom(event.target.value)}
                      />
                    </label>
                    <label>
                      <span>结束日期</span>
                      <input
                        aria-label="结束日期"
                        type="date"
                        value={createdTo}
                        onChange={(event) => setCreatedTo(event.target.value)}
                      />
                    </label>
                  </div>
                </section>
                <section className="opt-filter-section">
                  <span className="opt-filter-section-label">类型</span>
                  <label className="asset-type-select opt-type-select-accessible">
                    {mediaFilter === 'image' ? (
                      <Image size={14} />
                    ) : mediaFilter === 'video' ? (
                      <Video size={14} />
                    ) : (
                      <Images size={14} />
                    )}
                    <span aria-hidden="true">
                      {mediaFilter === 'image'
                        ? '图片'
                        : mediaFilter === 'video'
                          ? '视频'
                          : '全部素材'}
                    </span>
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
                </section>
                {!showTrash && (
                  <section className="opt-filter-section">
                    <span className="opt-filter-section-label">素材组</span>
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
                          onClick={(event) => {
                            event.currentTarget.closest('details')?.removeAttribute('open');
                            setSelectedGroupId('');
                            setTagFilter([]);
                            setSelectedIds(groupAssets[group.id]?.map((asset) => asset.id) ?? []);
                            setGroupEditor({
                              ...group,
                              assetIds:
                                group.assetIds ??
                                groupAssets[group.id]?.map((asset) => asset.id) ??
                                [],
                            });
                          }}
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
                  </section>
                )}
              </div>
            </details>
            <button
              type="button"
              className="opt-compact-btn opt-create-group-btn"
              disabled={!writable}
              onClick={(event) => {
                event.currentTarget.parentElement
                  ?.querySelector('details')
                  ?.removeAttribute('open');
                setGroupEditor({ name: '', tagIds: [], assetIds: selectedIds });
              }}
            >
              <Plus size={14} />
              <span>新建素材组</span>
            </button>
          </div>

          <div className="opt-filter-trailing">
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
            <span className="asset-result-count" aria-live="polite">
              {assets.length}
              {hasMore ? '+' : ''} 项素材
            </span>
            <button
              type="button"
              className={
                showTrash
                  ? 'opt-compact-btn opt-toolbar-icon-btn opt-danger-active'
                  : 'opt-compact-btn opt-toolbar-icon-btn opt-danger-outline'
              }
              aria-label={showTrash ? '返回素材库' : '打开回收站'}
              title={showTrash ? '返回素材库' : '打开回收站'}
              onClick={() => {
                setShowTrash((current) => !current);
                setSelectedIds([]);
              }}
            >
              {showTrash ? <RotateCcw size={14} /> : <Trash2 size={14} />}
            </button>
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
            {!showTrash && (
              <button
                type="button"
                className="opt-compact-btn opt-selection-toggle-btn opt-icon-only-btn"
                aria-label={
                  selectedIds.length === assets.length && assets.length > 0
                    ? '取消全选'
                    : '全选当前页'
                }
                title={
                  selectedIds.length === assets.length && assets.length > 0
                    ? '取消全选'
                    : '全选当前页'
                }
                onClick={() => {
                  if (selectedIds.length === assets.length && assets.length > 0) {
                    setSelectedIds([]);
                  } else {
                    setSelectedIds(assets.map((a) => a.id));
                  }
                }}
              >
                {selectedIds.length === assets.length && assets.length > 0 ? (
                  <CheckSquare size={13} />
                ) : (
                  <Square size={13} />
                )}
              </button>
            )}
            {!showTrash && selectedIds.length > 1 && (
              <div className="opt-batch-float-bar">
                <span className="asset-selection-count">已选 {selectedIds.length} 项</span>
                {writable && (
                  <details className="opt-batch-menu">
                    <summary className="opt-batch-menu-trigger">
                      <Tags size={13} />
                      批量操作
                      <ChevronDown size={12} />
                    </summary>
                    <div className="asset-bulk-tags opt-batch-menu-dropdown">
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
                      <div className="opt-batch-menu-actions">
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
                        <button
                          type="button"
                          className="danger"
                          onClick={() => void batchDeleteSelected()}
                        >
                          <Trash2 size={13} />
                          移到回收站
                        </button>
                      </div>
                    </div>
                  </details>
                )}
              </div>
            )}
          </div>
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
              <fieldset
                ref={groupMembersRef}
                className={
                  groupDropActive ? 'asset-group-members is-drag-over' : 'asset-group-members'
                }
                onDragEnter={(event) => {
                  event.preventDefault();
                  setGroupDropActive(true);
                }}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                    setGroupDropActive(false);
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'copy';
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setGroupDropActive(false);
                  try {
                    const serialized =
                      event.dataTransfer.getData(DRAG_MIME) ||
                      event.dataTransfer.getData('text/plain');
                    const payload = JSON.parse(serialized) as {
                      assets?: Array<{ id?: string }>;
                    };
                    const dropped = (payload.assets ?? [])
                      .map((asset) => asset.id)
                      .filter((id): id is string => Boolean(id));
                    setGroupEditor({
                      ...groupEditor,
                      assetIds: [...new Set([...(groupEditor.assetIds ?? []), ...dropped])],
                    });
                  } catch {
                    setMessage('无法读取拖入的素材。');
                  }
                }}
              >
                <legend>素材成员</legend>
                <p>将素材拖入此处，或在网格中勾选后点击“添加当前已选”。</p>
                <button
                  type="button"
                  className="button subtle"
                  disabled={!selectedIds.length}
                  onClick={() =>
                    setGroupEditor({
                      ...groupEditor,
                      assetIds: [...new Set([...(groupEditor.assetIds ?? []), ...selectedIds])],
                    })
                  }
                >
                  <Plus size={13} />
                  添加当前已选（{selectedIds.length}）
                </button>
                {assets
                  .filter((asset) => groupEditor.assetIds?.includes(asset.id))
                  .map((asset) => (
                    <label key={asset.id}>
                      <input
                        type="checkbox"
                        checked
                        onChange={() =>
                          setGroupEditor({
                            ...groupEditor,
                            assetIds: groupEditor.assetIds?.filter((id) => id !== asset.id),
                          })
                        }
                      />
                      {displayName(asset)}
                    </label>
                  ))}
              </fieldset>
              <div>
                <button
                  type="submit"
                  className="button primary"
                  disabled={!groupEditor.name?.trim() || !groupEditor.assetIds?.length}
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
            {assets.map((asset, index) => {
              const isSelected = selectedIds.includes(asset.id);
              const dragItems = isSelected && selectedAssets.length > 1 ? selectedAssets : [asset];
              return (
                <div
                  role="option"
                  tabIndex={0}
                  aria-selected={isSelected}
                  aria-label={
                    asset.alias?.trim() ||
                    `${asset.kind.includes('video') ? '视频' : '图片'}素材 ${index + 1}`
                  }
                  draggable={!asset.deletedAt && !groupEditor}
                  onDragStart={(event) =>
                    beginDrag(event, dragItems, dragItems.length > 1 ? 'selection' : 'asset')
                  }
                  key={asset.id}
                  className={`${isSelected ? 'asset-card selected' : 'asset-card'}${groupEditor ? ' group-drag-enabled' : ''}${pointerDraggingIds.includes(asset.id) ? ' is-pointer-dragging' : ''}`}
                  onPointerDown={(event) => beginPointerGroupDrag(event, dragItems)}
                  onPointerMove={updatePointerGroupDrag}
                  onPointerUp={finishPointerGroupDrag}
                  onPointerCancel={resetPointerDrag}
                  onClick={(event) => {
                    if (suppressCardClickRef.current) {
                      suppressCardClickRef.current = false;
                      return;
                    }
                    selectAsset(event, asset);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      selectAsset(event as unknown as React.MouseEvent, asset);
                    }
                  }}
                >
                  <div className="asset-thumb opt-card-thumb">
                    <button
                      type="button"
                      className="asset-card-select-toggle opt-card-check"
                      aria-label={isSelected ? '取消选择' : '选择'}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedIds((curr) =>
                          curr.includes(asset.id)
                            ? curr.filter((id) => id !== asset.id)
                            : [...curr, asset.id],
                        );
                      }}
                    >
                      {isSelected ? <CheckSquare size={13} /> : <Square size={13} />}
                    </button>
                    <span className="asset-card-type-badge opt-type-pill">
                      {asset.kind.includes('video') ? (
                        <Video size={10} style={{ color: '#60a5fa' }} />
                      ) : (
                        <Image size={10} style={{ color: '#34d399' }} />
                      )}
                      {asset.kind.includes('video') ? '视频' : '图片'}
                    </span>
                    {!asset.kind.includes('video') && mediaSourceById[asset.id] ? (
                      <img
                        src={mediaSrcFor(asset.id, mediaSourceById[asset.id]!.path)}
                        alt=""
                        draggable={false}
                      />
                    ) : asset.kind.includes('video') && mediaSourceById[asset.id] ? (
                      <video
                        src={mediaSrcFor(asset.id, mediaSourceById[asset.id]!.path)}
                        controls
                        draggable={false}
                        preload="metadata"
                        onClick={(event) => event.stopPropagation()}
                      />
                    ) : asset.kind.includes('video') ? (
                      <Video size={30} />
                    ) : (
                      <Image size={30} />
                    )}
                  </div>
                  <div className="asset-card-info">
                    {asset.alias?.trim() && (
                      <strong title={asset.alias.trim()} className="opt-card-title">
                        {asset.alias.trim()}
                      </strong>
                    )}
                    {!!asset.tags?.length && (
                      <div className="asset-card-tags opt-card-tags">
                        {asset.tags.slice(0, 2).map((tag) => (
                          <span key={tag.id} className="opt-tag-mini">
                            {tag.name}
                          </span>
                        ))}
                        {asset.tags.length > 2 && (
                          <span className="opt-tag-mini">+{asset.tags.length - 2}</span>
                        )}
                      </div>
                    )}
                    <div className="asset-card-footer opt-card-meta-line">
                      <small>{new Date(asset.createdAt).toLocaleDateString()}</small>
                      <span className="asset-card-size">
                        {(asset.sizeBytes / 1024).toFixed(0)} KB
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
            {assets.length === 0 && (
              <div className="asset-empty" role="status">
                <Archive size={26} aria-hidden="true" />
                <strong>{showTrash ? '回收站为空' : '没有匹配的素材'}</strong>
                <span>
                  {showTrash
                    ? '移入回收站的素材会显示在这里'
                    : '生成图片或视频后，素材会自动出现在这里'}
                </span>
                {(keyword ||
                  mediaFilter !== 'all' ||
                  createdFrom ||
                  createdTo ||
                  tagFilter.length > 0) && (
                  <button type="button" className="button subtle" onClick={clearFilters}>
                    <X size={14} /> 清空筛选
                  </button>
                )}
              </div>
            )}
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
                    <ImagePreview
                      key={selected.id}
                      src={mediaSrcFor(selected.id, mediaSourceById[selected.id]!.path)!}
                      alt={displayName(selected)}
                    />
                  ) : (
                    <Image size={32} />
                  )}
                </div>
                <label>
                  <span className="asset-inspector-label-row">
                    <span>素材别名 (可检索)</span>
                    {aliasSavedId === selected.id && (
                      <span className="asset-save-success opt-save-badge">
                        <Check size={11} /> 已保存
                      </span>
                    )}
                  </span>
                  <input
                    key={`${selected.id}-${selected.alias}`}
                    defaultValue={selected.alias}
                    maxLength={120}
                    disabled={!writable || showTrash}
                    onBlur={(event) => {
                      const nextAlias = event.target.value.trim();
                      if (nextAlias !== (selected.alias ?? '')) {
                        void callWorker('asset.alias.update', {
                          assetId: selected.id,
                          alias: nextAlias,
                        })
                          .then(() => {
                            setAliasSavedId(selected.id);
                            window.setTimeout(
                              () => setAliasSavedId((curr) => (curr === selected.id ? null : curr)),
                              2000,
                            );
                            return reloadCurrent();
                          })
                          .catch((error) => setMessage(String(error)));
                      }
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
                    <input
                      className="asset-tag-input"
                      aria-label="添加标签"
                      placeholder="输入标签并按 Enter"
                      maxLength={120}
                      value={tagDraft}
                      disabled={!writable}
                      onChange={(event) => setTagDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key !== 'Enter') return;
                        event.preventDefault();
                        void addTagToSelectedAsset().catch((error) => setMessage(String(error)));
                      }}
                      onBlur={() =>
                        void addTagToSelectedAsset().catch((error) => setMessage(String(error)))
                      }
                    />
                    <div className="asset-tag-options">
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
                          <span>{tag.name}</span>
                        </label>
                      ))}
                    </div>
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
                    aria-label="打开位置"
                    title="打开位置"
                    onClick={() => void callWorker('asset.reveal', { assetId: selected.id })}
                  >
                    <FolderOpen size={15} />
                  </button>
                  {!showTrash && (
                    <button
                      type="button"
                      aria-label="查看来源任务"
                      title="查看来源任务"
                      onClick={() =>
                        void callWorker('asset.source.locate', { assetId: selected.id })
                          .then((source) => onOpenSource?.(source))
                          .catch((error) => setMessage(String(error)))
                      }
                    >
                      <ExternalLink size={15} />
                    </button>
                  )}
                  {showTrash ? (
                    <>
                      <button
                        type="button"
                        aria-label="恢复素材"
                        title="恢复素材"
                        disabled={!writable}
                        onClick={() =>
                          void callWorker('asset.restore', { assetId: selected.id })
                            .then(reloadCurrent)
                            .catch((error) => setMessage(String(error)))
                        }
                      >
                        <RotateCcw size={15} />
                      </button>
                      <button
                        type="button"
                        className="danger"
                        aria-label="彻底删除"
                        title="彻底删除"
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
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="danger"
                      aria-label="移到回收站"
                      title="移到回收站"
                      disabled={!writable}
                      onClick={() =>
                        void deleteAsset(selected).catch((error) => setMessage(String(error)))
                      }
                    >
                      <Trash2 size={15} />
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
