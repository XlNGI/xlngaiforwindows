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
  it.each([
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
            const ordinal = requests.length;
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

        const expectedStatus = ['complete', 'missing'].includes(outcome) ? 'complete' : outcome;
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
        expect(requests).toHaveLength(3);
        expect(providerTools.executeTools).toHaveBeenCalledTimes(supplementMode === 'text' ? 1 : 3);
        for (const request of requests) {
          expect(request.systemInstruction).toBe(requests[0]?.systemInstruction);
          expect(request.systemInstruction).toContain('unified project Agent');
          expect(request.systemInstruction).toContain('# Agent project library policy');
          expect(request.systemInstruction).toContain(initial.context);
          expect(request.context).toBe('');
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
