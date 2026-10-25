import { useEffect, useRef, useState, type ReactNode } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { projectWorker } from './worker-scope';
import type {
  AssetInfo,
  AudioFileInfo,
  CharacterVoiceReferenceInfo,
  DocumentSummary,
  SceneCharacterBindingInfo,
  SceneCharacterMediaInfo,
} from '@ai-video/contracts';
import { ReferenceCard } from './ReferenceCard';
import { useDubbingMedia } from './dubbing/media';

function AudioPreview({ projectId, audioId }: { projectId: string; audioId?: string }) {
  return audioId ? (
    <RequestedAudioPreview
      key={`${projectId}:${audioId}`}
      projectId={projectId}
      audioId={audioId}
    />
  ) : null;
}
function RequestedAudioPreview({ projectId, audioId }: { projectId: string; audioId: string }) {
  const [requested, setRequested] = useState(false);
  const media = useDubbingMedia(projectId, requested ? audioId : undefined, true);
  return media?.src ? (
    <audio controls autoPlay preload="none" src={media.src} aria-label="试听绑定音频" />
  ) : media?.error ? (
    <small>{media.error}</small>
  ) : (
    <button
      className="text-button"
      type="button"
      disabled={requested}
      onClick={() => setRequested(true)}
    >
      {requested ? '正在读取音频…' : '试听绑定音频'}
    </button>
  );
}

