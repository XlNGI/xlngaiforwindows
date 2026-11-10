import { RotateCcw, Volume2 } from 'lucide-react';
import type { SceneReferenceImageOptions } from '@ai-video/contracts';
import type { AssetInfo, DocumentKind } from '@ai-video/contracts';
import { AssetImagePreview } from './AssetImagePreview';
import { VoiceReferencePanel } from './dubbing/VoiceReferencePanel';
import { MarkdownEditor } from './MarkdownEditor';
import type { useCharacterVoicePrompt } from './use-character-voice-prompt';

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
  sampleText = '',
  onSampleTextChange,
  defaultVoiceId,
  voiceDocuments = [],
  onDefaultVoiceChange,
  voicePrompt,
  onGenerateVoice,
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
  sampleText?: string;
  onSampleTextChange?: (text: string) => void;
  defaultVoiceId?: string;
  voiceDocuments?: Array<{ id: string; title: string }>;
  onDefaultVoiceChange?: (id: string | undefined) => void;
  voicePrompt?: ReturnType<typeof useCharacterVoicePrompt>;
  onGenerateVoice?: () => void;
}) {
  const voiceGenerationDisabledReason = !writable
    ? '当前角色只读'
    : !projectId || !documentId
      ? '请先保存角色'
      : voicePrompt?.loading
        ? '正在加载音色提示词'
        : !voicePrompt?.document || voicePrompt.error
          ? '请先选择可用的音色提示词'
          : !voicePrompt.content.trim() || !voicePrompt.sampleText.trim()
            ? '请填写音色描述和试音文本'
            : !onGenerateVoice
              ? '音色生成暂不可用'
              : undefined;
  return (
    <div
      className={`character-scene-workspace${kind === 'character' && projectId && documentId ? ' has-voice-profile' : ''}`}
    >
      <section className="character-scene-prompt">
        {kind === 'character' ? (
          <div className="workspace-section-heading">
            <h2>角色提示词</h2>
          </div>
        ) : null}
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
          label={kind === 'voice' ? '音色描述' : kind === 'prop' ? '道具资料' : '提示词'}
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
        {kind === 'voice' ? (
          <MarkdownEditor
            label="试音文本"
            value={sampleText}
            onChange={(value) => onSampleTextChange?.(value)}
            readOnly={!writable}
            placeholder="输入用于试音的台词…"
          />
        ) : null}
        {message ? <div className="inline-status">{message}</div> : null}
      </section>
      {kind === 'character' ? (
        <section className="character-voice-prompt" aria-label="角色音色提示词">
          <div className="workspace-section-heading">
            <h2>音色提示词</h2>
            <button
              type="button"
              className="button primary"
              onClick={onGenerateVoice}
              disabled={Boolean(voiceGenerationDisabledReason)}
              title={voiceGenerationDisabledReason ?? '使用当前角色的音色提示词生成声音'}
            >
              <Volume2 size={14} aria-hidden="true" />
              生成音色
            </button>
          </div>
          <label className="title-field">
            默认音色样本
            <select
              aria-label="默认音色样本"
              value={defaultVoiceId ?? ''}
              disabled={!writable || voicePrompt?.dirty || voicePrompt?.loading}
              onChange={(event) => onDefaultVoiceChange?.(event.target.value || undefined)}
            >
              <option value="">未指定</option>
              {voiceDocuments.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.title}
                </option>
              ))}
            </select>
          </label>
          {defaultVoiceId ? (
            voicePrompt?.loading ? (
              <p className="workspace-hint" role="status">
                正在加载音色提示词…
              </p>
            ) : voicePrompt?.error ? (
              <>
                <p className="inline-status" role="alert">
                  {voicePrompt.error}
                </p>
                <button type="button" className="button secondary" onClick={voicePrompt.retry}>
                  重新加载音色提示词
                </button>
              </>
            ) : voicePrompt?.document ? (
              <>
                <MarkdownEditor
                  className="character-voice-description-editor"
                  label="音色描述"
                  value={voicePrompt.content}
                  onChange={voicePrompt.setContent}
                  autoPreviewOnBlur
                  readOnly={!writable || !voicePrompt.writable}
                  placeholder="输入角色的音色、语速与说话风格…"
                />
                <MarkdownEditor
                  className="character-voice-sample-editor"
                  label="试音文本"
                  value={voicePrompt.sampleText}
                  onChange={voicePrompt.setSampleText}
                  autoPreviewOnBlur
                  readOnly={!writable || !voicePrompt.writable}
                  placeholder="输入用于试音的台词…"
                />
                {voicePrompt.document.publishedVersionId ? (
                  <p className="workspace-hint">该音色提示词已发布，当前只读。</p>
                ) : null}
              </>
            ) : null
          ) : (
            <p className="workspace-hint">选择音色样本后，可在这里编辑音色描述和试音文本。</p>
          )}
        </section>
      ) : null}
      {kind !== 'prop' && kind !== 'voice' ? (
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
      {kind !== 'voice' ? (
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
      ) : null}
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
