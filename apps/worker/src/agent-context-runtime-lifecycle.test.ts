import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import type { LlmGenerationRuntimeRequest, LlmToolDefinition } from '@ai-video/contracts';
import { AgentContextStore } from '@ai-video/persistence';
import { ProjectService } from './project-service.js';
import { AgentContextManager } from './agent-context-manager.js';
import { PiConversationRuntime } from './pi-conversation-runtime.js';
import type { AgentProviderToolExecutor } from './agent-provider-tool-gateway.js';

it('keeps live Pi memory bounded across forty real tool rounds while archiving complete results', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-context-lifecycle-'));
  const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  try {
    const project = projects.create(join(directory, 'project'), 'Long runtime');
    const definition: LlmToolDefinition = {
      name: 'library.read',
      description: 'Read source',
      parameters: { type: 'object', properties: {}, additionalProperties: true },
      authorizationHandle: 'read',
    };
    const runtimeRequest: LlmGenerationRuntimeRequest = {
      generationId: 'g',
      attemptId: 'a',
      projectId: project.id,
      projectSessionId: projects.currentSessionId()!,
      conversationId: 'c',
      providerProfileId: 'p',
      modelId: 'm',
      remoteModelId: 'remote',
      protocol: 'openai-responses',
      baseUrl: 'https://mock.invalid/v1',
      systemInstruction: 'Policy',
      context: 'Metadata',
      prompt: '逐步检查来源',
      tools: [definition],
      modelCapabilities: {
        modelId: 'm',
        contextWindow: 128000,
        maxOutputTokens: 4096,
        capabilitySource: 'manual_config',
      },
    };
    const manager = new AgentContextManager(
      projects,
      runtimeRequest,
      'task',
      runtimeRequest.prompt,
    );
    const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
    faux.setResponses([
      ...Array.from({ length: 40 }, (_, i) =>
        fauxAssistantMessage(
          [fauxToolCall('library.read', { sourceId: `source-${i}` }, { id: `read-${i}` })],
          { stopReason: 'toolUse', responseId: `response-${i}` },
        ),
      ),
      fauxAssistantMessage('Done'),
    ]);
    const generation = {
      runtime: vi.fn(() => runtimeRequest),
      configureAgentTools: vi.fn(),
      observe: vi.fn(),
      complete: vi.fn(),
      failNative: vi.fn(),
      cancel: vi.fn(),
      get: vi.fn(() => ({ status: 'complete' })),
    };
    const executeTools = vi.fn<AgentProviderToolExecutor['executeTools']>((params) =>
      Promise.resolve({
        continuation: {
          protocol: 'openai-responses',
          previousResponseId: params.providerResponseId,
          outputs: params.calls.map((call) => ({
            callId: call.id,
            output: JSON.stringify({
              status: 'read',
              sourceId: (JSON.parse(call.argumentsJson) as { sourceId: string }).sourceId,
              versionId: 'v1',
              content: `完整正文-${call.id}`,
            }),
          })),
        },
        tools: [definition],
      }),
    );
    const providerTools = {
      executeTools,
      confirmTool: vi.fn(),
      selectMedia: vi.fn(),
      startProviderStep: vi.fn(),
      completeProviderStep: vi.fn(),
      terminateGeneration: vi.fn(() => 1),
    };
    const snapshots = vi.spyOn(manager, 'snapshot');
    const projectionSizes: number[] = [];
    const projectHistory = manager.compactHistory.bind(manager);
    vi.spyOn(manager, 'compactHistory').mockImplementation((context) => {
      const messages = projectHistory(context);
      projectionSizes.push(messages.length);
      return messages;
    });
    const wireCounts: number[] = [];
    const runtime = new PiConversationRuntime({
      generation: generation as never,
      plans: {} as never,
      providerTools,
      streamFn: (model, context, options) => {
        wireCounts.push(context.messages.length);
        return faux.streamSimple(model, context, options);
      },
      createGateway: () => {
        throw new Error('No fixed plan');
      },
      createContextManager: () => manager,
    });
    await runtime.start({
      ...runtimeRequest,
      identity: runtimeRequest,
      taskId: 'task',
      mode: 'document',
      prompt: runtimeRequest.prompt,
    });
    await runtime.wait('g');
    expect(faux.state.callCount).toBe(41);
    expect(generation.complete).toHaveBeenCalledOnce();
    expect(generation.failNative).not.toHaveBeenCalled();
    expect(Math.max(...snapshots.mock.calls.map((c) => c[1].messages.length))).toBeLessThanOrEqual(
      34,
    );
    expect(Math.max(...projectionSizes)).toBeLessThanOrEqual(32);
    expect(Math.max(...wireCounts)).toBeLessThanOrEqual(32);
    expect(
      projects
        .access(false, (db) => new AgentContextStore(db).resultRefs(project.id, 'task'))
        .filter((r) => r.toolName === 'library.read'),
    ).toHaveLength(40);
    const restored = new AgentContextManager(
      projects,
      runtimeRequest,
      'task',
      runtimeRequest.prompt,
    ).recovery()!;
    expect(restored.messages.length).toBeLessThanOrEqual(32);
  } finally {
    projects.close();
    await rm(directory, { recursive: true });
  }
}, 30000);

