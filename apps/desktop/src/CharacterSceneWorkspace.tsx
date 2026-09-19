import { convertFileSrc } from '@tauri-apps/api/core';
import { Image as ImageIcon, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { AssetInfo, AssetMediaSourceInfo, DocumentKind } from '@ai-video/contracts';
import { callWorker } from './worker-client';

export function CharacterSceneWorkspace({
  title,
  kind,
  content,
  stateLabel,
  stateKey,
  writable,
  versions,
  currentVersionId,
  message,
  assets,
  onTitleChange,
  onKindChange,
  onContentChange,
  onRestoreVersion,
  onGenerate,
  onOpenAsset,
}: {
  title: string;
  kind: DocumentKind;
  content: string;
  stateLabel: string;
  stateKey: string;
  writable: boolean;
  versions: Array<{ id: string; version: number; createdAt: string }>;
  currentVersionId?: string;
  message?: string;
  assets: AssetInfo[];
  onTitleChange: (value: string) => void;
  onKindChange: (value: DocumentKind) => void;
  onContentChange: (value: string) => void;
  onRestoreVersion: (versionId: string) => void;
  onGenerate: () => void;
  onOpenAsset?: (assetId: string) => void;
}) {
  const [mediaById, setMediaById] = useState<Record<string, AssetMediaSourceInfo>>({});

  useEffect(() => {
    let active = true;
    void Promise.all(
      assets.map(async (asset) => {
        try {
          return [asset.id, await callWorker('asset.mediaSource', { assetId: asset.id })] as const;
        } catch {
          return [asset.id, undefined] as const;
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
  }, [assets]);

  const generateLabel =
    kind === 'scene' ? '\u751f\u6210\u573a\u666f\u56fe' : '\u751f\u6210\u89d2\u8272\u56fe';

  return (
    <div className="character-scene-workspace">
      <section className="character-scene-prompt" aria-labelledby="character-scene-prompt-heading">
        <div className="character-scene-prompt-heading">
          <h2 id="character-scene-prompt-heading">{'\u63d0\u793a\u8bcd'}</h2>
          <p>
            {
              '\u7528\u4e8e\u751f\u6210\u53ef\u590d\u7528\u7684\u89d2\u8272\u6216\u573a\u666f\u56fe\u7247\uff0c\u4e0d\u4f1a\u76f4\u63a5\u62ff\u53bb\u6587\u751f\u89c6\u9891\u3002'
            }
          </p>
        </div>
        <div className="character-scene-identity">
          <label className="title-field">
            {'\u6807\u9898'}
            <input
              value={title}
              onChange={(event) => onTitleChange(event.target.value)}
              placeholder={'\u8f93\u5165\u89d2\u8272\u6216\u573a\u666f\u540d\u79f0'}
              readOnly={!writable}
            />
          </label>
          <label className="kind-field">
            {'\u7c7b\u578b'}
            <select
              value={kind === 'scene' ? 'scene' : 'character'}
              onChange={(event) => onKindChange(event.target.value as DocumentKind)}
              disabled={!writable}
              aria-label={'\u6587\u6863\u7c7b\u578b'}
            >
              <option value="character">{'\u89d2\u8272'}</option>
              <option value="scene">{'\u573a\u666f'}</option>
            </select>
          </label>
          <span className={`document-state document-state-${stateKey}`}>{stateLabel}</span>
          <button
            className="button primary"
            type="button"
            disabled={!writable || !content.trim() || !title.trim()}
            onClick={onGenerate}
          >
            {generateLabel}
          </button>
        </div>
        <textarea
          className="markdown-editor character-scene-prompt-editor"
          aria-label={'\u63d0\u793a\u8bcd'}
          value={content}
          onChange={(event) => onContentChange(event.target.value)}
          placeholder={
            '\u8f93\u5165\u89d2\u8272\u6216\u573a\u666f\u7684\u751f\u56fe\u63d0\u793a\u8bcd\u2026'
          }
          readOnly={!writable}
        />
        {message ? <div className="inline-status">{message}</div> : null}
        {versions.length > 0 ? (
          <div className="version-strip">
            <span>{'\u5386\u53f2\u7248\u672c'}</span>
            {versions.map((version) => (
              <button
                type="button"
                key={version.id}
                title={new Date(version.createdAt).toLocaleString()}
                onClick={() => onRestoreVersion(version.id)}
                disabled={!writable || version.id === currentVersionId}
              >
                <RotateCcw size={12} />v{version.version}
              </button>
            ))}
          </div>
        ) : null}
      </section>
      <section
        className={`character-scene-gallery${assets.length === 0 ? ' is-empty' : ''}`}
        aria-labelledby="character-scene-gallery-heading"
      >
        <h2 id="character-scene-gallery-heading">{'\u5df2\u751f\u6210\u56fe\u7247'}</h2>
        {assets.length === 0 ? (
          <p className="character-scene-gallery-empty">
            {
              '\u8fd8\u6ca1\u6709\u8fd9\u4e2a\u5bf9\u8c61\u7684\u56fe\u7247\u3002\u7528\u4e0a\u9762\u7684\u63d0\u793a\u8bcd\u751f\u6210\u540e\uff0c\u4f1a\u6302\u56de\u8fd9\u4e00\u9875\u3002'
            }
          </p>
        ) : (
          <ul className="character-scene-gallery-grid">
            {assets.map((asset) => {
              const source = mediaById[asset.id];
              const src = source ? mediaSrcFor(asset.id, source.path) : undefined;
              const name =
                asset.alias?.trim() || asset.relativePath.split(/[\\/]/).pop() || asset.id;
              return (
                <li key={asset.id}>
                  <button type="button" onClick={() => onOpenAsset?.(asset.id)} title={name}>
                    {src ? (
                      <img src={src} alt={name} />
                    ) : (
                      <span className="character-scene-gallery-fallback">
                        <ImageIcon size={22} />
                        {name}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function mediaSrcFor(assetId: string, absolutePath: string): string | undefined {
  if (!('__TAURI_INTERNALS__' in window)) return `/worker-media/${encodeURIComponent(assetId)}`;
  try {
    return convertFileSrc(absolutePath);
  } catch {
    return undefined;
  }
}
