import { useEffect, useRef, useState } from 'react';
import type { ProviderProfileInfo, VoiceProfileInfo } from '@ai-video/contracts';
import { callWorker } from '../worker-client';
import './dubbing.css';

export function VoiceProfilePanel(props: {
  projectId: string;
  characterDocumentId?: string;
  writable: boolean;
  onSaved?: () => void;
}) {
  return (
    <VoiceProfileEditor
      key={`${props.projectId}:${props.characterDocumentId ?? 'narration'}`}
      {...props}
    />
  );
}

function VoiceProfileEditor({
  projectId,
  characterDocumentId,
  writable,
  onSaved,
}: {
  projectId: string;
  characterDocumentId?: string;
  writable: boolean;
  onSaved?: () => void;
}) {
  const active = useRef(true);
  const [profile, setProfile] = useState<VoiceProfileInfo>();
  const [providers, setProviders] = useState<ProviderProfileInfo[]>([]);
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('speech-2.8-hd');
  const [voiceId, setVoiceId] = useState('');
  const [speed, setSpeed] = useState(1);
  const [pitch, setPitch] = useState(0);
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState('');

  useEffect(() => {
    active.current = true;
    void Promise.resolve()
      .then(() =>
        Promise.all([
          callWorker('characterVoice.list', {}),
          callWorker('provider.profile.list', {}),
        ]),
      )
      .then(([voices, connections]) => {
        if (!active.current) return;
        const available = connections.filter(
          (item) => item.providerType === 'minimax-speech' && item.enabled && !item.archivedAt,
        );
        setProviders(available);
        const saved = voices.find(
          (item) =>
            item.projectId === projectId && item.characterDocumentId === characterDocumentId,
        );
        setProfile(saved);
        setProviderId(saved?.providerProfileId ?? available[0]?.id ?? '');
        if (saved) {
          setModel(saved.model);
          setVoiceId(saved.voiceId);
          setSpeed(saved.speed);
          setPitch(saved.pitch);
        }
      })
      .catch((error: unknown) => {
        if (active.current) setMessage(error instanceof Error ? error.message : '声音读取失败。');
      })
      .finally(() => {
        if (active.current) setBusy(false);
      });
    return () => {
      active.current = false;
    };
  }, [projectId, characterDocumentId]);

  const save = async () => {
    if (!writable || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const saved = await callWorker('characterVoice.save', {
        id: profile?.id,
        characterDocumentId,
        providerProfileId: providerId,
        model,
        voiceId: voiceId.trim(),
        speed,
        pitch,
        expectedRowVersion: profile?.rowVersion,
      });
      if (!active.current) return;
      setProfile(saved);
      setMessage('声音已保存。可在场次配音中录入台词、试听并采用。');
      onSaved?.();
    } catch (error) {
      if (active.current) setMessage(error instanceof Error ? error.message : '保存声音失败。');
    } finally {
      if (active.current) setBusy(false);
    }
  };
  const selectedProvider = providers.find((item) => item.id === providerId);
  return (
    <section
      className="dubbing-panel voice-profile-panel"
      aria-label={characterDocumentId ? '角色声音' : '旁白声音'}
    >
      <div className="dubbing-heading">
        <div>
          <h2>{characterDocumentId ? '角色声音' : '旁白声音'}</h2>
          <p>固定音色供不同场次复用。修改设置会保存新版本，已制作的配音仍可保留。</p>
        </div>
        {profile ? <span className="dubbing-badge">声音版本 {profile.revision}</span> : null}
      </div>
      <fieldset className="dubbing-fields" disabled={!writable || busy}>
        <label>
          配音连接
          <select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
            <option value="">选择 MiniMax 配音连接</option>
            {profile && !providers.some((item) => item.id === profile.providerProfileId) ? (
              <option value={profile.providerProfileId}>原连接已停用</option>
            ) : null}
            {providers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.connectionStatus !== 'ready' ? '（待验证）' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          配音质量
          <select value={model} onChange={(event) => setModel(event.target.value)}>
            <option value="speech-2.8-hd">高清配音 · Speech 2.8 HD</option>
            <option value="speech-2.8-turbo">快速配音 · Speech 2.8 Turbo</option>
          </select>
        </label>
        <label>
          音色 ID
          <input
            value={voiceId}
            onChange={(event) => setVoiceId(event.target.value)}
            placeholder="填写账号可用的预设音色 ID"
          />
        </label>
        <label>
          语速
          <input
            type="number"
            min="0.5"
            max="2"
            step="0.05"
            value={speed}
            onChange={(event) => setSpeed(Number(event.target.value))}
          />
        </label>
        <label>
          音高
          <input
            type="number"
            min="-12"
            max="12"
            step="1"
            value={pitch}
            onChange={(event) => setPitch(Number(event.target.value))}
          />
        </label>
      </fieldset>
      {!providers.length && !busy ? (
        <p className="dubbing-note">请先在设置中添加 MiniMax 配音连接。密钥在连接设置中填写。</p>
      ) : null}
      {selectedProvider && selectedProvider.connectionStatus !== 'ready' ? (
        <p className="dubbing-note">可先保存声音；连接验证通过后再生成配音。</p>
      ) : null}
      <div className="dubbing-actions">
        <button
          className="button secondary"
          type="button"
          disabled={!writable || busy || !providerId || !voiceId.trim()}
          onClick={() => void save()}
        >
          {busy ? '正在读取…' : '保存声音'}
        </button>
      </div>
      {message ? (
        <p role="status" className="dubbing-note">
          {message}
        </p>
      ) : null}
    </section>
  );
}
