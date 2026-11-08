import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { LoaderCircle, Pause, Plus, Volume2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CharacterVoiceReferenceInfo } from '@ai-video/contracts';
import { projectWorker } from '../worker-scope';
import { useDubbingMedia } from './media';
import './dubbing.css';

export function VoiceReferencePanel(props: {
  projectId: string;
  characterDocumentId: string;
  writable: boolean;
}) {
  return (
    <VoiceReferenceEditor key={`${props.projectId}:${props.characterDocumentId}`} {...props} />
  );
}

function VoiceReferenceEditor({
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
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    setReference(undefined);
    setLoading(true);
    setMessage('');
    const refresh = () => {
      void callWorker('characterVoiceReference.list', {})
        .then((references) => {
          if (!active.current) return;
          setReference(
            references.find((value) => value.characterDocumentId === characterDocumentId),
          );
        })
        .catch((error: unknown) => {
          if (active.current)
            setMessage(error instanceof Error ? error.message : '角色声音读取失败。');
        })
        .finally(() => {
          if (active.current) setLoading(false);
        });
    };
    const refreshForCharacter = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string; characterDocumentId?: string }>)
        .detail;
      if (
        (!detail?.projectId || detail.projectId === projectId) &&
        (!detail?.characterDocumentId || detail.characterDocumentId === characterDocumentId)
      )
        refresh();
    };
    refresh();
    window.addEventListener('character-voice-profile-updated', refreshForCharacter);
    window.addEventListener('character-voice-reference-updated', refreshForCharacter);
    return () => {
      active.current = false;
      window.removeEventListener('character-voice-profile-updated', refreshForCharacter);
      window.removeEventListener('character-voice-reference-updated', refreshForCharacter);
    };
  }, [projectId, characterDocumentId]);
  const importSample = async () => {
    if (!writable || busy || loading) return;
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
          new CustomEvent('character-voice-reference-updated', {
            detail: { projectId, characterDocumentId },
          }),
        );
      }
    } catch (error) {
      if (active.current) setMessage(error instanceof Error ? error.message : '样本保存失败。');
    } finally {
      if (active.current) setBusy(false);
    }
  };
  return (
    <section className="character-audio" aria-label="角色音频">
      <div className="character-audio-items">
        <button
          className="button secondary"
          type="button"
          disabled={!writable || busy || loading}
          onClick={() => void importSample()}
        >
          <Plus size={14} aria-hidden="true" />
          {busy ? '正在添加…' : '添加音频'}
        </button>
        {reference && (
          <VoiceReferencePreview
            key={reference.versionId}
            projectId={projectId}
            reference={reference}
          />
        )}
      </div>
      {message && <p role="status">{message}</p>}
    </section>
  );
}

function VoiceReferencePreview({
  projectId,
  reference,
}: {
  projectId: string;
  reference: CharacterVoiceReferenceInfo;
}) {
  const [requested, setRequested] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [message, setMessage] = useState('');
  const audioRef = useRef<HTMLAudioElement>(null);
  const media = useDubbingMedia(projectId, requested ? reference.audioId : undefined, true);
  const loading = requested && !media;

  useEffect(() => {
    const audio = audioRef.current;
    if (!media?.src || !audio) return;
    let active = true;
    void audio.play().catch(() => {
      if (active) setMessage('音频暂时无法播放，请重试。');
    });
    return () => {
      active = false;
      audio.pause();
    };
  }, [media?.src]);

  const togglePlayback = () => {
    setMessage('');
    if (!requested) {
      setRequested(true);
      return;
    }
    const audio = audioRef.current;
    if (!audio || !media?.src) return;
    if (audio.paused) {
      void audio.play().catch(() => setMessage('音频暂时无法播放，请重试。'));
    } else {
      audio.pause();
    }
  };

  return (
    <>
      <button
        className={`character-audio-preview${playing ? ' is-playing' : ''}`}
        type="button"
        aria-label={`${playing ? '暂停试听' : '试听'} ${reference.audioName}`}
        aria-pressed={playing}
        aria-busy={loading}
        title={`${reference.audioName} · ${(reference.durationMs / 1000).toFixed(1)} 秒`}
        disabled={loading}
        onClick={togglePlayback}
      >
        {loading ? (
          <LoaderCircle size={20} aria-hidden="true" />
        ) : playing ? (
          <Pause size={20} aria-hidden="true" />
        ) : (
          <Volume2 size={20} aria-hidden="true" />
        )}
      </button>
      <audio
        ref={audioRef}
        hidden
        preload="none"
        src={media?.src}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onError={() => {
          setPlaying(false);
          setMessage('音频暂时无法播放，请重试。');
        }}
      />
      {(message || media?.error) && <p role="status">{message || media?.error}</p>}
    </>
  );
}
