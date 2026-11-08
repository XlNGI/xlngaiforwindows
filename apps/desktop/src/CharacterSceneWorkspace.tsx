import { RotateCcw } from 'lucide-react';
import type { SceneReferenceImageOptions } from '@ai-video/contracts';
import type { AssetInfo, DocumentKind } from '@ai-video/contracts';
import { AssetImagePreview } from './AssetImagePreview';
import { VoiceReferencePanel } from './dubbing/VoiceReferencePanel';
import { MarkdownEditor } from './MarkdownEditor';

export function CharacterSceneWorkspace({
  projectId,
  documentId,
  kind,
  content,
  writable,
  versions,
  currentVersionId,
  message,
  assets,
  sceneReference = {},
  onContentChange,
  onRestoreVersion,
  onSceneReferenceChange,
  onOpenAsset,
  boundScenes = [],
  onOpenScene,
}: {
  projectId?: string;
  documentId?: string;
  title: string;
  kind: DocumentKind;
  content: string;
  writable: boolean;
  versions: Array<{ id: string; version: number; createdAt: string }>;
  currentVersionId?: string;
  message?: string;
  assets: AssetInfo[];
  sceneReference?: SceneReferenceImageOptions;
  onContentChange: (value: string) => void;
  onRestoreVersion: (versionId: string) => void;
  onSceneReferenceChange?: (sceneReference: SceneReferenceImageOptions) => void;
  onOpenAsset?: (assetId: string) => void;
  boundScenes?: Array<{ id: string; title: string }>;
  onOpenScene?: (sceneId: string) => void;
}) {
  return (
    <div
      className={`character-scene-workspace${kind === 'character' && projectId && documentId ? ' has-voice-profile' : ''}`}
    >
      <section className="character-scene-prompt">
        {kind === 'scene' ? (
          <div className="scene-reference-settings" aria-label="场景参考出图设置">
            <label className="title-field">
              一致性参考图
              <select
                aria-label="场景一致性参考图"
                value={sceneReference.referenceAssetId ?? ''}
                disabled={!writable}
                onChange={(event) =>
                  onSceneReferenceChange?.({
                    referenceAssetId: event.target.value || undefined,
                  })
                }
              >
                <option value="">暂不使用参考图</option>
                {assets.map((asset, index) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.alias || `场景图片 ${index + 1}`}
                  </option>
                ))}
              </select>
            </label>
            <p className="workspace-hint">可选一张已有场景图作为布局与风格参考。</p>
          </div>
        ) : null}
        <MarkdownEditor
          className="character-scene-prompt-editor"
          label={kind === 'prop' ? '道具资料' : '提示词'}
          value={content}
          onChange={onContentChange}
          autoPreviewOnBlur
          placeholder={
            kind === 'prop'
              ? '输入道具外观、材质、用途与来历…'
              : '\u8f93\u5165\u89d2\u8272\u6216\u573a\u666f\u7684\u751f\u56fe\u63d0\u793a\u8bcd\u2026'
          }
          readOnly={!writable}
        />
        {message ? <div className="inline-status">{message}</div> : null}
      </section>
      {kind !== 'prop' ? (
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
      ) : null}
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
          <VoiceReferencePanel
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
