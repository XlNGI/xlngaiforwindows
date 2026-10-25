import { Save, Video } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type {
  AssetInfo,
  DocumentSummary,
  SceneInfo,
  SceneMaterialBindingInfo,
  SceneCharacterBindingInfo,
  AudioFileInfo,
} from '@ai-video/contracts';
import { projectWorker } from './worker-scope';
import { ReferenceCard, referenceAssetName } from './ReferenceCard';
import { SceneSettingCard, useSceneSettingImages } from './SceneSettingCard';
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
  onBindSceneDocument,
  onOpenDocument,
  sceneBindingBusy,
  sceneBindingMessage,
}: {
  projectId?: string;
  scene: SceneInfo;
  prompt: string;
  bindings: SceneMaterialBindingInfo[];
  documents: DocumentSummary[];
  assets: AssetInfo[];
  writable: boolean;
  mediaRevision?: number;
  onBindSceneDocument?: (id: string) => void;
  onOpenDocument?: (id: string) => void;
  sceneBindingBusy?: boolean;
  sceneBindingMessage?: string;
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
  const callWorker = projectWorker();
  const [localBindings, setLocalBindings] = useState(
    bindings.filter((item) => item.role !== 'character'),
  );
  const [characters, setCharacters] = useState(scene.characterBindings ?? []);
  const [dialogueAudioId, setDialogueAudioId] = useState(scene.dialogueAudioId);
  const [audios, setAudios] = useState<AudioFileInfo[]>([]);
  const [audioLoaded, setAudioLoaded] = useState(false);
  const [message, setMessage] = useState('');
  const revision = useMemo(() => ({ mediaRevision, assets }), [mediaRevision, assets]);
  const sceneDocumentIds = Array.from(
    new Set(
      scene.sceneDocumentIds?.length
        ? scene.sceneDocumentIds
        : scene.sceneDocumentId
          ? [scene.sceneDocumentId]
          : [],
    ),
  );
  const primarySceneDocumentId = scene.sceneDocumentId ?? sceneDocumentIds[0];
  const setting = useSceneSettingImages(projectId, sceneDocumentIds, documents, revision);
  const sceneBindings = localBindings.filter((b) => b.role === 'scene');
  const sceneBinding = sceneBindings[0];
  const defaultSceneImage = setting.assets[0];
  const selectedSceneDocuments = new Set(
    sceneBindings.flatMap((binding) =>
      binding.sourceDocumentId ? [binding.sourceDocumentId] : [],
    ),
  );
  const defaultSceneBindings = sceneDocumentIds.flatMap((sourceDocumentId) => {
    if (selectedSceneDocuments.has(sourceDocumentId)) return [];
    const asset = setting.assetsByDocument[sourceDocumentId]?.[0];
    if (!asset) return [];
    return [
      {
        id: `scene:${sourceDocumentId}`,
        role: 'scene' as const,
        label: documents.find((d) => d.id === sourceDocumentId)?.title ?? '场景',
        assetId: asset.id,
        sourceDocumentId,
        source: 'auto' as const,
      },
    ];
  });
  const effectiveBindings = [...localBindings, ...defaultSceneBindings];
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

  const savedMaterials = JSON.stringify(bindings);
  const savedCharacters = JSON.stringify(scene.characterBindings ?? []);
  useEffect(() => {
    setLocalBindings(
      bindings.filter(
        (item) =>
          item.role !== 'character' &&
          !(
            item.role === 'scene' &&
            item.source === 'auto' &&
            !sceneDocumentIds.includes(item.sourceDocumentId ?? '')
          ),
      ),
    );
  }, [savedMaterials, sceneDocumentIds.join('|')]);
  useEffect(() => {
    setLocalBindings((current) =>
      current.filter(
        (b) =>
          !(
            b.role === 'scene' &&
            b.source === 'auto' &&
            !sceneDocumentIds.includes(b.sourceDocumentId ?? '')
          ),
      ),
    );
  }, [sceneDocumentIds.join('|')]);
  useEffect(() => {
    setCharacters(scene.characterBindings ?? []);
  }, [savedCharacters]);
  useEffect(() => {
    setDialogueAudioId(scene.dialogueAudioId);
  }, [scene.dialogueAudioId]);
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

  const setAsset = (binding: SceneMaterialBindingInfo, assetId: string) => {
    setLocalBindings((current) =>
      current.map((item) =>
        item.id === binding.id ? { ...item, assetId, source: 'manual' } : item,
      ),
    );
  };
  const tooManyReferences =
    effectiveBindings.length +
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
            <h2>场次提示词</h2>
          </div>
          <div className="toolbar-actions">
            <button
              className="button secondary"
              type="button"
              disabled={!writable}
              onClick={() => onSave(prompt, effectiveBindings, characters, dialogueAudioId)}
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
                setting.loading ||
                Boolean(setting.error) ||
                Boolean(media.error)
              }
              onClick={() => onGenerateVideo(effectiveBindings, characters, dialogueAudioId)}
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
          sceneLabel={
            sceneDocumentIds.length
              ? `${sceneDocumentIds
                  .map((id) => documents.find((item) => item.id === id)?.title ?? '资料不可用')
                  .join('、')}`
              : undefined
          }
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
          actions={
            <div className="binding-actions">
              <button
                className="button secondary"
                type="button"
                disabled={!writable || !audioLoaded || !prompt.trim() || !onRequestBindings}
                title="根据提示词关联角色与场景并保存，之后可随时修改"
                onClick={() =>
                  onRequestBindings?.(prompt, effectiveBindings, characters, dialogueAudioId)
                }
              >
                助手关联
              </button>
              <button
                type="button"
                className="button secondary"
                disabled={!writable}
                onClick={() => onSave(prompt, effectiveBindings, characters, dialogueAudioId)}
              >
                保存绑定
              </button>
            </div>
          }
        >
          <SceneSettingCard
            projectId={projectId}
            documentId={primarySceneDocumentId}
            documentIds={sceneDocumentIds}
            documents={documents}
            asset={
              sceneBinding
                ? mediaAssets.find((a) => a.id === sceneBinding.assetId)
                : defaultSceneImage
            }
            images={setting.assets}
            candidates={setting.assets}
            writable={writable}
            busy={sceneBindingBusy}
            message={sceneBindingMessage || setting.error}
            onBind={onBindSceneDocument}
            onOpen={onOpenDocument}
            canClear={!scene.sceneDocumentId}
            onSelectImage={(id) =>
              setLocalBindings((current) => [
                ...current.filter((b) => b.id !== sceneBinding?.id),
                ...(id
                  ? [
                      {
                        id: sceneBinding?.id ?? `scene:${scene.id}`,
                        role: 'scene' as const,
                        label: '场景参考',
                        assetId: id,
                        sourceDocumentId: primarySceneDocumentId,
                        source: 'manual' as const,
                      },
                    ]
                  : []),
              ])
            }
            onDropAsset={(asset) =>
              setLocalBindings((current) => [
                ...current.filter((b) => b.id !== sceneBinding?.id),
                {
                  id: sceneBinding?.id ?? `scene:${scene.id}`,
                  role: 'scene',
                  label: '场景参考',
                  assetId: asset.id,
                  sourceDocumentId: primarySceneDocumentId,
                  source: 'manual',
                },
              ])
            }
            onRestore={
              sceneBinding && sceneDocumentIds.length
                ? () =>
                    setLocalBindings((current) => current.filter((b) => b.id !== sceneBinding?.id))
                : undefined
            }
          />
          {localBindings
            .filter((b) => b.id !== sceneBinding?.id)
            .map((binding) => {
              const candidates = mediaAssets.filter(isImage);
              const asset = mediaAssets.find((item) => item.id === binding.assetId);
              return (
                <ReferenceCard
                  label={binding.label}
                  asset={asset}
                  projectId={projectId}
                  writable={writable}
                  onDropAsset={(a) => setAsset(binding, a.id)}
                  key={binding.id}
                  selector={
                    <select
                      aria-label={`${binding.label}参考图`}
                      value={binding.assetId}
                      disabled={!writable}
                      onChange={(event) => setAsset(binding, event.target.value)}
                    >
                      {candidates.map((item) => (
                        <option key={item.id} value={item.id}>
                          {referenceAssetName(item)}
                        </option>
                      ))}
                    </select>
                  }
                >
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
                </ReferenceCard>
              );
            })}
        </SceneCastEditor>
      )}
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
