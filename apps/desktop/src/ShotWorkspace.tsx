import { convertFileSrc } from '@tauri-apps/api/core';
import { Image as ImageIcon, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { AssetInfo, AssetMediaSourceInfo, DocumentSummary } from '@ai-video/contracts';
import { callWorker } from './worker-client';

const DRAG_MIME = 'application/x-ai-video-asset+json';
const STORAGE_PREFIX = 'ai-video.shot-reference-assets:';

export type ShotReferenceSlot = 'character' | 'scene' | 'firstFrame';

export interface ShotReferenceAssets {
  characterAssetId?: string;
  sceneAssetId?: string;
  firstFrameAssetId?: string;
}

export function loadShotReferences(projectId: string, shotId: string): ShotReferenceAssets {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + projectId);
    const parsed = raw ? (JSON.parse(raw) as Record<string, ShotReferenceAssets>) : {};
    return parsed[shotId] ?? {};
  } catch {
    return {};
  }
}

export function saveShotReferences(
  projectId: string,
  shotId: string,
  refs: ShotReferenceAssets,
): void {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + projectId);
    const parsed = raw ? (JSON.parse(raw) as Record<string, ShotReferenceAssets>) : {};
    parsed[shotId] = refs;
    window.localStorage.setItem(STORAGE_PREFIX + projectId, JSON.stringify(parsed));
  } catch {
    // Storage can be unavailable in restricted webviews.
  }
}

export function mentionedTitle(prompt: string, kind: 'character' | 'scene'): string | undefined {
  const pattern = kind === 'character' ? /\[角色:([^\]]+)\]/ : /\[场景:([^\]]+)\]/;
  const match = prompt.match(pattern);
  const title = match?.[1]?.trim();
  return title || undefined;
}

function assetName(asset: AssetInfo): string {
  return asset.alias?.trim() || asset.relativePath.split(/[\\/]/).pop() || asset.id;
}

function mediaSrcFor(assetId: string, absolutePath: string): string | undefined {
  if (!('__TAURI_INTERNALS__' in window)) return `/worker-media/${encodeURIComponent(assetId)}`;
  try {
    return convertFileSrc(absolutePath);
  } catch {
    return undefined;
  }
}

function isVideoKind(kind: string): boolean {
  return kind.includes('video');
}

