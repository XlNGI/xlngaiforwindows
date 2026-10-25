import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DetachedPanelEnvelope, DetachedPanelSnapshot } from './detached-window';
import { DetachedPanelApp } from './DetachedPanelApp';
import { callWorker } from '../worker-client';
import type { AgentInputForm, AgentTaskDetail } from '@ai-video/contracts';

vi.mock('../worker-client', () => ({ callWorker: vi.fn() }));

const eventApi = vi.hoisted(() => ({
  emitTo: vi.fn().mockResolvedValue(undefined),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  listen: vi.fn((event: string, handler: (event: { payload: unknown }) => void) => {
    eventApi.listeners.set(event, handler);
    return Promise.resolve(() => eventApi.listeners.delete(event));
  }),
}));

const windowApi = vi.hoisted(() => ({ close: vi.fn().mockResolvedValue(undefined) }));

vi.mock('@tauri-apps/api/event', () => ({
  emitTo: eventApi.emitTo,
  listen: eventApi.listen,
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => windowApi,
}));

describe('DetachedPanelApp', () => {
  it.each([false, true])(
    'waits for the main window to accept question continuation and surfaces failure (failed=%s)',
    async (failed) => {
      const form: AgentInputForm = {
        id: 'form',
        taskId: 'task',
        conversationId: 'conversation',
        key: 'style',
        title: '确认方向',
        createdAt: 'now',
        status: 'pending',
        questions: [{ id: 'style', type: 'text', prompt: '画面风格' }],
      };
      let saved = form;
      vi.mocked(callWorker).mockImplementation(((
        method: string,
        params: { answers?: AgentInputForm['answers'] },
      ) => {
        if (method === 'media.review.list') return Promise.resolve([]);
        if (method === 'agent.input.get') return Promise.resolve(saved);
        saved = { ...form, status: 'answered', answers: params.answers };
        return Promise.resolve({
          form: saved,
          prompt: '已回答',
          idempotencyKey: 'question-answer:form',
        });
      }) as typeof callWorker);
      const config = {
        panelId: 'conversation' as const,
        projectId: 'project',
        entityId: 'conversation',
        label: 'workspace-conversation-project-conversation',
        sessionId: 'detached',
      };
      const conversation = {
        id: 'conversation',
        projectId: 'project',
        scopeType: 'project' as const,
        title: '短剧设计',
        createdAt: 'now',
        updatedAt: 'now',
      };
      const user = {
        id: 'user',
        conversationId: 'conversation',
        role: 'user' as const,
        content: '设计短剧',
        status: 'complete' as const,
        createdAt: 'now',
      };
      const assistant = {
        ...user,
        id: 'assistant',
        replyToMessageId: user.id,
        role: 'assistant' as const,
        content: '确认方向',
      };
      const task: AgentTaskDetail = {
        task: {
          id: 'task',
          projectId: 'project',
          conversationId: 'conversation',
          userMessageId: user.id,
          title: '短剧设计',
          taskType: 'document-query',
          scopeType: 'project',
          status: 'completed',
          phase: 'model_running',
          rowVersion: 1,
          createdAt: 'now',
          updatedAt: 'now',
        },
        events: [
          {
            id: 'event',
            taskId: 'task',
            sequence: 0,
            eventType: 'agent.user_input.requested',
            summary: form.title,
            createdAt: 'now',
            level: 'info',
            userInput: form,
          },
        ],
        documents: [],
        providerSteps: [],
        researchSources: [],
      };
      const snapshot: DetachedPanelSnapshot = {
        panelId: 'conversation',
        projectId: 'project',
        projectName: 'Project',
        scopeType: 'project',
        scopeAvailable: true,
        writable: true,
        conversations: [conversation],
        conversation,
        messages: [user, assistant],
        agentTasks: [task],
        composer: '未发送草稿',
        statusMessage: '',
        legacyLlmConfigured: false,
        llmProfiles: [],
        llmModels: [],
        selectedLlmProfileId: '',
        selectedLlmModelId: '',
      };
      const mounted = render(<DetachedPanelApp config={config} />);
      act(() => {
        eventApi.listeners.get('workspace-panel-snapshot')?.({
          payload: {
            label: config.label,
            projectId: 'project',
            entityId: 'conversation',
            sequence: 1,
            payload: snapshot,
          },
        });
      });
      fireEvent.change(await screen.findByLabelText('画面风格：补充回答'), {
        target: { value: '二维动画' },
      });
      fireEvent.click(screen.getByRole('button', { name: '提交回答并继续' }));
      await waitFor(() =>
        expect(
          eventApi.emitTo.mock.calls.some(
            (call) =>
              call[1] === 'workspace-panel-action' &&
              (call[2] as { payload: { type: string } }).payload.type ===
                'conversation-answer-questions',
          ),
        ).toBe(true),
      );
      const envelope = eventApi.emitTo.mock.calls
        .filter((call) => call[1] === 'workspace-panel-action')
        .at(-1)![2] as { payload: { requestId: string } };
      expect(screen.getByRole('button', { name: '正在提交…' })).toBeDisabled();
      act(() => {
        if (!failed) saved = { ...saved, continuationGenerationId: 'generation' };
        eventApi.listeners.get('workspace-question-result')?.({
          payload: {
            requestId: envelope.payload.requestId,
            ...(failed ? { error: '原会话已切换' } : {}),
          },
        });
      });
      if (failed) {
        expect(await screen.findByRole('alert')).toHaveTextContent('原会话已切换');
        expect(screen.getByRole('button', { name: '继续处理' })).toBeEnabled();
      } else
        await waitFor(() =>
          expect(screen.queryByRole('button', { name: '正在提交…' })).not.toBeInTheDocument(),
        );
      expect(screen.getByRole('textbox', { name: '会话消息' })).toHaveValue('未发送草稿');
      mounted.unmount();
    },
  );

  it('renders a document snapshot and forwards edits and reattach actions to main', async () => {
    render(
      <DetachedPanelApp
        config={{
          panelId: 'document',
          projectId: 'project',
          entityId: 'document',
          label: 'workspace-document-project-document',
          sessionId: 'workspace-document-project-document',
        }}
      />,
    );

    await waitFor(() =>
      expect(eventApi.emitTo).toHaveBeenCalledWith(
        'main',
        'workspace-panel-ready',
        expect.anything(),
      ),
    );
    const snapshot: DetachedPanelSnapshot = {
      panelId: 'document',
      projectId: 'project',
      projectName: 'Project',
      documentId: 'document',
      title: 'Outline',
      kind: 'outline',
      content: '# Draft',
      state: 'draft',
      writable: true,
      busy: false,
      statusMessage: '',
      versions: [
        {
          id: 'version-1',
          documentId: 'document',
          version: 1,
          contentMarkdown: '# Draft',
          state: 'draft',
          titleSnapshot: 'Outline',
          authorType: 'user',
          createdAt: 'now',
        },
      ],
      currentVersionId: 'version-1',
      rowVersion: 1,
    };
    const envelope: DetachedPanelEnvelope<DetachedPanelSnapshot> = {
      label: 'workspace-document-project-document',
      payload: snapshot,
    };
    act(() => {
      eventApi.listeners.get('workspace-panel-snapshot')?.({ payload: envelope });
    });

    fireEvent.click(screen.getByRole('button', { name: '保存并发布' }));
    expect(eventApi.emitTo).toHaveBeenCalledWith('main', 'workspace-panel-action', {
      label: 'workspace-document-project-document',
      projectId: 'project',
      entityId: 'document',
      sequence: 1,
      payload: { panelId: 'document', type: 'document-save-publish' },
    });

    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    expect(eventApi.emitTo).toHaveBeenCalledWith('main', 'workspace-panel-action', {
      label: 'workspace-document-project-document',
      projectId: 'project',
      entityId: 'document',
      sequence: 2,
      payload: { panelId: 'document', type: 'document-save' },
    });

    fireEvent.change(screen.getByDisplayValue('Outline'), { target: { value: 'Outline 2' } });
    expect(eventApi.emitTo).toHaveBeenCalledWith('main', 'workspace-panel-action', {
      label: 'workspace-document-project-document',
      projectId: 'project',
      entityId: 'document',
      sequence: 3,
      payload: { panelId: 'document', type: 'document-title', value: 'Outline 2' },
    });
    expect(screen.queryByLabelText('类型')).not.toBeInTheDocument();

    // A busy panel blocks both save paths instead of queueing a second write.
    act(() => {
      eventApi.listeners.get('workspace-panel-snapshot')?.({
        payload: { ...envelope, sequence: 2, payload: { ...snapshot, busy: true } },
      });
    });
    expect(screen.getByRole('button', { name: '保存并发布' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '保存草稿' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '附加' }));
    expect(eventApi.emitTo).toHaveBeenCalledWith('main', 'workspace-panel-action', {
      label: 'workspace-document-project-document',
      projectId: 'project',
      entityId: 'document',
      sequence: 4,
      payload: { panelId: 'document', type: 'attach' },
    });
    expect(windowApi.close).toHaveBeenCalledOnce();
  });

  it('ignores stale or mismatched snapshots from another detached session', async () => {
    const config = {
      panelId: 'document' as const,
      projectId: 'project',
      entityId: 'document',
      label: 'workspace-document-project-document',
      sessionId: 'workspace-document-project-document',
    };
    render(<DetachedPanelApp config={config} />);
    const listener = eventApi.listeners.get('workspace-panel-snapshot');
    const snapshot: DetachedPanelSnapshot = {
      panelId: 'document',
      projectId: 'project',
      projectName: 'Project',
      documentId: 'document',
      title: 'Current title',
      kind: 'note',
      content: 'Current body',
      state: 'draft',
      writable: true,
      busy: false,
      statusMessage: '',
      versions: [],
      rowVersion: 1,
    };

    act(() => {
      listener?.({
        payload: {
          label: config.label,
          projectId: config.projectId,
          entityId: config.entityId,
          sequence: 4,
          payload: snapshot,
        },
      });
    });
    expect(await screen.findByDisplayValue('Current title')).toBeInTheDocument();

    act(() => {
      listener?.({
        payload: {
          label: config.label,
          projectId: config.projectId,
          entityId: config.entityId,
          sequence: 3,
          payload: { ...snapshot, title: 'Old title' },
        },
      });
      listener?.({
        payload: {
          label: config.label,
          projectId: config.projectId,
          entityId: 'other-document',
          sequence: 5,
          payload: { ...snapshot, documentId: 'other-document', title: 'Other title' },
        },
      });
    });

    expect(screen.getByDisplayValue('Current title')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Old title')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('Other title')).not.toBeInTheDocument();
  });
});
