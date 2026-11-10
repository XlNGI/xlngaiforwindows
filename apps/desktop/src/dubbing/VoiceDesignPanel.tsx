import { useEffect, useRef, useState } from 'react';
import type {
  CharacterVoiceDesignConfirmResult,
  DocumentDetail,
  MediaSubmissionConfirmationRequest,
  ProviderModelInfo,
  ProviderProfileInfo,
} from '@ai-video/contracts';
import { projectWorker } from '../worker-scope';
import { useDubbingMedia } from './media';
import './dubbing.css';

export function VoiceDesignPanel({
  projectId,
  character,
  voiceDocumentId,
  writable,
  onClose,
  onRequestApproval,
}: {
  projectId: string;
  character: DocumentDetail;
  voiceDocumentId: string;
  writable: boolean;
  onClose: () => void;
  onRequestApproval: (confirmation: MediaSubmissionConfirmationRequest) => Promise<boolean>;
}) {
  const callWorker = projectWorker();
  const active = useRef(true);
  const allowed = useRef(writable);
  allowed.current = writable;
  const submitting = useRef(false);
  const [source, setSource] = useState<DocumentDetail>();
  const [providers, setProviders] = useState<ProviderProfileInfo[]>([]);
  const [models, setModels] = useState<ProviderModelInfo[]>([]);
  const [providerId, setProviderId] = useState('');
  const [modelId, setModelId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [result, setResult] =
    useState<Extract<CharacterVoiceDesignConfirmResult, { approved: true }>>();
  const media = useDubbingMedia(projectId, result?.audio.id, true);
  useEffect(() => {
    active.current = true;
    void Promise.all([
      callWorker('document.get', { documentId: voiceDocumentId }),
      callWorker('provider.profile.list', {}),
    ])
      .then(async ([document, connections]) => {
        if (!active.current) return;
        if (
          !document ||
          document.projectId !== projectId ||
          document.kind !== 'voice' ||
          document.lifecycleStatus !== 'active'
        )
          throw new Error('绑定的音色提示词不可用，请关闭后重新选择。');
        const available = connections.filter(
          (item) =>
            item.providerType === 'minimax-speech' &&
            item.protocol === 'minimax-speech' &&
            item.accessType === 'official' &&
            item.baseUrl === 'https://api.minimax.cn' &&
            item.enabled &&
            !item.archivedAt &&
            item.connectionStatus === 'ready',
        );
        const allModels = (
          await Promise.all(
            available.map((item) => callWorker('provider.model.list', { profileId: item.id })),
          )
        )
          .flat()
          .filter(
            (item) =>
              item.enabled &&
              !item.unavailableAt &&
              item.capabilities.speechSynthesis &&
              ['speech-2.8-hd', 'speech-2.8-turbo'].includes(item.remoteModelId),
          );
        if (!active.current) return;
        setSource(document);
        setProviders(available);
        setModels(allModels);
        const first = available.find((item) =>
          allModels.some((model) => model.providerProfileId === item.id),
        );
        setProviderId(first?.id ?? '');
        setModelId(
          allModels.find((item) => item.providerProfileId === first?.id)?.remoteModelId ?? '',
        );
      })
      .catch((error: unknown) => {
        if (active.current)
          setMessage(error instanceof Error ? error.message : '音色生成设置读取失败。');
      })
      .finally(() => {
        if (active.current) setLoading(false);
      });
    return () => {
      active.current = false;
    };
  }, [projectId, character.id, voiceDocumentId]);
  const prompt = source?.currentVersion?.contentMarkdown ?? '';
  const text = source?.currentVersion?.sampleText ?? '';
  const textInvalid = !prompt.trim() || !text.trim() || [...text].length > 500;
  const submit = async () => {
    if (
      !writable ||
      submitting.current ||
      loading ||
      result ||
      textInvalid ||
      !source?.currentVersionId ||
      !modelId
    )
      return;
    submitting.current = true;
    setBusy(true);
    setMessage('');
    try {
      const pending = await callWorker('characterVoiceDesign.prepare', {
        characterDocumentId: character.id,
        voiceDocumentId,
        expectedVoiceDocumentVersionId: source.currentVersionId,
        expectedCharacterRowVersion: character.rowVersion,
        providerProfileId: providerId,
        modelId: modelId as 'speech-2.8-hd' | 'speech-2.8-turbo',
      });
      const approved =
        active.current && allowed.current ? await onRequestApproval(pending.confirmation) : false;
      const generated = await callWorker('characterVoiceDesign.confirm', {
        confirmationToken: pending.confirmation.confirmationToken,
        approved: approved && active.current && allowed.current,
      });
      if (!active.current) return;
      if (generated.approved) {
        setResult(generated);
        setMessage('新音色已生成并保存为角色音频，可用于视频声音参考。');
        for (const name of ['character-voice-profile-updated', 'character-voice-reference-updated'])
          window.dispatchEvent(
            new CustomEvent(name, { detail: { projectId, characterDocumentId: character.id } }),
          );
      } else setMessage('已取消生成。');
    } catch (error) {
      if (active.current)
        setMessage(error instanceof Error ? error.message : '音色设计失败，请核对供应商结果。');
    } finally {
      submitting.current = false;
      if (active.current) setBusy(false);
    }
  };
  return (
    <section
      className="voice-design-panel"
      aria-label="按提示词设计新音色"
      aria-busy={loading || busy}
    >
      <h3>按提示词设计新音色</h3>
      <p>角色：{character.title}</p>
      {loading ? (
        <p role="status">正在读取音色生成设置…</p>
      ) : (
        <>
          <p className="workspace-hint">
            使用下方已保存的描述生成角色音频，成功后可试听，并用于视频生成时的角色声音参考。
          </p>
          <p>
            <strong>音色描述</strong>
          </p>
          <p className="voice-design-source">{prompt}</p>
          <p>
            <strong>试音文本（{[...text].length}/500）</strong>
          </p>
          <p className="voice-design-source">{text}</p>
          {textInvalid && <p role="alert">请关闭此面板，填写音色描述和不超过 500 字的试音文本。</p>}
          <label className="title-field">
            音色设计连接
            <select
              aria-label="音色设计连接"
              value={providerId}
              disabled={busy || !!result || !writable}
              onChange={(event) => {
                setProviderId(event.target.value);
                setModelId(
                  models.find((item) => item.providerProfileId === event.target.value)
                    ?.remoteModelId ?? '',
                );
              }}
            >
              <option value="">请选择 MiniMax 官方连接</option>
              {providers.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <label className="title-field">
            后续配音模型
            <select
              aria-label="后续配音模型"
              value={modelId}
              disabled={busy || !!result || !writable}
              onChange={(event) => setModelId(event.target.value)}
            >
              <option value="">请选择模型</option>
              {models
                .filter((item) => item.providerProfileId === providerId)
                .map((item) => (
                  <option key={item.id} value={item.remoteModelId}>
                    {item.displayName}
                  </option>
                ))}
            </select>
          </label>
          {!modelId && (
            <p className="workspace-hint">
              请在设置中配置并测试 MiniMax 官方语音连接，启用 Speech 2.8 HD 或 Turbo 模型。
            </p>
          )}
        </>
      )}
      {message && <p role="status">{message}</p>}
      {result && (
        <>
          <p>
            新音色 ID：<code>{result.voiceProfile.voiceId}</code>
          </p>
          {media?.src && <audio aria-label="新音色试听" controls src={media.src} />}
          {media?.error && <p role="alert">{media.error}</p>}
        </>
      )}
      <div className="workspace-section-heading">
        <button
          type="button"
          className="button primary"
          disabled={
            !writable || loading || busy || !!result || textInvalid || !providerId || !modelId
          }
          onClick={() => void submit()}
        >
          {busy ? '正在生成音色…' : '确认生成新音色'}
        </button>
        <button type="button" className="button secondary" disabled={busy} onClick={onClose}>
          关闭音色生成
        </button>
      </div>
    </section>
  );
}
