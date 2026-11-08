import { Save, Video } from 'lucide-react';
import type { AssetInfo, DocumentSummary, SceneInfo, ShotInfo } from '@ai-video/contracts';
import { DubbingScenePanel } from './dubbing/DubbingScenePanel';
import { MarkdownEditor } from './MarkdownEditor';
import { aggregateShotBindings, type ShotBindingRole } from './shot-binding-summary';

const ROLE_LABELS: Record<ShotBindingRole, string> = {
  character: '角色',
  scene: '场景',
  prop: '道具',
};

export function SceneWorkspace({
  projectId,
  scene,
  shots,
  prompt,
  documents,
  assets,
  writable,
  onPromptChange,
  onSave,
  onGenerateVideo,
  onOpenAsset,
}: {
  projectId?: string;
  scene: SceneInfo;
  shots: ShotInfo[];
  prompt: string;
  documents: DocumentSummary[];
  assets: AssetInfo[];
  writable: boolean;
  onPromptChange: (value: string) => void;
  onSave: (prompt: string) => void;
  onGenerateVideo?: () => void;
  onOpenAsset?: (assetId: string) => void;
}) {
  const bindings = aggregateShotBindings(shots);
  const characterDocumentIds = bindings
    .filter((binding) => binding.role === 'character')
    .map((binding) => binding.documentId);

  return (
    <div className="scene-workspace">
      <section className="scene-prompt-panel">
        <div className="scene-prompt-heading">
          <div>
            <h2>场次提示词</h2>
          </div>
          <div className="toolbar-actions">
            <button
              className="button secondary"
              type="button"
              disabled={!writable}
              onClick={() => onSave(prompt)}
            >
              <Save size={14} /> 保存提示词
            </button>
            {onGenerateVideo && (
              <button
                className="button primary"
                type="button"
                disabled={!writable || !prompt.trim()}
                onClick={onGenerateVideo}
              >
                <Video size={14} /> 生成场次视频
              </button>
            )}
          </div>
        </div>
        <MarkdownEditor
          className="scene-video-prompt-editor"
          label="场次完整视频提示词"
          value={prompt}
          onChange={onPromptChange}
          autoPreviewOnBlur
          readOnly={!writable}
          placeholder="输入这一场完整的视频提示词…"
        />
      </section>

      <section className="scene-material-panel shot-reference-panel" aria-label="镜头绑定汇总">
        <div className="scene-prompt-heading">
          <div className="workspace-section-heading">
            <h2>镜头绑定汇总</h2>
            <span className="workspace-count">{bindings.length} 个引用对象</span>
          </div>
        </div>
        {bindings.length ? (
          <div className="scene-binding-summary-list">
            {bindings.map((binding) => {
              const document = documents.find((item) => item.id === binding.documentId);
              const label = document?.title ?? '资料不可用';
              const boundAssets = binding.assetIds
                .map((id) => assets.find((asset) => asset.id === id))
                .filter((asset): asset is AssetInfo => Boolean(asset));
              return (
                <div
                  className="scene-binding-summary-row"
                  key={`${binding.role}:${binding.documentId}`}
                >
                  <div className="scene-binding-summary-identity">
                    <span>{ROLE_LABELS[binding.role]}</span>
                    <strong title={label}>{label}</strong>
                  </div>
                  <span className="scene-binding-summary-shots">
                    {binding.shotTitles.join('、')}
                  </span>
                  {boundAssets.length > 0 && (
                    <div className="scene-binding-summary-assets">
                      {boundAssets.map((asset) => (
                        <button
                          className="text-button"
                          type="button"
                          key={asset.id}
                          disabled={!onOpenAsset}
                          onClick={() => onOpenAsset?.(asset.id)}
                        >
                          {asset.alias?.trim() ||
                            asset.relativePath.split(/[\\/]/).pop() ||
                            asset.id}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <p className="workspace-hint">尚无镜头引用关系。</p>
        )}
      </section>

      {projectId ? (
        <DubbingScenePanel
          projectId={projectId}
          sceneId={scene.id}
          documents={documents}
          characterDocumentIds={characterDocumentIds}
          writable={writable}
          onOpenAsset={onOpenAsset}
        />
      ) : null}
    </div>
  );
}
