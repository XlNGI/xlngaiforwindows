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

describe('Pi native continuation', () => {
  it.each([
    { protocol: 'openai-chat-completions', responseIds: true, failRead: false },
    { protocol: 'openai-chat-completions', responseIds: false, failRead: false },
    { protocol: 'openai-chat-completions', responseIds: true, failRead: true },
    { protocol: 'openai-responses', responseIds: true, failRead: false },
  ] as const)(
    'preserves tool context through the real bridge: $protocol, IDs=$responseIds, error=$failRead',
    async ({ protocol, responseIds, failRead }) => {
      const directory = await mkdtemp(join(tmpdir(), 'pi-native-continuation-'));
      const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
      try {
        projects.create(join(directory, 'project'), 'Continuation test');
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
              ordinal === 1
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

        expect(generations.get(prepared.stream.generationId).status).toBe('complete');
        expect(requests).toHaveLength(3);
        expect(providerTools.executeTools).toHaveBeenCalledTimes(3);
        for (const request of requests) {
          expect(request.systemInstruction).toContain('unified project Agent');
          expect(request.systemInstruction).toContain('# Agent project library policy');
          expect(request.systemInstruction).toContain(initial.context);
          expect(request.context).toBe('');
          expect(request.prompt).toBe(initial.prompt);
          expect(JSON.stringify(request)).not.toContain('worker-only');
        }
        expect(requests[0]?.continuation).toBeUndefined();
        const continuation = requests[2]!.continuation!;
        if (continuation.protocol === 'openai-chat-completions') {
          expect(continuation.history).toEqual([
            {
              content: 'Search the sources.',
              calls: [
                { id: 'search-a', name: 'library.search', argumentsJson: '{"query":"chapter"}' },
                { id: 'search-b', name: 'library.search', argumentsJson: '{"query":"outline"}' },
              ],
              outputs: [
                { callId: 'search-a', output: '{"status":"succeeded","result":"资料:search-a"}' },
                { callId: 'search-b', output: '{"status":"succeeded","result":"资料:search-b"}' },
              ],
            },
          ]);
          expect(continuation.content).toBe('Read chapter one.');
          expect(continuation.calls.map((call) => call.id)).toEqual(['read-a']);
          expect(continuation.outputs[0]?.output).toContain(
            failRead ? 'Library source handle is invalid or expired.' : '资料:read-a',
          );
        } else {
          expect(continuation.previousResponseId).toBe('response-2');
          expect(continuation.outputs.map((output) => output.callId)).toEqual(['read-a']);
          expect(continuation).not.toHaveProperty('history');
        }
      } finally {
        projects.close();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
