import { useEffect, useRef } from 'react';
import type { DocumentDetail } from '@ai-video/contracts';
import { useProjectViewState } from './use-project-view-state';
import { isCurrentWorkerScope, projectWorker, workerScope } from './worker-scope';

export function useCharacterVoicePrompt({
  characterId,
  voiceDocumentId,
  versionId,
  writable,
}: {
  characterId?: string;
  voiceDocumentId?: string;
  versionId?: string;
  writable: boolean;
}) {
  const scope = workerScope();
  const callWorker = projectWorker(scope);
  const key =
    characterId && voiceDocumentId
      ? `${scope?.projectId ?? ''}:${scope?.projectSessionId ?? ''}:${characterId}:${voiceDocumentId}`
      : '';
  const [reload, setReload] = useProjectViewState(0);
  const [draft, setDraft] = useProjectViewState<{
    key: string;
    document: DocumentDetail;
    content: string;
    sampleText: string;
  }>();
  const [load, setLoad] = useProjectViewState({ key: '', loading: false, error: '' });
  const current = draft?.key === key ? draft : undefined;
  const dirty = Boolean(
    current &&
    (current.content !== (current.document.currentVersion?.contentMarkdown ?? '') ||
      current.sampleText !== (current.document.currentVersion?.sampleText ?? '')),
  );
  const state = useRef({ key, dirty });
  state.current = { key, dirty };
  useEffect(() => {
    let active = true;
    if (!key || !voiceDocumentId) {
      setDraft(undefined);
      setLoad({ key, loading: false, error: '' });
      return;
    }
    if (state.current.dirty) return;
    setLoad({ key, loading: true, error: '' });
    void callWorker('document.get', { documentId: voiceDocumentId })
      .then((document) => {
        if (!active || !isCurrentWorkerScope(scope)) return;
        if (
          document.id !== voiceDocumentId ||
          document.kind !== 'voice' ||
          document.lifecycleStatus !== 'active' ||
          (scope && document.projectId !== scope.projectId)
        )
          throw new Error('绑定的音色提示词已不可用，请重新选择。');
        setDraft({
          key,
          document,
          content: document.currentVersion?.contentMarkdown ?? '',
          sampleText: document.currentVersion?.sampleText ?? '',
        });
        setLoad({ key, loading: false, error: '' });
      })
      .catch((reason) => {
        if (!active || !isCurrentWorkerScope(scope)) return;
        setDraft(undefined);
        setLoad({
          key,
          loading: false,
          error: reason instanceof Error ? reason.message : '音色提示词加载失败',
        });
      });
    return () => {
      active = false;
    };
  }, [key, versionId, reload, scope?.projectId, scope?.projectSessionId]);

  const reset = () => {
    setDraft((value) =>
      value
        ? {
            ...value,
            content: value.document.currentVersion?.contentMarkdown ?? '',
            sampleText: value.document.currentVersion?.sampleText ?? '',
          }
        : undefined,
    );
  };
  const editable =
    writable &&
    Boolean(current) &&
    !current?.document.publishedVersionId &&
    ['draft', 'changes_requested'].includes(current?.document.currentVersion?.state ?? 'draft');
  const loading = Boolean(key && (load.key !== key || load.loading));
  const save = async () => {
    if (!current || !dirty) return;
    if (!editable || loading) throw new Error('当前音色提示词不可编辑，请先处理文档状态。');
    const document = await callWorker('document.draft.save', {
      documentId: current.document.id,
      kind: 'voice',
      title: current.document.title,
      contentMarkdown: current.content,
      sampleText: current.sampleText,
      bindings: current.document.currentVersion?.bindings,
      expectedDocumentRowVersion: current.document.rowVersion,
    });
    if (isCurrentWorkerScope(scope) && state.current.key === key)
      setDraft((value) => (value?.key === key ? { ...value, document } : value));
    return document;
  };
  return {
    document: current?.document,
    content: current?.content ?? '',
    sampleText: current?.sampleText ?? '',
    loading,
    error: load.key === key ? load.error : '',
    writable: editable && !loading,
    dirty,
    setContent: (content: string) =>
      setDraft((value) => (value?.key === key ? { ...value, content } : value)),
    setSampleText: (sampleText: string) =>
      setDraft((value) => (value?.key === key ? { ...value, sampleText } : value)),
    save,
    reset,
    retry: () => setReload((value) => value + 1),
  };
}
