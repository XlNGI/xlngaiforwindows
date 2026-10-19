import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useEffect, useRef, useState } from 'react';
import type { CharacterVoiceReferenceInfo } from '@ai-video/contracts';
import { projectWorker } from '../worker-scope';
import { useDubbingMedia } from './media';

export function VoiceReferencePanel({
  projectId,
  characterDocumentId,
  writable,
}: {
  projectId: string;
  characterDocumentId: string;
  writable: boolean;
}) {
  const callWorker = projectWorker();
  const [reference, setReference] = useState<CharacterVoiceReferenceInfo>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    setReference(undefined);
    void Promise.resolve()
      .then(() => callWorker('characterVoiceReference.list', {}))
      .then((values) => {
        if (active.current)
          setReference(values.find((value) => value.characterDocumentId === characterDocumentId));
      })
      .catch(() => undefined);
    return () => {
      active.current = false;
    };
  }, [projectId, characterDocumentId]);
  const media = useDubbingMedia(projectId, reference?.audioId, true);
  const importSample = async () => {
    if (!writable || busy) return;
    if (!('__TAURI_INTERNALS__' in window)) {
      setMessage('请在 Windows 桌面应用中导入本地声音样本。');
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const path = await openDialog({
        multiple: false,
        filters: [{ name: '声音样本', extensions: ['wav', 'mp3'] }],
      });
      if (typeof path !== 'string' || !active.current) return;
      const imported = await callWorker('audio.import', { sourcePath: path, kind: 'reference' });
      if (!active.current) return;
      const saved = await callWorker('characterVoiceReference.save', {
        characterDocumentId,
        audioId: imported.audio.id,
        expectedRowVersion: reference?.rowVersion ?? 0,
      });
      if (active.current) {
        setReference(saved);
        window.dispatchEvent(
          new CustomEvent('character-voice-reference-updated', { detail: { projectId } }),
        );
        setMessage('角色声音样本已保存，制作视频时可选择复用。');
      }
    } catch (error) {
      if (active.current) setMessage(error instanceof Error ? error.message : '样本保存失败。');
    } finally {
      if (active.current) setBusy(false);
    }
  };
  return (
    <section className="dubbing-panel">
      <h2>视频声音样本</h2>
      <p>
        保存清晰的单人 WAV／MP3 录音，供万相、Seedance 和 MiniMax
        视频模型参考。样本保存在当前项目，确认生成后才发送给所选供应商。
      </p>
      {reference && (
        <>
          <p>
            {reference.audioName} · {(reference.durationMs / 1000).toFixed(1)} 秒 · 声音版本{' '}
            {reference.revision}
          </p>
          {media?.src && <audio controls src={media.src} />}
        </>
      )}
      <button
        className="button secondary"
        type="button"
        disabled={!writable || busy}
        onClick={() => void importSample()}
      >
        {busy ? '正在导入…' : reference ? '更换声音样本' : '导入声音样本'}
      </button>
      {message && <p role="status">{message}</p>}
    </section>
  );
}
