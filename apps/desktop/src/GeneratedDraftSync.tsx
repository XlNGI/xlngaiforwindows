import { useEffect, useRef, useState } from 'react';
import type { AgentChangeSetInfo } from '@ai-video/contracts';
import { projectWorker } from './worker-scope';

interface GeneratedDraftSyncProps {
  projectId?: string;
  writable: boolean;
  refreshRevision?: number;
  onSaved?: (changeSet: AgentChangeSetInfo) => void | Promise<void>;
}

/** Bring proposals from older versions into the editable directory without an approval step. */
export function GeneratedDraftSync({
  projectId,
  writable,
  refreshRevision,
  onSaved,
}: GeneratedDraftSyncProps) {
  const [message, setMessage] = useState('');
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  // Share in-flight writes across effect refreshes so a proposal is never applied twice.
  const saves = useRef(new Map<string, Promise<AgentChangeSetInfo>>());

  useEffect(() => {
    let current = true;
    setMessage('');
    if (!projectId || !writable) return;
    const callWorker = projectWorker();
    const sync = async () => {
      const proposals = await callWorker('agent.changeSet.list', { includeTerminal: false });
      for (const proposal of [...proposals].reverse()) {
        if (!current) return;
        if (!proposal.items.some((item) => item.status === 'pending')) continue;
        const key = `${projectId}:${proposal.id}:${proposal.rowVersion}`;
        let saving = saves.current.get(key);
        if (!saving) {
          saving = callWorker('agent.changeSet.apply', {
            changeSetId: proposal.id,
            expectedRowVersion: proposal.rowVersion,
          }).catch((error) => {
            saves.current.delete(key);
            throw error;
          });
          saves.current.set(key, saving);
        }
        const saved = await saving;
        if (!current) return;
        if (saved.status === 'conflicted') {
          setMessage('部分生成内容与当前版本冲突，已保留原内容。请让助手读取最新内容后重新生成。');
        } else if (saved.items.some((item) => item.status === 'applied')) {
          await onSavedRef.current?.(saved);
        }
      }
    };
    void sync().catch((error) => {
      if (current) setMessage(error instanceof Error ? error.message : '生成内容保存失败');
    });
    return () => {
      current = false;
    };
  }, [projectId, writable, refreshRevision]);

  return message ? (
    <p className="inline-status" role="status">
      {message}
    </p>
  ) : null;
}
