import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type {
  LlmToolDefinition,
  NativeProviderHostEvent,
  NativeProviderStreamStartParams,
} from '@ai-video/contracts';
import { ContentService } from './content-service.js';
import { ContextService } from './context-service.js';
import { GenerationService } from './generation-service.js';
import { ProjectService } from './project-service.js';
import { PiConversationRuntime } from './pi-conversation-runtime.js';
import { NativeProviderBridge } from './native-provider-bridge.js';
import type { AgentProviderToolExecutor } from './agent-provider-tool-gateway.js';

const supplementalInputs = ['仅补充：保留蓝色衣服。', '对白保持原文。', '仅补充：保留蓝色衣服。'];

describe('Pi native continuation', () => {
  it.each(['openai-responses', 'openai-chat-completions'] as const)(
    'retains three complete sources above the soft threshold through tool loading and image preparation (%s)',
    async (protocol) => {
      const directory = await mkdtemp(join(tmpdir(), 'pi-three-source-reuse-'));
      const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
      try {
        projects.create(join(directory, 'project'), 'Three sources');
        const content = new ContentService(projects);
        const conversation = content.createConversation({ scopeType: 'project' });
        const generations = new GenerationService(
          projects,
          content,
          new ContextService(projects),
          {
            status: () => ({ key: 'test', name: 'Test', model: 'test', configured: false }),
            stream: () => Promise.reject(new Error('No external requests')),
          },
          {
            selectionResolver: {
              resolveLlmSelection: () => ({
                providerProfileId: 'profile',
                providerName: 'Test',
                modelId: 'model',
                modelName: 'Test',
                remoteModelId: 'mock',
                protocol,
                baseUrl: 'https://example.invalid/v1',
              }),
            },
          },
        );
        const prepared = generations.prepare({
          conversationId: conversation.id,
          prompt: 'u'.repeat(70000),
          providerProfileId: 'profile',
          modelId: 'model',
        });
        const definitions: LlmToolDefinition[] = ['library.read', 'media.image.prepare'].map(
          (name) => ({
            name,
            description: name === 'library.read' ? 't'.repeat(16000) : 'Prepare an image intent',
            parameters: { type: 'object', properties: {}, additionalProperties: true },
            authorizationHandle: 'worker-only',
          }),
        );
        generations.configureAgentTools(prepared.stream, definitions);
        const bodies = [5918, 6109, 4703].map((length, i) =>
          `资料${i}正文`.repeat(length).slice(0, length),
        );
        const requests: NativeProviderStreamStartParams[] = [];
        const bridge = new NativeProviderBridge({
          send(envelope) {
            if (envelope.method !== 'provider.stream.start') return Promise.resolve();
            const params = envelope.params as NativeProviderStreamStartParams;
            const index = requests.push(structuredClone(params)) - 1;
            const common = { projectSessionId: prepared.stream.projectSessionId };
            const calls =
              index === 0
                ? bodies.map((_, i) => ({
                    id: `source-${i}`,
                    name: 'library.read',
                    argumentsJson: JSON.stringify({ sourceHandle: `h${i}` }),
                  }))
                : index === 1
                  ? [
                      {
                        id: 'load-images',
                        name: 'tools.load',
                        argumentsJson: '{"names":["media.image.prepare"]}',
                      },
                    ]
                  : index < 5
                    ? [
                        {
                          id: `image-${index - 2}`,
                          name: 'media.image.prepare',
                          argumentsJson: JSON.stringify({ prompt: bodies[index - 2] }),
                        },
                      ]
                    : [];
            const events: NativeProviderHostEvent[] = calls.length
              ? [
                  ...calls.map((call) => ({ ...common, type: 'tool_call_end' as const, call })),
                  {
                    ...common,
                    type: 'complete',
                    providerResponseId: `r${index}`,
                    finishReason: 'tool_calls',
                  },
                ]
              : [
                  { ...common, type: 'text_delta', delta: '三个图片制作意图已准备。' },
                  {
                    ...common,
                    type: 'complete',
                    providerResponseId: 'final',
                    finishReason: 'stop',
                  },
                ];
            events.forEach((event, sequence) =>
              bridge.handleEnvelope({
                kind: 'host.event',
                requestId: envelope.requestId,
                sequence,
                event,
              }),
            );
            return Promise.resolve();
          },
        });
        const providerTools = {
          startProviderStep: vi.fn(),
          completeProviderStep: vi.fn(),
          terminateGeneration: vi.fn(() => 0),
          confirmTool: vi.fn(),
          selectMedia: vi.fn(),
          executeTools: vi.fn<AgentProviderToolExecutor['executeTools']>((params) =>
            Promise.resolve({
              tools: definitions,
              continuation: {
                protocol: 'openai-responses',
                previousResponseId: params.providerResponseId,
                outputs: params.calls.map((call) => ({
                  callId: call.id,
                  output: JSON.stringify(
                    call.name === 'library.read'
                      ? {
                          status: 'read',
                          sourceId: call.id,
                          versionId: 'v1',
                          sourceType: 'document',
                          sourceStatus: 'draft',
                          readMode: 'source',
                          startOffset: 0,
                          endOffset: bodies[Number(call.id.slice(-1))]!.length,
                          truncated: false,
                          content: bodies[Number(call.id.slice(-1))],
                        }
                      : { status: 'prepared', preparationId: call.id },
                  ),
                })),
              },
            }),
          ),
        } satisfies AgentProviderToolExecutor;
        const runtime = new PiConversationRuntime({
          generation: generations,
          providerTools,
          bridge,
          plans: {} as never,
          createGateway: () => {
            throw new Error('No planning');
          },
        });
        await runtime.start({
          ...prepared.stream,
          identity: prepared.stream,
          taskId: 'three-source-task',
          mode: 'document',
          prompt: '使用三份资料分别准备图片',
        });
        await runtime.wait(prepared.stream.generationId);
        const result = generations.get(prepared.stream.generationId);
        expect(result.status, result.error).toBe('complete');
        expect(requests).toHaveLength(6);
        const calls = providerTools.executeTools.mock.calls.flatMap(([params]) => params.calls);
        expect(calls.filter((call) => call.name === 'library.read')).toHaveLength(3);
        expect(calls.filter((call) => call.name === 'media.image.prepare')).toHaveLength(3);
        const accounting = result.assistantMessage.attempt!.accounting!;
        expect(accounting.requests[1]!.context!.estimatedInputTokens).toBeGreaterThan(44800 * 0.8);
        expect(
          accounting.requests.every((request) => request.context?.compactionCount === 0),
          JSON.stringify(accounting.requests.map((request) => request.context)),
        ).toBe(true);
        for (const body of bodies) expect(JSON.stringify(requests[1])).toContain(body);
        expect(JSON.stringify(requests)).not.toContain('reread_required');
        if (protocol === 'openai-chat-completions')
          for (const body of bodies) expect(JSON.stringify(requests.at(-1))).toContain(body);
        else
          expect(
            requests
              .slice(1)
              .every((request) => request.continuation?.protocol === 'openai-responses'),
          ).toBe(true);
      } finally {
        projects.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(
    (['openai-responses', 'openai-chat-completions'] as const).flatMap((protocol) => [
      { protocol, adaptiveOutput: false, declaredOutput: false },
      { protocol, adaptiveOutput: true, declaredOutput: true },
      { protocol, adaptiveOutput: true, declaredOutput: false },
    ]),
  )(
    'dispatches $protocol with full long input and three images (adaptiveOutput=$adaptiveOutput, declaredOutput=$declaredOutput)',
    async ({ protocol, adaptiveOutput, declaredOutput }) => {
      const directory = await mkdtemp(join(tmpdir(), 'pi-visual-budget-'));
      const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
      try {
        projects.create(join(directory, 'project'), 'Visual budget test');
        const content = new ContentService(projects);
        const conversation = content.createConversation({ scopeType: 'project' });
        const generations = new GenerationService(
          projects,
          content,
          new ContextService(projects),
          {
            status: () => ({ key: 'test', name: 'Test', model: 'test', configured: false }),
            stream: () => Promise.reject(new Error('No external requests in this test')),
          },
          {
            selectionResolver: {
              resolveLlmSelection: () => ({
                providerProfileId: 'profile',
                providerName: 'Test',
                modelId: 'model',
                modelName: 'Test model',
                remoteModelId: 'test-model',
                protocol,
                baseUrl: 'https://example.invalid/v1',
                ...(declaredOutput
                  ? {
                      inferenceSettings: {
                        maxOutputTokens: 16000,
                        outputTokenParameter:
                          protocol === 'openai-responses'
                            ? ('max_output_tokens' as const)
                            : ('max_tokens' as const),
                        reasoning: 'provider_default' as const,
                      },
                    }
                  : {}),
              }),
            },
          },
        );
        const prepared = generations.prepare({
          conversationId: conversation.id,
          prompt: 'u'.repeat(adaptiveOutput ? 68544 : 26544),
          providerProfileId: 'profile',
          modelId: 'model',
        });
        const definitions: LlmToolDefinition[] = [
          {
            name: 'library.read',
            description: 't'.repeat(17900),
            parameters: { type: 'object', additionalProperties: true, properties: {} },
            authorizationHandle: 'worker-only',
          },
        ];
        generations.configureAgentTools(prepared.stream, definitions);
        const initial = generations.runtime(prepared.stream);
        const images = Array.from({ length: 3 }, (_, index) => ({
          mimeType: 'image/png',
          data: Buffer.from(`image-${index}`).toString('base64'),
        }));
        const referenceText = 'Reference state. '.repeat(1800);
        const requests: NativeProviderStreamStartParams[] = [];
        const bridge = new NativeProviderBridge({
          send(envelope) {
            if (envelope.method !== 'provider.stream.start') return Promise.resolve();
            const params = envelope.params as NativeProviderStreamStartParams;
            requests.push(structuredClone(params));
            const common = { projectSessionId: prepared.stream.projectSessionId };
            const events: NativeProviderHostEvent[] =
              requests.length === 1
                ? [
                    {
                      ...common,
                      type: 'tool_call_end',
                      call: {
                        id: 'visual-read',
                        name: 'library.read',
                        argumentsJson: '{"sourceHandle":"confirmed-source"}',
                      },
                    },
                    {
                      ...common,
                      type: 'complete',
                      providerResponseId: 'visual-read-response',
                      finishReason: 'tool_calls',
                    },
                  ]
                : [
                    { ...common, type: 'text_delta', delta: '已核对三张参考图。' },
                    {
                      ...common,
                      type: 'complete',
                      providerResponseId: 'visual-final-response',
                      finishReason: 'stop',
                    },
                  ];
            events.forEach((event, sequence) =>
              bridge.handleEnvelope({
                kind: 'host.event',
                requestId: envelope.requestId,
                sequence,
                event,
              }),
            );
            return Promise.resolve();
          },
        });
        const providerTools = {
          reserveTurn: vi.fn(),
          startProviderStep: vi.fn(),
          completeProviderStep: vi.fn(),
          terminateGeneration: vi.fn(() => 0),
          confirmTool: vi.fn(),
          selectMedia: vi.fn(),
          executeTools: vi.fn<AgentProviderToolExecutor['executeTools']>((params) =>
            Promise.resolve({
              tools: definitions,
              continuation: {
                protocol: 'openai-responses' as const,
                previousResponseId: params.providerResponseId,
                outputs: params.calls.map((call) => ({
                  callId: call.id,
                  output: JSON.stringify({
                    status: 'read',
                    sourceId: 'reference-source',
                    versionId: 'v1',
                    content: referenceText,
                  }),
                  images,
                })),
              },
            }),
          ),
        } satisfies AgentProviderToolExecutor;
        const runtime = new PiConversationRuntime({
          generation: generations,
          plans: {} as never,
          bridge,
          providerTools,
          createGateway: () => {
            throw new Error('Unexpected planning');
          },
        });
        await runtime.start({
          ...prepared.stream,
          identity: prepared.stream,
          taskId: 'visual-budget-task',
          mode: 'document',
          prompt: initial.prompt,
        });
        await runtime.wait(prepared.stream.generationId);
        const result = generations.get(prepared.stream.generationId);
        expect(result.status, result.error).toBe('complete');
        expect(requests).toHaveLength(2);
        expect(requests[1]!.prompt).toBe(initial.prompt);
        expect(requests[1]!.continuation!.outputs[0]!.images).toEqual(images);
        expect(requests[1]!.continuation!.outputs[0]!.output).toContain(referenceText);
        expect(result.assistantMessage.attempt!.accounting!.requests.at(-1)!.context).toMatchObject(
          {
            contextWindowTokens: 512000,
            windowSource: 'fallback',
            limitEnforcement: 'advisory_fallback',
            compactionCount: 0,
            estimatedInputTokens: expect.any(Number) as number,
          },
        );
        const context = result.assistantMessage.attempt!.accounting!.requests.at(-1)!.context!;
        if (adaptiveOutput) {
          expect(context.estimatedInputTokens).toBeGreaterThan(44800);
          expect(requests[1]!.inferenceSettings!.maxOutputTokens).toBe(
            declaredOutput ? 16000 : 16384,
          );
          expect(requests[1]!.inferenceSettings!.maxOutputTokens).toBe(
            context.reservedOutputTokens,
          );
          expect(requests[1]!.inferenceSettings!.outputTokenParameter).toBe(
            protocol === 'openai-responses' ? 'max_output_tokens' : 'max_tokens',
          );
          expect(requests[1]!.inferenceSettings!.reasoning).toBe('provider_default');
        } else expect(context.estimatedInputTokens).toBeLessThan(44800);
      } finally {
        projects.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each([
    {
      protocol: 'openai-chat-completions',
      responseIds: true,
      failRead: false,
      outcome: 'recovered',
      supplementMode: 'none',
    },
    {
      protocol: 'openai-responses',
      responseIds: true,
      failRead: false,
      outcome: 'recovered',
      supplementMode: 'none',
    },
    {
      protocol: 'openai-chat-completions',
      responseIds: true,
      failRead: false,
      outcome: 'complete',
      supplementMode: 'none',
    },
    {
      protocol: 'openai-chat-completions',
      responseIds: false,
      failRead: false,
      outcome: 'complete',
      supplementMode: 'none',
    },
    {
      protocol: 'openai-chat-completions',
      responseIds: true,
      failRead: true,
      outcome: 'complete',
      supplementMode: 'none',
    },
    {
      protocol: 'openai-responses',
      responseIds: true,
      failRead: false,
      outcome: 'complete',
      supplementMode: 'none',
    },
    {
      protocol: 'openai-chat-completions',
      responseIds: true,
      failRead: false,
      outcome: 'failed',
      supplementMode: 'none',
    },
    {
      protocol: 'openai-responses',
      responseIds: true,
      failRead: false,
      outcome: 'cancelled',
      supplementMode: 'none',
    },
    {
      protocol: 'openai-chat-completions',
      responseIds: true,
      failRead: false,
      outcome: 'missing',
      supplementMode: 'none',
    },
    {
      protocol: 'openai-chat-completions',
      responseIds: true,
      failRead: false,
      outcome: 'complete',
      supplementMode: 'tool',
    },
    {
      protocol: 'openai-responses',
      responseIds: true,
      failRead: false,
      outcome: 'complete',
      supplementMode: 'tool',
    },
    {
      protocol: 'openai-chat-completions',
      responseIds: true,
      failRead: false,
      outcome: 'complete',
      supplementMode: 'text',
    },
    {
      protocol: 'openai-responses',
      responseIds: true,
      failRead: false,
      outcome: 'complete',
      supplementMode: 'text',
    },
    {
      protocol: 'openai-responses',
      responseIds: false,
      failRead: false,
      outcome: 'failed',
      supplementMode: 'text',
    },
  ] as const)(
    'preserves context and request usage: $protocol, IDs=$responseIds, error=$failRead, $outcome, supplement=$supplementMode',
    async ({ protocol, responseIds, failRead, outcome, supplementMode }) => {
      const directory = await mkdtemp(join(tmpdir(), 'pi-native-continuation-'));
      const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
      try {
        projects.create(join(directory, 'project'), 'Continuation test');
        const content = new ContentService(projects);
        const conversation = content.createConversation({ scopeType: 'project' });
        const indexLlmAttempt = vi.fn();
        const generations = new GenerationService(
          projects,
          content,
          new ContextService(projects),
          {
            status: () => ({ key: 'test', name: 'Test', model: 'test', configured: false }),
            stream: () => Promise.reject(new Error('No external requests in this test')),
          },
          {
            usageIndexer: { indexLlmAttempt },
            selectionResolver: {
              resolveLlmSelection: () => ({
                providerProfileId: 'profile',
                providerName: 'Test',
                modelId: 'model',
                modelName: 'Test model',
                remoteModelId: 'test-model',
                protocol,
                baseUrl: 'https://example.invalid/v1',
                pricingSnapshot: {
                  currency: 'USD',
                  unitTokens: 1000,
                  inputPrice: '1',
                  cachedInputPrice: '0.1',
                  outputPrice: '2',
                  configuredAt: '2026-10-20T00:00:00.000Z',
                },
              }),
            },
          },
        );
        const prepared = generations.prepare({
          conversationId: conversation.id,
          prompt: 'Summarize the sources.',
          providerProfileId: 'profile',
          modelId: 'model',
        });
        const definitions: LlmToolDefinition[] = ['library.search', 'library.read'].map((name) => ({
          name,
          description: name,
          parameters: { type: 'object', additionalProperties: true, properties: {} },
          authorizationHandle: 'worker-only',
        }));
        generations.configureAgentTools(prepared.stream, definitions);
        const initial = generations.runtime(prepared.stream);
        const requests: NativeProviderStreamStartParams[] = [];
        const bridge = new NativeProviderBridge({
          send(envelope) {
            if (envelope.method !== 'provider.stream.start') return Promise.resolve();
            const params = envelope.params as NativeProviderStreamStartParams;
            requests.push(structuredClone(params));
            const attempt = requests.length;
            const ordinal = outcome === 'recovered' && attempt > 3 ? attempt - 1 : attempt;
            if (ordinal === 1 && supplementMode === 'text')
              supplementalInputs.forEach((input, index) =>
                generations.supplement(
                  prepared.stream.generationId,
                  input,
                  `supplement-text-${index}`,
                ),
              );
            let sequence = 0;
            const emit = (event: NativeProviderHostEvent) => {
              bridge.handleEnvelope({
                kind: 'host.event',
                requestId: envelope.requestId,
                sequence: sequence++,
                event,
              });
            };
            const session = { projectSessionId: prepared.stream.projectSessionId };
            emit({ type: 'started', ...session });
            if (outcome === 'recovered' && attempt === 3) {
              emit({
                type: 'failed',
                ...session,
                error: {
                  code: 'PROVIDER_FAILED',
                  message: 'Provider HTTP 500: Service Error',
                  retryable: true,
                  providerStatus: 500,
                },
              });
              return Promise.resolve();
            }
            if (outcome !== 'missing') {
              const usage = {
                inputTokens: ordinal * 100 - 1,
                cachedInputTokens: ordinal * 32,
                outputTokens: ordinal * 10,
                reasoningTokens: ordinal,
                totalTokens: ordinal * 110,
              };
              emit({ type: 'usage', usage, ...session });
              emit({ type: 'usage', usage, ...session });
              // Partial updates replace the same request's snapshot, even
              // without a response ID. Two tools in response one count once.
              emit({ type: 'usage', usage: { inputTokens: ordinal * 100 }, ...session });
            }
            emit({
              type: 'text_delta',
              delta:
                ordinal === 1
                  ? 'Search the sources.'
                  : ordinal === 2
                    ? 'Read chapter one.'
                    : 'Done.',
              ...session,
            });
            const calls =
              ordinal === 1 && supplementMode !== 'text'
                ? [
                    {
                      id: 'search-a',
                      name: 'library.search',
                      argumentsJson: '{"query":"chapter"}',
                    },
                    {
                      id: 'search-b',
                      name: 'library.search',
                      argumentsJson: '{"query":"outline"}',
                    },
                  ]
                : ordinal === 2
                  ? [
                      {
                        id: 'read-a',
                        name: 'library.read',
                        argumentsJson: '{"sourceHandle":"chapter-handle"}',
                      },
                    ]
                  : [];
            for (const call of calls) emit({ type: 'tool_call_end', call, ...session });
            if (ordinal === 3 && outcome === 'failed') {
              emit({
                type: 'failed',
                error: {
                  code: 'PROVIDER_FAILED',
                  message: 'Test interrupted stream',
                  retryable: true,
                },
                ...session,
              });
              return Promise.resolve();
            }
            if (ordinal === 3 && outcome === 'cancelled') {
              void generations.cancel(prepared.stream.generationId);
              // Some providers report final usage while abort is in flight.
              emit({ type: 'usage', usage: { inputTokens: 301 }, ...session });
              emit({ type: 'cancelled', ...session });
              return Promise.resolve();
            }
            emit({
              type: 'complete',
              providerResponseId: responseIds ? `response-${ordinal}` : undefined,
              finishReason: calls.length ? 'tool_calls' : 'stop',
              ...session,
            });
            return Promise.resolve();
          },
        });
        const providerTools = {
          reserveTurn: vi.fn(),
          startProviderStep: vi.fn(),
          completeProviderStep: vi.fn(),
          terminateGeneration: vi.fn(() => 0),
          confirmTool: vi.fn(),
          selectMedia: vi.fn(),
          executeTools: vi.fn<AgentProviderToolExecutor['executeTools']>((params) => {
            if (supplementMode === 'tool' && params.calls[0]?.name === 'library.search')
              supplementalInputs.forEach((input, index) =>
                generations.supplement(
                  prepared.stream.generationId,
                  input,
                  `supplement-tool-${index}`,
                ),
              );
            if (failRead && params.calls[0]?.name === 'library.read') {
              return Promise.reject(new Error('Library source handle is invalid or expired.'));
            }
            return Promise.resolve({
              tools: definitions,
              continuation: {
                protocol: 'openai-responses' as const,
                previousResponseId: params.providerResponseId,
                outputs: params.calls.map((call) => ({
                  callId: call.id,
                  output: JSON.stringify({ status: 'succeeded', result: `资料:${call.id}` }),
                })),
              },
            });
          }),
        } satisfies AgentProviderToolExecutor;
        const runtime = new PiConversationRuntime({
          generation: generations,
          plans: {} as never,
          bridge,
          providerTools,
          createGateway: () => {
            throw new Error('Unexpected planning');
          },
        });
        await runtime.start({
          ...prepared.stream,
          identity: prepared.stream,
          taskId: 'task',
          mode: 'document',
          prompt: initial.prompt,
        });
        await runtime.wait(prepared.stream.generationId);

        const expectedStatus = ['complete', 'missing', 'recovered'].includes(outcome)
          ? 'complete'
          : outcome;
        const result = generations.get(prepared.stream.generationId);
        expect(result.status).toBe(expectedStatus);
        if (protocol === 'openai-responses' && !responseIds) {
          expect(requests).toHaveLength(1);
          expect(JSON.stringify(result)).toContain('requires a Provider response ID');
          expect(providerTools.executeTools).not.toHaveBeenCalled();
          expect(
            content
              .listMessages({ conversationId: conversation.id })
              .items.filter((message) => message.role === 'user')
              .map((message) => message.content)
              .sort(),
          ).toEqual([initial.prompt, ...supplementalInputs].sort());
          return;
        }
        const expectedUsage = {
          inputTokens: outcome === 'cancelled' ? 601 : 600,
          cachedInputTokens: 192,
          outputTokens: 60,
          reasoningTokens: 6,
          totalTokens: 660,
        };
        if (outcome === 'missing') {
          expect(result.assistantMessage.attempt?.usage).toBeUndefined();
          expect(result.assistantMessage.attempt?.estimatedCost).toBeUndefined();
        } else {
          const estimatedCost = outcome === 'cancelled' ? '0.5482' : '0.5472';
          expect(result.assistantMessage.attempt).toMatchObject({
            usage: expectedUsage,
            estimatedCost,
          });
          expect(indexLlmAttempt.mock.lastCall?.[1]).toMatchObject({
            ...expectedUsage,
            status: expectedStatus,
            estimatedCost,
          });
          expect(
            content
              .listMessages({ conversationId: conversation.id })
              .items.find((message) => message.id === result.assistantMessage.id)?.attempt,
          ).toMatchObject({ usage: expectedUsage, estimatedCost });
        }
        expect(requests).toHaveLength(outcome === 'recovered' ? 4 : 3);
        expect(providerTools.reserveTurn).toHaveBeenCalledTimes(requests.length);
        if (outcome === 'recovered') {
          expect(requests[3]).toEqual(requests[2]);
          expect(result.assistantMessage.attempt?.accounting?.requests).toHaveLength(4);
          expect(
            result.assistantMessage.attempt?.accounting?.requests.filter(
              (request) => request.stage === 'failed',
            ),
          ).toHaveLength(1);
        }
        expect(providerTools.executeTools).toHaveBeenCalledTimes(supplementMode === 'text' ? 1 : 3);
        for (const request of requests) {
          expect(request.systemInstruction).toBe(requests[0]?.systemInstruction);
          expect(request.systemInstruction).toContain('unified project Agent');
          expect(request.systemInstruction).toContain('# Agent project library policy');
          expect(request.systemInstruction).not.toContain('[FROZEN PROJECT CONTEXT]');
          expect(request.context).toBe(initial.context);
          expect(request.prompt).toBe(initial.prompt);
          expect(JSON.stringify(request)).not.toContain('worker-only');
        }
        expect(requests[0]?.continuation).toBeUndefined();
        if (supplementMode !== 'none') {
          expect(initial.prompt).not.toContain('仅补充：保留蓝色衣服。');
          const afterSupplement = requests[1]!.continuation!;
          if (afterSupplement.protocol === 'openai-responses') {
            expect(afterSupplement.userMessages).toEqual(supplementalInputs);
          } else {
            expect(afterSupplement.userMessages).toEqual(supplementalInputs);
            if (supplementMode === 'text') {
              expect(afterSupplement.calls).toEqual([]);
              expect(afterSupplement.outputs).toEqual([]);
            }
          }
        }
        const continuation = requests[2]!.continuation!;
        if (continuation.protocol === 'openai-chat-completions') {
          expect(continuation.history).toEqual(
            supplementMode === 'text'
              ? [
                  {
                    content: 'Search the sources.',
                    calls: [],
                    outputs: [],
                    userMessages: supplementalInputs,
                  },
                ]
              : [
                  {
                    content: 'Search the sources.',
                    calls: [
                      {
                        id: 'search-a',
                        name: 'library.search',
                        argumentsJson: '{"query":"chapter"}',
                      },
                      {
                        id: 'search-b',
                        name: 'library.search',
                        argumentsJson: '{"query":"outline"}',
                      },
                    ],
                    outputs: [
                      {
                        callId: 'search-a',
                        output: '{"status":"succeeded","result":"资料:search-a"}',
                      },
                      {
                        callId: 'search-b',
                        output: '{"status":"succeeded","result":"资料:search-b"}',
                      },
                    ],
                    ...(supplementMode === 'tool' ? { userMessages: supplementalInputs } : {}),
                  },
                ],
          );
          expect(continuation.content).toBe('Read chapter one.');
          expect(continuation.calls.map((call) => call.id)).toEqual(['read-a']);
          expect(continuation.outputs[0]?.output).toContain(
            failRead ? 'Library source handle is invalid or expired.' : '资料:read-a',
          );
          expect(continuation.userMessages).toBeUndefined();
        } else {
          expect(continuation.previousResponseId).toBe('response-2');
          expect(continuation.outputs.map((output) => output.callId)).toEqual(['read-a']);
          expect(continuation).not.toHaveProperty('history');
          expect(continuation.userMessages).toBeUndefined();
        }
      } finally {
        projects.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
