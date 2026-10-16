import { Save, Video } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type {
  AssetInfo,
  DocumentSummary,
  SceneInfo,
  SceneMaterialBindingInfo,
  SceneMaterialRole,
  SceneCharacterBindingInfo,
  AudioFileInfo,
} from '@ai-video/contracts';
import { callWorker } from './worker-client';
import { AssetImagePreview } from './AssetImagePreview';
import { DubbingScenePanel } from './dubbing/DubbingScenePanel';
import { SceneCastEditor } from './SceneCastEditor';
import { sceneMediaParams, useSceneMedia } from './scene-media';

function isImage(asset: AssetInfo): boolean {
  return !asset.deletedAt && !asset.kind.toLowerCase().includes('video');
}

export function SceneWorkspace(props: Parameters<typeof SceneWorkspaceContent>[0]) {
  return <SceneWorkspaceContent key={`${props.projectId}:${props.scene.id}`} {...props} />;
}

function SceneWorkspaceContent({
  projectId,
  scene,
  prompt,
  bindings,
  documents,
  assets,
  writable,
  onPromptChange,
  onSave,
  onGenerateVideo,
  onOpenAsset,
  onRequestBindings,
  mediaRevision,
}: {
  projectId?: string;
  scene: SceneInfo;
  prompt: string;
  bindings: SceneMaterialBindingInfo[];
  documents: DocumentSummary[];
  assets: AssetInfo[];
  writable: boolean;
  mediaRevision?: number;
  onPromptChange: (value: string) => void;
  onSave: (
    prompt: string,
    bindings: SceneMaterialBindingInfo[],
    characters: SceneCharacterBindingInfo[],
    dialogueAudioId?: string,
  ) => void;
  onGenerateVideo: (
    bindings: SceneMaterialBindingInfo[],
    characters: SceneCharacterBindingInfo[],
    dialogueAudioId?: string,
  ) => void;
  onOpenAsset?: (assetId: string) => void;
  onRequestBindings?: (
    prompt: string,
    bindings: SceneMaterialBindingInfo[],
    characters: SceneCharacterBindingInfo[],
    dialogueAudioId?: string,
  ) => void;
}) {
  const [localBindings, setLocalBindings] = useState(
    bindings.filter((item) => item.role !== 'character'),
  );
  const [characters, setCharacters] = useState(scene.characterBindings ?? []);
  const [dialogueAudioId, setDialogueAudioId] = useState(scene.dialogueAudioId);
  const [audios, setAudios] = useState<AudioFileInfo[]>([]);
  const [audioLoaded, setAudioLoaded] = useState(false);
  const [message, setMessage] = useState('');
  const revision = useMemo(() => ({ mediaRevision, assets }), [mediaRevision, assets]);
  const params = sceneMediaParams(
    characters,
    localBindings.map((b) => b.assetId),
  );
  const media = useSceneMedia(projectId, params, revision);
  const mediaAssets = useMemo(() => {
    const selected = new Set(params.assetIds);
    const map = new Map(assets.filter((a) => !selected.has(a.id)).map((a) => [a.id, a]));
    for (const asset of media.value?.assets ?? []) map.set(asset.id, asset);
    return [...map.values()];
  }, [assets, media.value]);

  useEffect(() => {
    setLocalBindings(
      bindings.filter(
        (item) =>
          item.role !== 'character' &&
          !(
            item.role === 'scene' &&
            item.source === 'auto' &&
            item.sourceDocumentId !== scene.sceneDocumentId
          ),
      ),
    );
    setCharacters(scene.characterBindings ?? []);
    setDialogueAudioId(scene.dialogueAudioId);
  }, [scene.rowVersion, scene.sceneDocumentId]);
  useEffect(() => {
    let active = true;
    let sequence = 0;
    const refresh = () => {
      const token = ++sequence;
      if (projectId)
        void callWorker('audio.list', {})
          .then((nextAudios) => {
            if (active && token === sequence) {
              setAudios(nextAudios ?? []);
              setAudioLoaded(true);
            }
          })
          .catch(() => {
            if (active && token === sequence) {
              setAudioLoaded(true);
              setMessage('声音资料读取失败，可重新打开场次后重试。');
            }
          });
    };
    refresh();
    window.addEventListener('scene-audio-updated', refresh);
    return () => {
      active = false;
      window.removeEventListener('scene-audio-updated', refresh);
    };
  }, [projectId]);

  const candidatesByRole = useMemo(() => {
    const map: Record<SceneMaterialRole, AssetInfo[]> = {
      character: [],
      scene: [],
      prop: [],
      other: [],
    };
    for (const asset of mediaAssets.filter(isImage)) {
      const kind = asset.kind.toLowerCase();
      const role = kind.includes('character')
        ? 'character'
        : kind.includes('scene')
          ? 'scene'
          : kind.includes('prop')
            ? 'prop'
            : 'other';
      map[role].push(asset);
    }
    return map;
  }, [mediaAssets]);

  const setAsset = (binding: SceneMaterialBindingInfo, assetId: string) => {
    setLocalBindings((current) =>
      current.map((item) =>
        item.id === binding.id ? { ...item, assetId, source: 'manual' } : item,
      ),
    );
  };
  const tooManyReferences =
    localBindings.length +
      characters.filter(
        (item) =>
          !item.imageDisabled &&
          (item.imageAssetId ||
            media.value?.characters.find((c) => c.characterDocumentId === item.characterDocumentId)
              ?.defaultImage),
      ).length >
    30;

  return (
    <div className="scene-workspace">
      <section className="scene-prompt-panel">
        <div className="scene-prompt-heading">
          <div>
            <span className="eyebrow">场次 · {scene.title}</span>
            <h1>完整视频提示词</h1>
          </div>
          <div className="toolbar-actions">
            <button
              className="button secondary"
              type="button"
              disabled={!writable || !audioLoaded || !prompt.trim() || !onRequestBindings}
              onClick={() =>
                onRequestBindings?.(prompt, localBindings, characters, dialogueAudioId)
              }
            >
              让助手关联角色与场景
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={!writable}
              onClick={() => onSave(prompt, localBindings, characters, dialogueAudioId)}
            >
              <Save size={14} /> 保存提示词
            </button>
            <button
              className="button primary"
              type="button"
              disabled={
                !writable ||
                !prompt.trim() ||
                tooManyReferences ||
                media.loading ||
                Boolean(media.error)
              }
              onClick={() => onGenerateVideo(localBindings, characters, dialogueAudioId)}
            >
              <Video size={14} /> 生成场次视频
            </button>
          </div>
        </div>
        <textarea
          className="markdown-editor scene-video-prompt-editor"
          aria-label="场次完整视频提示词"
          value={prompt}
          onChange={(event) => {
            onPromptChange(event.target.value);
          }}
          readOnly={!writable}
          placeholder="输入这一场完整的视频提示词…"
        />
        {message ? <div className="inline-status">{message}</div> : null}
        {media.error ? (
          <div role="status">
            {media.error}{' '}
            <button type="button" onClick={media.retry}>
              重试读取参考资料
            </button>
          </div>
        ) : null}
        {tooManyReferences ? (
          <div className="inline-status">
            场次参考图片过多，请减少绑定；实际模型限制将在制作页检查。
          </div>
        ) : null}
      </section>
      {projectId && (
        <SceneCastEditor
          projectId={projectId}
          characters={characters}
          documents={documents}
          assets={mediaAssets}
          voices={media.value?.voices ?? []}
          defaults={media.value?.characters ?? []}
          mediaLoading={media.loading}
          audios={audios}
          dialogueAudioId={dialogueAudioId}
          writable={writable}
          onChange={(value) => {
            setCharacters(value);
          }}
          onDialogueChange={(value) => {
            setDialogueAudioId(value);
          }}
          onAudioImported={(audio) =>
            setAudios((current) => [audio, ...current.filter((item) => item.id !== audio.id)])
          }
        />
      )}
      <section className="scene-material-panel" aria-label="场次参考素材">
        <div className="scene-prompt-heading">
          <div>
            <h2>场次参考素材</h2>
            <p>角色与场景由助手理解提示词后提出关联方案，批准后生效。参考图可手动调整。</p>
          </div>
          <button
            className="text-button"
            type="button"
            disabled={!writable || !prompt.trim() || !onRequestBindings}
            onClick={() => onRequestBindings?.(prompt, localBindings, characters, dialogueAudioId)}
          >
            重新交给助手关联
          </button>
        </div>
        {localBindings.length === 0 ? (
          <p className="tree-empty">暂无绑定素材</p>
        ) : (
          <div className="scene-material-grid">
            {localBindings.map((binding) => {
              const candidates =
                candidatesByRole[binding.role].length > 0
                  ? candidatesByRole[binding.role]
                  : mediaAssets.filter(isImage);
              const asset = mediaAssets.find((item) => item.id === binding.assetId);
              return (
                <article className="scene-material-card" key={binding.id}>
                  <strong>{binding.label}</strong>
                  <span>
                    {binding.role === 'character'
                      ? '角色'
                      : binding.role === 'scene'
                        ? '场景'
                        : binding.role === 'prop'
                          ? '道具'
                          : '素材'}
                  </span>
                  {asset ? (
                    <AssetImagePreview asset={asset} />
                  ) : (
                    <div className="scene-material-missing">未选择图片</div>
                  )}
                  <select
                    aria-label={`${binding.label}参考图`}
                    value={binding.assetId}
                    disabled={!writable}
                    onChange={(event) => setAsset(binding, event.target.value)}
                  >
                    {candidates.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.alias || item.relativePath.split(/[\\/]/).pop() || item.id}
                      </option>
                    ))}
                  </select>
                  <button
                    className="text-button"
                    type="button"
                    disabled={!writable}
                    onClick={() => {
                      setLocalBindings((current) =>
                        current.filter((item) => item.id !== binding.id),
                      );
                    }}
                  >
                    移除{binding.label}
                  </button>
                </article>
              );
            })}
          </div>
        )}
      </section>
      {projectId ? (
        <DubbingScenePanel
          projectId={projectId}
          sceneId={scene.id}
          documents={documents}
          characterDocumentIds={(scene.characterBindings ?? []).map(
            (item) => item.characterDocumentId,
          )}
          writable={writable}
          onOpenAsset={onOpenAsset}
        />
      ) : null}
    </div>
  );
}