export function SceneCastEditor({
  projectId,
  characters,
  documents,
  assets,
  voices,
  defaults,
  mediaLoading,
  audios,
  dialogueAudioId,
  writable,
  onChange,
  onDialogueChange,
  onAudioImported,
  children,
  actions,
  scopeNote = '本场绑定供同场镜头共用。图片可拖入或选择。',
  sceneLabel,
}: {
  projectId: string;
  characters: SceneCharacterBindingInfo[];
  documents: DocumentSummary[];
  assets: AssetInfo[];
  voices: CharacterVoiceReferenceInfo[];
  defaults: SceneCharacterMediaInfo[];
  mediaLoading: boolean;
  audios: AudioFileInfo[];
  dialogueAudioId?: string;
  writable: boolean;
  onChange: (value: SceneCharacterBindingInfo[]) => void;
  onDialogueChange: (id: string | undefined) => void;
  onAudioImported: (audio: AudioFileInfo) => void;
  children?: ReactNode;
  actions?: ReactNode;
  scopeNote?: string;
  sceneLabel?: string;
}) {
  const callWorker = projectWorker();
  const [selected, setSelected] = useState('');
  const [message, setMessage] = useState('');
  const [importing, setImporting] = useState(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const importDialogue = async () => {
    if (!writable || importing) return;
    if (!('__TAURI_INTERNALS__' in window)) {
      setMessage('请在 Windows 桌面应用中导入完整对白。');
      return;
    }
    setImporting(true);
    try {
      const path = await openDialog({
        multiple: false,
        filters: [{ name: '完整对白音频', extensions: ['wav', 'mp3'] }],
      });
      if (typeof path !== 'string' || !active.current) return;
      const result = await callWorker('audio.import', {
        sourcePath: path,
        kind: 'imported-dialogue',
      });
      if (active.current) {
        onAudioImported(result.audio);
        onDialogueChange(result.audio.id);
        setMessage('对白已导入，请保存场次绑定。');
      }
    } catch (error) {
      if (active.current) setMessage(error instanceof Error ? error.message : '对白导入失败。');
    } finally {
      if (active.current) setImporting(false);
    }
  };
  const candidates = documents.filter(
    (document) =>
      document.projectId === projectId &&
      document.kind === 'character' &&
      document.domainScope !== 'novel' &&
      document.lifecycleStatus !== 'archived',
  );
  const images = assets.filter(
    (asset) =>
      asset.projectId === projectId &&
      !asset.deletedAt &&
      !asset.kind.toLowerCase().includes('video'),
  );
  const update = (id: string, patch: Partial<SceneCharacterBindingInfo>) =>
    onChange(
      characters.map((item) => (item.characterDocumentId === id ? { ...item, ...patch } : item)),
    );
  return (
    <section className="scene-material-panel shot-reference-panel" aria-label="参考资料">
      <div className="scene-prompt-heading">
        <div>
          <div className="workspace-section-heading">
            <h2>角色与场景绑定</h2>
            <span className="workspace-count">
              {characters.length} 位角色 · {sceneLabel ? `场景：${sceneLabel}` : '场景未绑定'}
            </span>
          </div>
          <p className="workspace-hint">{scopeNote}</p>
        </div>
        {actions}
      </div>
      <div className="scene-cast-add">
        <select
          aria-label="选择出场角色"
          value={selected}
          disabled={!writable}
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value="">选择角色…</option>
          {candidates
            .filter(
              (document) => !characters.some((item) => item.characterDocumentId === document.id),
            )
            .map((document) => (
              <option key={document.id} value={document.id}>
                {document.title}
              </option>
            ))}
        </select>
        <button
          className="button secondary"
          type="button"
          disabled={!writable || !selected || characters.length >= 30}
          onClick={() => {
            onChange([
              ...characters,
              {
                characterDocumentId: selected,
              },
            ]);
            setSelected('');
          }}
        >
          添加角色
        </button>
      </div>
      <div className="shot-reference-grid">
        {characters.map((character) => {
          const document = documents.find((item) => item.id === character.characterDocumentId);
          const name = document?.title ?? '角色资料不可用';
          const inherited = defaults.find(
            (item) => item.characterDocumentId === character.characterDocumentId,
          );
          const voice = inherited?.voice;
          const selectedVoice = character.voiceDisabled
            ? undefined
            : character.voiceReferenceVersionId
              ? voices.find(
                  (item) =>
                    item.versionId === character.voiceReferenceVersionId &&
                    item.characterDocumentId === character.characterDocumentId,
                )
              : voice;
          const stale = Boolean(
            character.voiceReferenceVersionId &&
            character.voiceReferenceVersionId !== voice?.versionId,
          );
          const image = character.imageDisabled
            ? undefined
            : character.imageAssetId
              ? images.find((item) => item.id === character.imageAssetId)
              : inherited?.defaultImage;
          const candidates = [
            ...new Map(
              [...(inherited?.images ?? []), ...(image ? [image] : [])].map((asset) => [
                asset.id,
                asset,
              ]),
            ).values(),
          ];
          return (
            <ReferenceCard
              key={character.characterDocumentId}
              label={`角色参考：${name}`}
              projectId={projectId}
              asset={image}
              writable={writable}
              onDropAsset={(asset) =>
                update(character.characterDocumentId, {
                  imageAssetId: asset.id,
                  imageDisabled: undefined,
                })
              }
              emptyText={
                mediaLoading
                  ? '正在读取参考资料…'
                  : character.imageDisabled
                    ? '本场不使用参考图'
                    : character.imageAssetId
                      ? '参考图不可用'
                      : '拖入或下拉选择'
              }
              selector={
                <select
                  aria-label={`${name}角色参考图`}
                  value={character.imageDisabled ? 'none' : (character.imageAssetId ?? 'default')}
                  disabled={!writable}
                  onChange={(event) =>
                    update(character.characterDocumentId, {
                      imageAssetId: ['default', 'none'].includes(event.target.value)
                        ? undefined
                        : event.target.value,
                      imageDisabled: event.target.value === 'none' ? true : undefined,
                    })
                  }
                >
                  <option value="default">角色默认图</option>
                  <option value="none">不使用参考图</option>
                  {character.imageAssetId && !image && (
                    <option value={character.imageAssetId}>原参考图不可用</option>
                  )}
                  {candidates.map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.alias || asset.relativePath.split(/[\\/]/).pop()}
                    </option>
                  ))}
                </select>
              }
            >
              {document?.lifecycleStatus === 'archived' && <small>角色已归档，请调整绑定。</small>}
              <label>
                声音参考
                <select
                  aria-label={`${name}声音样本`}
                  value={
                    character.voiceDisabled
                      ? 'none'
                      : (character.voiceReferenceVersionId ?? 'default')
                  }
                  disabled={!writable}
                  onChange={(event) =>
                    update(character.characterDocumentId, {
                      voiceReferenceVersionId: ['default', 'none'].includes(event.target.value)
                        ? undefined
                        : event.target.value,
                      voiceDisabled: event.target.value === 'none' ? true : undefined,
                    })
                  }
                >
                  <option value="default">角色默认声音</option>
                  <option value="none">不使用声音参考</option>
                  {stale && (
                    <option value={character.voiceReferenceVersionId}>
                      原声音版本已更新，请重新选择
                    </option>
                  )}
                  {voice && (
                    <option value={voice.versionId}>
                      {voice.audioName} · 版本 {voice.revision}
                    </option>
                  )}
                </select>
              </label>
              {stale && (
                <small role="status">声音样本已更新，重新选择后再生成；已保存任务不受影响。</small>
              )}
              {selectedVoice && (
                <AudioPreview projectId={projectId} audioId={selectedVoice.audioId} />
              )}
              <button
                className="text-button"
                type="button"
                disabled={!writable}
                onClick={() =>
                  onChange(
                    characters.filter(
                      (item) => item.characterDocumentId !== character.characterDocumentId,
                    ),
                  )
                }
              >
                移除{name}
              </button>
            </ReferenceCard>
          );
        })}
        {children}
      </div>
      <details className="workspace-extra scene-dialogue-settings" open={Boolean(dialogueAudioId)}>
        <summary>完整对白{dialogueAudioId ? ' · 已绑定' : ' · 可选'}</summary>
        <label className="scene-dialogue-picker">
          本场完整对白
          <select
            aria-label="场次完整对白音频"
            value={dialogueAudioId ?? ''}
            disabled={!writable}
            onChange={(event) => onDialogueChange(event.target.value || undefined)}
          >
            <option value="">不绑定完整对白</option>
            {dialogueAudioId && !audios.some((audio) => audio.id === dialogueAudioId) && (
              <option value={dialogueAudioId}>原对白音频不可用</option>
            )}
            {audios
              .filter(
                (audio) =>
                  audio.kind !== 'reference' && !audio.deletedAt && audio.projectId === projectId,
              )
              .map((audio) => (
                <option key={audio.id} value={audio.id}>
                  {audio.name} · {(audio.durationMs / 1000).toFixed(1)} 秒
                </option>
              ))}
          </select>
        </label>
        <button
          className="button secondary"
          type="button"
          disabled={!writable || importing}
          onClick={() => void importDialogue()}
        >
          {importing ? '正在导入…' : '导入完整对白'}
        </button>
        {message && <p role="status">{message}</p>}
        <p className="workspace-hint">绑定完整录音，用于音频驱动画面。</p>
        <AudioPreview projectId={projectId} audioId={dialogueAudioId} />
      </details>
    </section>
  );
}
