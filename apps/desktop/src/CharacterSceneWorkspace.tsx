import { RotateCcw } from 'lucide-react';
import type { AssetInfo, DocumentKind } from '@ai-video/contracts';
import { AssetImagePreview } from './AssetImagePreview';
import { VoiceProfilePanel } from './dubbing/VoiceProfilePanel';

export function CharacterSceneWorkspace({
  projectId,
  documentId,
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
  boundScenes = [],
  onOpenScene,
}: {
  projectId?: string;
  documentId?: string;
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
  boundScenes?: Array<{ id: string; title: string }>;
  onOpenScene?: (sceneId: string) => void;
}) {
  const generateLabel =
    kind === 'scene' ? '\u751f\u6210\u573a\u666f\u56fe' : '\u751f\u6210\u89d2\u8272\u56fe';

  return (
    <div
      className={`character-scene-workspace${kind === 'character' && projectId && documentId ? ' has-voice-profile' : ''}`}
    >
      <section className="character-scene-prompt" aria-labelledby="character-scene-prompt-heading">
        <div className="character-scene-prompt-heading">
          <h2 id="character-scene-prompt-heading">
            {kind === 'scene' ? '场景生图提示词' : '角色生图提示词'}
          </h2>
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
      </section>
      <section className="character-scene-bindings" aria-label="场次绑定">
        <div className="workspace-section-heading">
          <h2>场次绑定</h2>
          <span className="workspace-count">{boundScenes.length} 场</span>
        </div>
        {boundScenes.length ? (
          <div className="bound-scene-links">
            {boundScenes.map((scene) => (
              <button
                key={scene.id}
                type="button"
                className="button secondary"
                disabled={!onOpenScene}
                onClick={() => onOpenScene?.(scene.id)}
              >
                {scene.title}
              </button>
            ))}
          </div>
        ) : (
          <p className="workspace-hint">尚未绑定场次，可在“场次与镜头”中关联。</p>
        )}
      </section>
      <section
        className={`character-scene-gallery${assets.length === 0 ? ' is-empty' : ''}`}
        aria-labelledby="character-scene-gallery-heading"
      >
        <div className="workspace-section-heading">
          <h2 id="character-scene-gallery-heading">已生成图片</h2>
          <span className="workspace-count">{assets.length} 张</span>
        </div>
        {assets.length === 0 ? (
          <p className="character-scene-gallery-empty">生成图片后，可绑定到场次和镜头。</p>
        ) : (
          <ul className="character-scene-gallery-grid">
            {assets.map((asset) => (
              <li key={asset.id}>
                <AssetImagePreview asset={asset} />
                {onOpenAsset ? (
                  <button
                    className="image-library-link"
                    type="button"
                    onClick={() => onOpenAsset(asset.id)}
                  >
                    查看素材
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      {kind === 'character' && projectId && documentId ? (
        <details className="workspace-extra">
          <summary>角色声音</summary>
          <VoiceProfilePanel
            projectId={projectId}
            characterDocumentId={documentId}
            writable={writable}
          />
        </details>
      ) : null}
      {versions.length > 0 ? (
        <details className="workspace-extra">
          <summary>历史版本 · {versions.length}</summary>
          <div className="version-strip">
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
        </details>
      ) : null}
    </div>
  );
}