it.each([false, true])(
  'preserves executing/queued task checkpoints and terminal cancellation across shutdown (cancel=%s)',
  async (cancel) => {
    const directory = await mkdtemp(join(tmpdir(), 'pi-suspend-recovery-'));
    const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
    try {
      const project = projects.create(join(directory, 'project'), 'Suspension');
      const definition: LlmToolDefinition = {
        name: 'library.read',
        description: 'Read source',
        authorizationHandle: 'read',
        parameters: { type: 'object', properties: {}, additionalProperties: true },
      };
      let current: LlmGenerationRuntimeRequest = {
        generationId: 'g',
        attemptId: 'a',
        projectId: project.id,
        projectSessionId: projects.currentSessionId()!,
        conversationId: 'c',
        providerProfileId: 'p',
        modelId: 'm',
        remoteModelId: 'remote',
        protocol: 'openai-responses',
        baseUrl: 'https://mock.invalid/v1',
        systemInstruction: 'Policy',
        context: '',
        prompt: '保留用户要求，读取资料后完成',
        tools: [definition],
      };
      const managers = new Map<string, AgentContextManager>();
      let cancelled = false;
      const generation = {
        runtime: vi.fn((identity: { generationId: string }) => ({
          ...current,
          generationId: identity.generationId,
        })),
        waitUntilReady: vi.fn(async (identity: { generationId: string }, signal: AbortSignal) => {
          if (identity.generationId === 'queued')
            await new Promise<void>((_, reject) =>
              signal.addEventListener('abort', () => reject(new Error('Worker stopped waiting.')), {
                once: true,
              }),
            );
        }),
        configureAgentTools: vi.fn(),
        observe: vi.fn(),
        complete: vi.fn(),
        failNative: vi.fn(),
        cancel: vi.fn(() => {
          cancelled = true;
          return Promise.resolve();
        }),
        get: vi.fn((id: string) => ({
          status: id === 'g' && cancelled ? 'cancelled' : 'streaming',
        })),
      };
      let releaseTool!: () => void;
      const toolGate = new Promise<void>((resolve) => {
        releaseTool = resolve;
      });
      let startedTool!: () => void;
      const toolStarted = new Promise<void>((resolve) => {
        startedTool = resolve;
      });
      const executeTools = vi.fn<AgentProviderToolExecutor['executeTools']>(async (params) => {
        startedTool();
        await toolGate;
        return {
          continuation: {
            protocol: 'openai-responses',
            previousResponseId: params.providerResponseId,
            outputs: params.calls.map((call) => ({
              callId: call.id,
              output: JSON.stringify({
                sourceId: 'source',
                versionId: 'v1',
                content: '工具在暂停后完成的完整结果',
              }),
            })),
          },
          tools: [definition],
        };
      });
      const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('library.read', {}, { id: 'read' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('恢复后完成'),
      ]);
      const options = {
        generation: generation as never,
        plans: {} as never,
        providerTools: {
          executeTools,
          confirmTool: vi.fn(),
          selectMedia: vi.fn(),
          startProviderStep: vi.fn(),
          completeProviderStep: vi.fn(),
          terminateGeneration: vi.fn(() => 1),
        },
        streamFn: faux.streamSimple,
        createGateway: () => {
          throw new Error('No fixed plan');
        },
        createContextManager: (
          identity: { generationId: string },
          taskId: string,
          prompt: string,
        ) => {
          const manager = new AgentContextManager(
            projects,
            { ...current, generationId: identity.generationId },
            taskId,
            prompt,
          );
          managers.set(taskId, manager);
          return manager;
        },
      };
      const runtime = new PiConversationRuntime(options);
      const request = (generationId: string) => ({
        ...current,
        identity: { ...current, generationId },
        taskId: generationId,
        mode: 'document' as const,
        prompt: current.prompt,
      });
      await runtime.start(request('g'));
      await toolStarted;
      await runtime.start(request('queued'));
      if (cancel) runtime.cancel('g');
      runtime.suspendAll('host_shutdown');
      await expect(runtime.start(request('rejected'))).rejects.toThrow('WORKER_STOPPING');
      releaseTool();
      await runtime.drain();
      expect(generation.cancel).toHaveBeenCalledTimes(cancel ? 1 : 0);
      expect(generation.failNative).not.toHaveBeenCalled();
      expect(generation.complete).not.toHaveBeenCalled();
      expect(faux.state.callCount).toBe(1);
      for (const task of cancel ? ['queued'] : ['g', 'queued']) {
        expect(managers.get(task)!.taskState.executionStatus).toBe('recovering');
        expect(managers.get(task)!.taskState.recoveryState?.stopReason).toBe('host_shutdown');
      }
      expect(
        projects.access(false, (db) =>
          new AgentContextStore(db).resultForCall(project.id, 'g', 'read'),
        )?.content,
      ).toContain('工具在暂停后完成的完整结果');
      if (cancel) {
        expect(managers.get('g')!.taskState.executionStatus).toBe('cancelled');
        expect(
          projects
            .access(false, (db) => new AgentContextStore(db).recoverable(project.id))
            .map((task) => task.taskId),
        ).not.toContain('g');
        return;
      }
      projects.close();
      projects.open(project.rootPath);
      current = { ...current, projectSessionId: projects.currentSessionId()! };
      const resumed = new PiConversationRuntime(options);
      await resumed.start(request('g'));
      await resumed.wait('g');
      expect(executeTools).toHaveBeenCalledOnce();
      expect(generation.complete).toHaveBeenCalledOnce();
      expect(managers.get('g')!.taskState.userRequirements.map((r) => r.text)).toContain(
        current.prompt,
      );
      expect(managers.get('g')!.taskState.executionStatus).toBe('completed');
    } finally {
      projects.close();
      await rm(directory, { recursive: true });
    }
  },
  20000,
);
