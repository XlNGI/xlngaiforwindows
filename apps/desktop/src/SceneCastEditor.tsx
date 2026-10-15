import { useEffect, useRef, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { callWorker } from './worker-client';
import type {
  AssetInfo,
  AudioFileInfo,
  CharacterVoiceReferenceInfo,
  DocumentSummary,
  SceneCharacterBindingInfo,
} from '@ai-video/contracts';
import { AssetImagePreview } from './AssetImagePreview';
import { useDubbingMedia } from './dubbing/media';

function AudioPreview({ projectId, audioId }: { projectId: string; audioId?: string }) {
  const media = useDubbingMedia(projectId, audioId, true);
  return media?.src ? (
    <audio controls preload="none" src={media.src} aria-label="试听绑定音频" />
  ) : media?.error ? (
    <small>{media.error}</small>
  ) : null;
}

export function SceneCastEditor({
  projectId,
  characters,
  documents,
  assets,
  voices,
  audios,
  dialogueAudioId,
  writable,
  onChange,
  onDialogueChange,
  onAudioImported,
}: {
  projectId: string;
  characters: SceneCharacterBindingInfo[];
  documents: DocumentSummary[];
  assets: AssetInfo[];
  voices: CharacterVoiceReferenceInfo[];
  audios: AudioFileInfo[];
  dialogueAudioId?: string;
  writable: boolean;
  onChange: (value: SceneCharacterBindingInfo[]) => void;
  onDialogueChange: (id: string | undefined) => void;
  onAudioImported: (audio: AudioFileInfo) => void;
}) {
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
    <section className="scene-material-panel" aria-label="场次角色与音频">
      <div className="scene-prompt-heading">
        <div>
          <h2>出场角色与声音</h2>
          <p>角色可先绑定，再补参考图和声音。保存后用于本场视频与配音。</p>
        </div>
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
            const voice = voices.find((item) => item.characterDocumentId === selected);
            onChange([
              ...characters,
              {
                characterDocumentId: selected,
                ...(voice ? { voiceReferenceVersionId: voice.versionId } : {}),
              },
            ]);
            setSelected('');
          }}
        >
          添加角色
        </button>
      </div>
      <div className="scene-material-grid">
        {characters.map((character) => {
          const document = documents.find((item) => item.id === character.characterDocumentId);
          const name = document?.title ?? '角色资料不可用';
          const voice = voices.find(
            (item) => item.characterDocumentId === character.characterDocumentId,
          );
          const stale = Boolean(
            character.voiceReferenceVersionId &&
            character.voiceReferenceVersionId !== voice?.versionId,
          );
          const image = images.find((item) => item.id === character.imageAssetId);
          return (
            <article className="scene-material-card" key={character.characterDocumentId}>
              <strong>{name}</strong>
              {document?.lifecycleStatus === 'archived' && <small>角色已归档，请调整绑定。</small>}
              {image ? (
                <AssetImagePreview asset={image} />
              ) : (
                <div className="scene-material-missing">
                  {character.imageAssetId ? '参考图不可用' : '尚未选择参考图'}
                </div>
              )}
              <label>
                参考图
                <select
                  aria-label={`${name}角色参考图`}
                  value={character.imageAssetId ?? ''}
                  disabled={!writable}
                  onChange={(event) =>
                    update(character.characterDocumentId, {
                      imageAssetId: event.target.value || undefined,
                    })
                  }
                >
                  <option value="">不使用参考图</option>
                  {character.imageAssetId && !image && (
                    <option value={character.imageAssetId}>原参考图不可用</option>
                  )}
                  {images.map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.alias || asset.relativePath.split(/[\\/]/).pop()}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                声音样本
                <select
                  aria-label={`${name}声音样本`}
                  value={character.voiceReferenceVersionId ?? ''}
                  disabled={!writable}
                  onChange={(event) =>
                    update(character.characterDocumentId, {
                      voiceReferenceVersionId: event.target.value || undefined,
                    })
                  }
                >
                  <option value="">不使用声音参考</option>
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
              {!voice && <small>可在角色资料中导入声音样本。</small>}
              {voice && voice.versionId === character.voiceReferenceVersionId && (
                <AudioPreview projectId={projectId} audioId={voice.audioId} />
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
            </article>
          );
        })}
      </div>
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
      <p>完整对白用于支持音频驱动的模型；声音样本用于参考音色。可在场次配音中导入或制作对白。</p>
      <AudioPreview projectId={projectId} audioId={dialogueAudioId} />
    </section>
  );
}