export function ShotWorkspace({
  projectId,
  shotId,
  shotTitle,
  shotStatus,
  shotPosition,
  prompt,
  writable,
  assets,
  documents,
  storyboardTitle,
  storyboardContent,
  storyboardBusy,
  hasStoryboard,
  onPromptChange,
  onSavePrompt,
  onGenerateImage,
  onGenerateVideo,
  onStoryboardTitleChange,
  onStoryboardContentChange,
  onSaveStoryboard,
}: {
  projectId?: string;
  shotId: string;
  shotTitle: string;
  shotStatus: string;
  shotPosition: number;
  prompt: string;
  writable: boolean;
  assets: AssetInfo[];
  documents: DocumentSummary[];
  storyboardTitle: string;
  storyboardContent: string;
  storyboardBusy: boolean;
  hasStoryboard: boolean;
  onPromptChange: (value: string) => void;
  onSavePrompt: () => void;
  onGenerateImage: (refs: ShotReferenceAssets) => void;
  onGenerateVideo: (refs: ShotReferenceAssets) => void;
  onStoryboardTitleChange: (value: string) => void;
  onStoryboardContentChange: (value: string) => void;
  onSaveStoryboard: () => void;
}) {
  const [refs, setRefs] = useState<ShotReferenceAssets>(() =>
    projectId ? loadShotReferences(projectId, shotId) : {},
  );
  const [mediaById, setMediaById] = useState<Record<string, AssetMediaSourceInfo>>({});

  useEffect(() => {
    setRefs(projectId ? loadShotReferences(projectId, shotId) : {});
  }, [projectId, shotId]);

  const persist = (next: ShotReferenceAssets) => {
    setRefs(next);
    if (projectId) saveShotReferences(projectId, shotId, next);
  };

  const selectedAssets = useMemo(
    () =>
      [refs.characterAssetId, refs.sceneAssetId, refs.firstFrameAssetId]
        .map((id) => assets.find((item) => item.id === id))
        .filter((item): item is AssetInfo => Boolean(item)),
    [assets, refs],
  );

  useEffect(() => {
    let active = true;
    const ids = selectedAssets.map((item) => item.id);
    if (ids.length === 0) {
      setMediaById({});
      return () => undefined;
    }
    void Promise.all(
      ids.map(async (id) => {
        try {
          return [id, await callWorker('asset.mediaSource', { assetId: id })] as const;
        } catch {
          return [id, undefined] as const;
        }
      }),
    ).then((entries) => {
      if (!active) return;
      const next: Record<string, AssetMediaSourceInfo> = {};
      for (const [id, source] of entries) {
        if (source) next[id] = source;
      }
      setMediaById(next);
    });
    return () => {
      active = false;
    };
  }, [selectedAssets]);

  const assign = (slot: ShotReferenceSlot, assetId?: string) => {
    persist({
      ...refs,
      characterAssetId: slot === 'character' ? assetId : refs.characterAssetId,
      sceneAssetId: slot === 'scene' ? assetId : refs.sceneAssetId,
      firstFrameAssetId: slot === 'firstFrame' ? assetId : refs.firstFrameAssetId,
    });
  };

  const resolveMentions = async (): Promise<ShotReferenceAssets> => {
    let next = { ...refs };
    const characterTitle = mentionedTitle(prompt, 'character');
    const sceneTitle = mentionedTitle(prompt, 'scene');
    if (characterTitle && !next.characterAssetId) {
      const document = documents.find(
        (item) => item.kind === 'character' && item.title.includes(characterTitle),
      );
      if (document) {
        const items = await callWorker('asset.list', {
          sourceDocumentId: document.id,
          sort: 'created-desc',
          limit: 1,
        });
        if (items[0]) next = { ...next, characterAssetId: items[0].id };
      }
    }
    if (sceneTitle && !next.sceneAssetId) {
      const document = documents.find(
        (item) => item.kind === 'scene' && item.title.includes(sceneTitle),
      );
      if (document) {
        const items = await callWorker('asset.list', {
          sourceDocumentId: document.id,
          sort: 'created-desc',
          limit: 1,
        });
        if (items[0]) next = { ...next, sceneAssetId: items[0].id };
      }
    }
    persist(next);
    return next;
  };

  const hasSelectedRefs = Boolean(
    refs.characterAssetId || refs.sceneAssetId || refs.firstFrameAssetId,
  );
  const hasMentionedRefs = Boolean(
    mentionedTitle(prompt, 'character') || mentionedTitle(prompt, 'scene'),
  );

  return (
    <div className="shot-workspace">
      <section className="shot-prompt-panel" aria-labelledby="shot-prompt-heading">
        <div className="shot-prompt-heading">
          <div>
            <h2 id="shot-prompt-heading">{'\u955c\u5934\u63d0\u793a\u8bcd'}</h2>
            <p>
              {
                '\u53ea\u7528\u4e8e\u751f\u6210\u672c\u955c\u753b\u9762\u6216\u9996\u5e27\u3002\u89d2\u8272\u548c\u573a\u666f\u8bf7\u7528\u4e0b\u65b9\u53c2\u8003\u56fe\uff0c\u4e0d\u8981\u628a\u8bbe\u5b9a\u6b63\u6587\u62fc\u8fdb\u89c6\u9891\u63d0\u793a\u8bcd\u3002'
              }
            </p>
          </div>
          <span className="shot-status">
            {`${shotTitle} · ${shotStatus} · #${shotPosition + 1}`}
          </span>
        </div>
        <textarea
          className="markdown-editor shot-prompt-editor"
          aria-label={'\u955c\u5934\u63d0\u793a\u8bcd'}
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
          placeholder={'\u8f93\u5165\u672c\u955c\u753b\u9762\u63d0\u793a\u8bcd\u2026'}
          readOnly={!writable}
        />
        <div className="shot-prompt-actions">
          <button
            className="button secondary"
            type="button"
            disabled={!writable}
            onClick={onSavePrompt}
          >
            <Save size={13} /> {'\u4fdd\u5b58\u63d0\u793a\u8bcd'}
          </button>
          <button
            className="button primary"
            type="button"
            disabled={!writable || !prompt.trim()}
            onClick={() => {
              void resolveMentions().then((resolved) => onGenerateImage(resolved));
            }}
          >
            {'\u751f\u6210\u672c\u955c\u753b\u9762'}
          </button>
          <button
            className="button secondary"
            type="button"
            disabled={!writable || (!hasSelectedRefs && !hasMentionedRefs)}
            onClick={() => {
              void resolveMentions().then((resolved) => onGenerateVideo(resolved));
            }}
          >
            {'\u7528\u53c2\u8003\u56fe\u751f\u6210\u89c6\u9891'}
          </button>
        </div>
      </section>
      <section className="shot-reference-panel" aria-labelledby="shot-reference-heading">
        <h2 id="shot-reference-heading">{'\u53c2\u8003\u56fe'}</h2>
        <p className="shot-reference-hint">
          {
            '\u4ece\u7d20\u6750\u5e93\u62d6\u5165\uff0c\u6216\u5728\u63d0\u793a\u8bcd\u91cc\u5199 [角色:林澈] / [场景:旧码头] \u81ea\u52a8\u586b\u5165\u9ed8\u8ba4\u56fe\u3002'
          }
        </p>
        <div className="shot-reference-grid">
          <ReferenceSlot
            label={'\u89d2\u8272\u53c2\u8003'}
            asset={assets.find((item) => item.id === refs.characterAssetId)}
            candidates={assets.filter((item) => item.kind === 'character')}
            source={refs.characterAssetId ? mediaById[refs.characterAssetId] : undefined}
            writable={writable}
            projectId={projectId}
            onSelect={(id) => assign('character', id)}
          />
          <ReferenceSlot
            label={'\u573a\u666f\u53c2\u8003'}
            asset={assets.find((item) => item.id === refs.sceneAssetId)}
            candidates={assets.filter((item) => item.kind === 'scene')}
            source={refs.sceneAssetId ? mediaById[refs.sceneAssetId] : undefined}
            writable={writable}
            projectId={projectId}
            onSelect={(id) => assign('scene', id)}
          />
          <ReferenceSlot
            label={'\u9996\u5e27'}
            asset={assets.find((item) => item.id === refs.firstFrameAssetId)}
            candidates={assets.filter(
              (item) => item.kind === 'first-frame' || item.kind === 'generated-image',
            )}
            source={refs.firstFrameAssetId ? mediaById[refs.firstFrameAssetId] : undefined}
            writable={writable}
            projectId={projectId}
            onSelect={(id) => assign('firstFrame', id)}
          />
        </div>
      </section>
      <section className="shot-notes-panel" aria-labelledby="shot-notes-heading">
        <h2 id="shot-notes-heading">{'\u5206\u955c\u8bf4\u660e'}</h2>
        <p>
          {
            '\u53ef\u9009\u957f\u6587\uff0c\u53ea\u7559\u7ed9\u4eba\u770b\uff0c\u4e0d\u4f1a\u53d1\u7ed9\u751f\u56fe\u6216\u751f\u89c6\u9891\u5382\u5546\u3002'
          }
        </p>
        <label className="title-field">
          {'\u5206\u955c\u6807\u9898'}
          <input
            value={storyboardTitle}
            onChange={(event) => onStoryboardTitleChange(event.target.value)}
            placeholder={'\u8f93\u5165\u5206\u955c\u6807\u9898'}
            readOnly={!writable || storyboardBusy}
          />
        </label>
        <textarea
          className="markdown-editor"
          aria-label={'\u5206\u955c\u5185\u5bb9'}
          value={storyboardContent}
          onChange={(event) => onStoryboardContentChange(event.target.value)}
          placeholder={'# \u5206\u955c\n\n1. \u955c\u5934\u63cf\u8ff0\u2026'}
          readOnly={!writable || storyboardBusy}
        />
        <div className="toolbar-actions">
          <button
            className="button primary"
            type="button"
            disabled={!writable || storyboardBusy}
            onClick={onSaveStoryboard}
          >
            <Save size={13} />
            {hasStoryboard ? '\u4fdd\u5b58\u5206\u955c' : '\u65b0\u5efa\u5206\u955c'}
          </button>
          {storyboardBusy ? (
            <span className="inline-status">{'\u4fdd\u5b58\u4e2d\u2026'}</span>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function ReferenceSlot({
  label,
  asset,
  candidates,
  source,
  writable,
  projectId,
  onSelect,
}: {
  label: string;
  asset?: AssetInfo;
  candidates: AssetInfo[];
  source?: AssetMediaSourceInfo;
  writable: boolean;
  projectId?: string;
  onSelect: (assetId?: string) => void;
}) {
  const src = asset && source ? mediaSrcFor(asset.id, source.path) : undefined;
  const acceptDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!writable) return;
    try {
      const raw = event.dataTransfer.getData(DRAG_MIME) || event.dataTransfer.getData('text/plain');
      const payload = JSON.parse(raw) as {
        version?: number;
        projectId?: string;
        assets?: Array<{ id: string; kind: string }>;
      };
      if (payload.version !== 1 || !payload.assets?.[0]) throw new Error('invalid');
      if (projectId && payload.projectId && payload.projectId !== projectId) return;
      if (isVideoKind(payload.assets[0].kind)) return;
      onSelect(payload.assets[0].id);
    } catch {
      // Ignore malformed drag payloads.
    }
  };

  return (
    <div
      className={`shot-reference-slot ${asset ? 'has-asset' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={acceptDrop}
    >
      <strong>{label}</strong>
      {src ? (
        <img src={src} alt={asset ? assetName(asset) : label} />
      ) : (
        <span className="shot-reference-empty">
          <ImageIcon size={18} />
          {asset ? assetName(asset) : '\u62d6\u5165\u6216\u4e0b\u62c9\u9009\u62e9'}
        </span>
      )}
      <select
        aria-label={label}
        value={asset?.id ?? ''}
        disabled={!writable}
        onChange={(event) => onSelect(event.target.value || undefined)}
      >
        <option value="">{'\u672a\u9009\u62e9'}</option>
        {(asset && !candidates.some((item) => item.id === asset.id)
          ? [asset, ...candidates]
          : candidates
        ).map((item) => (
          <option key={item.id} value={item.id}>
            {assetName(item)}
          </option>
        ))}
      </select>
      {asset ? (
        <button
          type="button"
          className="button secondary"
          disabled={!writable}
          onClick={() => onSelect(undefined)}
        >
          {'\u6e05\u9664'}
        </button>
      ) : null}
    </div>
  );
}
