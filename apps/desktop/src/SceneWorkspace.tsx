import { Save, Video } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AssetInfo,
  DocumentSummary,
  SceneInfo,
  SceneMaterialBindingInfo,
  SceneMaterialRole,
  SceneCharacterBindingInfo,
  CharacterVoiceReferenceInfo,
  AudioFileInfo,
} from '@ai-video/contracts';
import { callWorker } from './worker-client';
import { AssetImagePreview } from './AssetImagePreview';
import { DubbingScenePanel } from './dubbing/DubbingScenePanel';
import { SceneCastEditor } from './SceneCastEditor';

const REFERENCE_PATTERN = /\[(角色|场景|道具|人物|地点|物件):([^\]]+)\]/gu;

function normalizeRole(value: string): SceneMaterialRole {
  if (value === '角色' || value === '人物') return 'character';
  if (value === '场景' || value === '地点') return 'scene';
  if (value === '道具' || value === '物件') return 'prop';
  return 'other';
}

function bindingKey(role: SceneMaterialRole, label: string): string {
  return `${role}:${label.trim()}`;
}

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
}: {
  projectId?: string;
  scene: SceneInfo;
  prompt: string;
  bindings: SceneMaterialBindingInfo[];
  documents: DocumentSummary[];
  assets: AssetInfo[];
  writable: boolean;
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
}) {
  const [localBindings, setLocalBindings] = useState(
    bindings.filter((item) => item.role !== 'character'),
  );
  const [characters, setCharacters] = useState(scene.characterBindings ?? []);
  const [dialogueAudioId, setDialogueAudioId] = useState(scene.dialogueAudioId);
  const [voices, setVoices] = useState<CharacterVoiceReferenceInfo[]>([]);
  const [audios, setAudios] = useState<AudioFileInfo[]>([]);
  const [audioLoaded, setAudioLoaded] = useState(false);
  const requestSequence = useRef(0);
  const [message, setMessage] = useState('');

  useEffect(() => {
    requestSequence.current++;
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
        void Promise.all([
          callWorker('characterVoiceReference.list', {}),
          callWorker('audio.list', {}),
        ])
          .then(([nextVoices, nextAudios]) => {
            if (active && token === sequence) {
              setVoices(nextVoices ?? []);
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
    window.addEventListener('character-voice-reference-updated', refresh);
    window.addEventListener('scene-audio-updated', refresh);
    return () => {
      active = false;
      requestSequence.current++;
      window.removeEventListener('character-voice-reference-updated', refresh);
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
    for (const asset of assets.filter(isImage)) {
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
  }, [assets]);

  const autoBind = async () => {
    if (!writable) return;
    const sequence = ++requestSequence.current;
    setMessage('正在识别场次素材…');
    try {
      const next = new Map<string, SceneMaterialBindingInfo>();
      const nextCharacters: SceneCharacterBindingInfo[] = [];
      const mentions = [...prompt.matchAll(REFERENCE_PATTERN)];
      if (scene.sceneDocumentId) {
        const bound = documents.find((document) => document.id === scene.sceneDocumentId);
        if (bound) {
          const sourceAssets = await callWorker('asset.list', {
            sourceDocumentId: bound.id,
            sort: 'created-desc',
            limit: 1,
          });
          const asset = sourceAssets.find(isImage);
          if (asset)
            next.set(bindingKey('scene', bound.title), {
              id: bindingKey('scene', bound.title),
              role: 'scene',
              label: bound.title,
              assetId: asset.id,
              sourceDocumentId: bound.id,
              source: 'auto',
            });
        }
      }
      for (const match of mentions) {
        const role = normalizeRole(match[1] ?? '');
        const label = (match[2] ?? '').trim();
        if (!label || next.has(bindingKey(role, label))) continue;
        const matches = documents.filter(
          (item) =>
            item.title.trim() === label &&
            item.domainScope !== 'novel' &&
            item.lifecycleStatus !== 'archived' &&
            item.projectId === projectId &&
            (item.kind === role || role === 'prop' || role === 'other'),
        );
        const document = matches.length === 1 ? matches[0] : undefined;
        if (!document) continue;
        const sourceAssets = await callWorker('asset.list', {
          sourceDocumentId: document.id,
          sort: 'created-desc',
          limit: 1,
        });
        const asset = sourceAssets.find(isImage);
        if (role === 'character') {
          const voice = voices.find((item) => item.characterDocumentId === document.id);
          if (!nextCharacters.some((item) => item.characterDocumentId === document.id))
            nextCharacters.push({
              characterDocumentId: document.id,
              ...(asset ? { imageAssetId: asset.id } : {}),
              ...(voice ? { voiceReferenceVersionId: voice.versionId } : {}),
            });
        } else if (asset)
          next.set(bindingKey(role, label), {
            id: bindingKey(role, label),
            role,
            label,
            assetId: asset.id,
            sourceDocumentId: document.id,
            source: 'auto',
          });
      }
      if (sequence !== requestSequence.current) return;
      const merged = [
        ...localBindings,
        ...[...next.values()].filter(
          (item) => !localBindings.some((existing) => existing.id === item.id),
        ),
      ];
      setLocalBindings(merged);
      setCharacters((current) => [
        ...current,
        ...nextCharacters.filter(
          (item) =>
            !current.some((existing) => existing.characterDocumentId === item.characterDocumentId),
        ),
      ]);
      setMessage(
        merged.length || nextCharacters.length
          ? '已识别场次角色与素材，可继续手动调整并保存。'
          : '没有找到可用的参考图片。',
      );
    } catch (error) {
      if (sequence !== requestSequence.current) return;
      setMessage(error instanceof Error ? error.message : '素材识别失败。');
    }
  };

  const setAsset = (binding: SceneMaterialBindingInfo, assetId: string) => {
    requestSequence.current++;
    setLocalBindings((current) =>
      current.map((item) =>
        item.id === binding.id ? { ...item, assetId, source: 'manual' } : item,
      ),
    );
  };
  const tooManyReferences =
    localBindings.length + characters.filter((item) => item.imageAssetId).length > 30;

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
              disabled={!writable || !audioLoaded}
              onClick={() => void autoBind()}
            >
              自动识别素材
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
              disabled={!writable || !prompt.trim() || tooManyReferences}
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
            requestSequence.current++;
            onPromptChange(event.target.value);
          }}
          readOnly={!writable}
          placeholder="输入这一场完整的视频提示词…"
        />
        {message ? <div className="inline-status">{message}</div> : null}
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
          assets={assets}
          voices={voices}
          audios={audios}
          dialogueAudioId={dialogueAudioId}
          writable={writable}
          onChange={(value) => {
            requestSequence.current++;
            setCharacters(value);
          }}
          onDialogueChange={(value) => {
            requestSequence.current++;
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
            <p>场景和道具参考图可手动替换；角色参考图在上方出场角色中维护。</p>
          </div>
          <button
            className="text-button"
            type="button"
            disabled={!writable}
            onClick={() => void autoBind()}
          >
            重新识别
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
                  : assets.filter(isImage);
              const asset = assets.find((item) => item.id === binding.assetId);
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
                      requestSequence.current++;
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
