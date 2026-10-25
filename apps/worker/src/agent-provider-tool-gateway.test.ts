import { describe, expect, it, vi } from 'vitest';
import type {
  AgentGenerationExecuteToolsResult,
  LlmGenerationIdentity,
  LlmToolDefinition,
} from '@ai-video/contracts';
import { VIDEO_PROMPT_AUTHORING_REQUIREMENTS } from '@ai-video/contracts';
import {
  AgentProviderToolGateway,
  type AgentProviderToolExecutor,
} from './agent-provider-tool-gateway.js';
import {
  DOCUMENT_AGENT_TOOLS,
  SYSTEM_AGENT_TOOLS,
  LIBRARY_AGENT_TOOLS,
  MEDIA_AGENT_TOOLS,
  RESEARCH_AGENT_TOOLS,
} from './agent-tool-definitions.js';
import { PRODUCTION_AUTHORING_GUIDANCE } from './production-authoring-guidance.js';

const identity: LlmGenerationIdentity = {
  generationId: 'generation',
  attemptId: 'attempt',
  projectId: 'project',
  projectSessionId: 'session',
  conversationId: 'conversation',
};

function definition(
  name: LlmToolDefinition['name'] = 'document.create_draft',
  authorizationHandle = 'worker-only-handle',
): LlmToolDefinition {
  return {
    name,
    description: name,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { title: { type: 'string' } },
    },
    authorizationHandle,
  };
}

function executor(
  executeResult: AgentGenerationExecuteToolsResult,
  confirmResult: AgentGenerationExecuteToolsResult = executeResult,
  mediaResult: AgentGenerationExecuteToolsResult = executeResult,
) {
  return {
    executeTools: vi.fn<AgentProviderToolExecutor['executeTools']>(() =>
      Promise.resolve(executeResult),
    ),
    confirmTool: vi.fn<AgentProviderToolExecutor['confirmTool']>(() => confirmResult),
    selectMedia: vi.fn<AgentProviderToolExecutor['selectMedia']>(() =>
      Promise.resolve(mediaResult),
    ),
    startProviderStep: vi.fn<AgentProviderToolExecutor['startProviderStep']>(),
    completeProviderStep: vi.fn<AgentProviderToolExecutor['completeProviderStep']>(),
    terminateGeneration: vi.fn<AgentProviderToolExecutor['terminateGeneration']>(() => 1),
  } satisfies AgentProviderToolExecutor;
}

describe('AgentProviderToolGateway', () => {
  it('exposes prompt revisions and explicit scene scope without accepting shot scope fields', async () => {
    const original = SYSTEM_AGENT_TOOLS.find((tool) => tool.name === 'scene.update_shot_prompts')!;
    const worker = executor({
      continuation: {
        protocol: 'openai-responses',
        previousResponseId: 'prompts',
        outputs: [{ callId: 'save-prompts', output: '{"status":"shot_prompts_saved"}' }],
      },
    });
    const gateway = new AgentProviderToolGateway(
      worker,
      identity,
      [{ ...original, authorizationHandle: 'prompt-auth' }],
      vi.fn(),
      vi.fn(),
    );
    const tool = gateway.tools().find((entry) => entry.name === original.name)!;
    const args = {
      shots: [
        {
          shotId: 'shot-1',
          expectedRowVersion: 1,
          authoringIR: {
            schemaVersion: 1,
            kind: 'shot',
            prompt: '固定机位，无配乐。',
            data: { custom: '补充资料' },
          },
        },
      ],
    };
    expect(tool.prepareArguments!(args)).toEqual(args);
    expect(() =>
      tool.prepareArguments!({
        shots: [
          {
            ...args.shots[0],
            authoringIR: { ...args.shots[0]!.authoringIR, promptScope: 'complete' },
          },
        ],
      }),
    ).toThrow();
    gateway.captureProviderCall('save-prompts', 'prompts');
    await tool.execute('save-prompts', args);
    expect(worker.executeTools).toHaveBeenCalledWith(
      expect.objectContaining({
        calls: [
          expect.objectContaining({
            name: original.name,
            authorizationHandle: 'prompt-auth',
            argumentsJson: JSON.stringify(args),
          }),
        ],
      }),
    );
  });
  it('exposes the real timing patch to Pi with bounded schema and shared format guidance', async () => {
    const args = {
      shots: Array.from({ length: 15 }, (_, i) => ({
        shotId: `shot-${i}`,
        expectedRowVersion: 1,
        estimatedDurationSeconds: 5,
        rationale: '动作和停顿',
      })),
    };
    const worker = executor({
      continuation: {
        protocol: 'openai-responses',
        previousResponseId: 'timing',
        outputs: [
          {
            callId: 'save-times',
            output: JSON.stringify({ status: 'shot_timings_saved', changedCount: 15 }),
          },
        ],
      },
    });
    const schema = SYSTEM_AGENT_TOOLS.find((tool) => tool.name === 'scene.update_shot_timings')!;
    const gateway = new AgentProviderToolGateway(
      worker,
      identity,
      [{ ...schema, authorizationHandle: 'timing-authorization' }],
      vi.fn(),
      vi.fn(),
    );
    const tool = gateway.tools().find((item) => item.name === schema.name)!;
    expect(schema.description).toContain('ProductionAuthoringIR=');
    expect(schema.description).toContain('scene.submit_structure.shots creates NEW shots');
    expect(tool.prepareArguments!(args)).toEqual(args);
    expect(() =>
      tool.prepareArguments!({ shots: [{ ...args.shots[0], estimatedDurationSeconds: 0 }] }),
    ).toThrow();
    expect(() =>
      tool.prepareArguments!({ shots: [{ ...args.shots[0], prompt: '覆盖正文' }] }),
    ).toThrow();
    gateway.captureProviderCall('save-times', 'timing');
    await tool.execute('save-times', args);
    expect(worker.executeTools).toHaveBeenCalledWith(
      expect.objectContaining({
        calls: [
          expect.objectContaining({
            name: schema.name,
            argumentsJson: JSON.stringify(args),
            authorizationHandle: 'timing-authorization',
          }),
        ],
      }),
    );
  });

  it('names unsupported envelope fields without values, preserves open IR data and narrows shot batches', () => {
    const worker = executor({});
    const original = SYSTEM_AGENT_TOOLS.find((tool) => tool.name === 'scene.structure.stage')!;
    const gateway = new AgentProviderToolGateway(worker, identity, [original], vi.fn(), vi.fn());
    const stage = () => gateway.tools().find((tool) => tool.name === original.name)!;
    const args = {
      resourceId: 'workspace:shots',
      operation: 'put_shots',
      stageId: 'stage',
      sceneIndex: 0,
      shotOffset: 0,
      shots: [
        {
          title: '镜头',
          camera: 'PRIVATE_BODY',
          authoringIR: {
            schemaVersion: 1,
            kind: 'shot',
            prompt: '完整提示词，含“引号”\n第二行',
            data: { camera: { customField: 'PRIVATE_BODY' } },
          },
        },
      ],
    };
    const snapshot = structuredClone(args);
    let message = '';
    try {
      stage().prepareArguments!(args);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('shots[0].camera');
    expect(message).toContain('at most 2 ordered shots');
    expect(message).toContain('authoringIR.data');
    expect(message).not.toContain('PRIVATE_BODY');
    expect(message).not.toContain('data.camera');
    expect(args).toEqual(snapshot);
    expect(worker.executeTools).not.toHaveBeenCalled();
    const properties = () =>
      gateway.currentDefinitions()[0]!.parameters.properties as Record<
        string,
        { maxItems: number }
      >;
    expect(properties().shots!.maxItems).toBe(2);

    const validShot = { title: args.shots[0]!.title, authoringIR: args.shots[0]!.authoringIR };
    const valid = { ...args, shots: [validShot] };
    expect(stage().prepareArguments!(valid)).toEqual(valid);
    expect(() =>
      stage().prepareArguments!({
        ...valid,
        shots: [
          {
            ...validShot,
            authoringIR: {
              ...validShot.authoringIR,
              references: { characterIds: ['PRIVATE_ID'] },
            },
          },
        ],
      }),
    ).toThrow('shots[0].authoringIR.references.characterIds');
    expect(properties().shots!.maxItems).toBe(1);
    expect(() => stage().prepareArguments!({ ...valid, shots: [validShot, validShot] })).toThrow(
      /more than 1 items/i,
    );
    expect(
      (original.parameters.properties as Record<string, { maxItems: number }>).shots!.maxItems,
    ).toBe(4);
  });

  it('does not load an unauthorized stage or redirect existing scene validation failures', async () => {
    const worker = executor({});
    const submit = SYSTEM_AGENT_TOOLS.find((tool) => tool.name === 'scene.submit_structure')!;
    const gateway = new AgentProviderToolGateway(worker, identity, [submit], vi.fn(), vi.fn());
    expect(gateway.recoverSceneAuthoring()).toBeUndefined();
    expect(gateway.currentDefinitions().map((tool) => tool.name)).toEqual([submit.name]);
    const withStage = new AgentProviderToolGateway(
      worker,
      identity,
      [submit, SYSTEM_AGENT_TOOLS.find((tool) => tool.name === 'scene.structure.stage')!],
      vi.fn(),
      vi.fn(),
      undefined,
      undefined,
      true,
    );
    const load = withStage.tools().find((tool) => tool.name === 'tools.load')!;
    await load.execute('load', { names: ['scene.submit_structure'] });
    const update = withStage.tools().find((tool) => tool.name === submit.name)!;
    expect(() =>
      update.prepareArguments!({
        resourceId: 'workspace:shots',
        resolution: 'resolved',
        episodeTitle: '更新',
        scenes: [
          { title: '原场次', sceneId: 'existing', expectedRowVersion: 0, shots: [], typo: true },
        ],
      }),
    ).toThrow('scenes[0].typo');
    expect(withStage.currentDefinitions().map((tool) => tool.name)).toContain(submit.name);
    expect(withStage.currentDefinitions().map((tool) => tool.name)).not.toContain(
      'scene.structure.stage',
    );
  });

  it('appends loaded schemas in first-load order, keeps the catalog stable and deduplicates workflow guidance', async () => {
    const worker = executor({});
    const gateway = new AgentProviderToolGateway(
      worker,
      identity,
      [
        definition('library.read'),
        definition('research.search'),
        definition('research.fetch'),
        definition('document.create_draft'),
      ],
      vi.fn(),
      vi.fn(),
      undefined,
      undefined,
      true,
    );
    const initial = gateway.currentDefinitions();
    const load = gateway.tools().find((tool) => tool.name === 'tools.load')!;
    const first = await load.execute('first', { names: ['research.fetch'] });
    const prefix = gateway.currentDefinitions();
    expect(JSON.stringify(prefix)).not.toBe(JSON.stringify(initial));
    await load.execute('next', { names: ['research.search'] });
    expect(gateway.currentDefinitions().slice(0, prefix.length)).toEqual(prefix);
    expect(gateway.currentDefinitions().map((tool) => tool.name)).toEqual([
      'library.read',
      'tools.load',
      'research.fetch',
      'research.search',
    ]);
    expect(gateway.currentDefinitions().find((tool) => tool.name === 'tools.load')).toEqual(
      initial.find((tool) => tool.name === 'tools.load'),
    );
    expect(JSON.stringify(first)).toContain('external research policy');
    const beforeRepeat = JSON.stringify(gateway.currentDefinitions());
    const repeated = await load.execute('again', { names: ['research.fetch'] });
    expect(JSON.stringify(gateway.currentDefinitions())).toBe(beforeRepeat);
    expect(JSON.stringify(repeated)).not.toContain('external research policy');
    await load.execute('phase', { names: ['document.create_draft'], reset: true });
    expect(gateway.currentDefinitions().map((tool) => tool.name)).toEqual([
      'library.read',
      'tools.load',
      'document.create_draft',
    ]);
    expect(worker.executeTools).not.toHaveBeenCalled();
  });
  it('returns the full video writing guidance when the Agent loads video preparation', async () => {
    const worker = executor({});
    const gateway = new AgentProviderToolGateway(
      worker,
      identity,
      MEDIA_AGENT_TOOLS.map((tool) => ({ ...tool, authorizationHandle: 'video-capability' })),
      vi.fn(),
      vi.fn(),
      undefined,
      undefined,
      true,
    );
    const loaded = await gateway
      .tools()
      .find((tool) => tool.name === 'tools.load')!
      .execute('load-video', {
        names: ['media.video.prepare'],
      });
    const output = loaded.content.find((block) => block.type === 'text');
    if (output?.type !== 'text') throw new Error('Expected tool loading instructions.');
    const result = JSON.parse(output.text) as { instructions: string };
    expect(result.instructions).toContain(VIDEO_PROMPT_AUTHORING_REQUIREMENTS);
    expect(gateway.currentDefinitions().map((tool) => tool.name)).toContain('media.video.prepare');
    expect(worker.executeTools).not.toHaveBeenCalled();
  });

  it('propagates business rejections as tool errors and bounds repeated invalid submissions', async () => {
    const worker = executor({
      continuation: {
        protocol: 'openai-responses',
        previousResponseId: 'rejected-response',
        outputs: [
          {
            callId: 'bad',
            output: JSON.stringify({
              status: 'rejected',
              error: { code: 'AGENT_TOOL_ARGUMENTS_INVALID', message: 'Invalid reference' },
            }),
          },
        ],
      },
    });
    const gateway = new AgentProviderToolGateway(
      worker,
      identity,
      [definition('scene.submit_structure')],
      vi.fn(),
      vi.fn(),
    );
    for (let index = 0; index < 3; index++) {
      gateway.captureProviderCall('bad', `response-${index}`);
      await expect(gateway.tools()[0]!.execute('bad', {})).rejects.toThrow('Invalid reference');
    }
    expect(() => gateway.assertRepairBudget()).toThrow('TOOL_REPAIR_LIMIT');
  });

  it('does not report completion after exhausting the Worker quota', async () => {
    const worker = executor({});
    worker.executeTools.mockRejectedValue(new Error('AGENT_TOOL_QUOTA_EXHAUSTED: quota exhausted'));
    const gateway = new AgentProviderToolGateway(
      worker,
      identity,
      [definition()],
      vi.fn(),
      vi.fn(),
    );
    gateway.captureProviderCall('quota', 'response');
    await expect(gateway.tools()[0]!.execute('quota', {})).rejects.toThrow('QUOTA_EXHAUSTED');
    expect(() => gateway.completeProviderStep('final', 'stop', undefined)).toThrow(
      'QUOTA_EXHAUSTED',
    );
    expect(worker.completeProviderStep).not.toHaveBeenCalled();
  });
  it('loads only model-selected schemas from a compact catalog while retaining Worker authorization', async () => {
    const worker = executor({});
    const definitions = [
      ...SYSTEM_AGENT_TOOLS,
      ...LIBRARY_AGENT_TOOLS,
      ...MEDIA_AGENT_TOOLS,
      ...RESEARCH_AGENT_TOOLS,
    ].map((tool) => ({
      ...tool,
      authorizationHandle: 'private-worker-capability',
    }));
    const gateway = new AgentProviderToolGateway(
      worker,
      identity,
      definitions,
      vi.fn(),
      vi.fn(),
      undefined,
      undefined,
      true,
    );
    const initial = gateway.currentDefinitions();
    expect(initial.map((tool) => tool.name)).not.toContain('scene.submit_structure');
    expect(initial.map((tool) => tool.name)).toContain('tools.load');
    expect(Buffer.byteLength(JSON.stringify(initial))).toBeLessThan(
      Buffer.byteLength(JSON.stringify(definitions)) * 0.6,
    );
    const load = gateway.tools().find((tool) => tool.name === 'tools.load')!;
    await load.execute('load', { names: ['scene.structure.stage'] });
    expect(gateway.currentDefinitions().map((tool) => tool.name)).toContain(
      'scene.structure.stage',
    );
    expect(gateway.currentDefinitions().map((tool) => tool.name)).not.toContain(
      'production.execute',
    );
    expect(worker.executeTools).not.toHaveBeenCalled();
    expect(() => load.execute('unauthorized', { names: ['invented.operation'] })).toThrow(
      'authorized',
    );
  });
  it.each([true, false])(
    'delivers the same appearance-source guidance through every authoring entry (lazy=%s)',
    async (lazy) => {
      const authoringNames = [
        'novel.episode.submit_structure',
        'scene.structure.stage',
        'scene.submit_structure',
        'scene.update_shot_prompts',
      ];
      const definitions = [...DOCUMENT_AGENT_TOOLS, ...SYSTEM_AGENT_TOOLS].map((tool) => ({
        ...tool,
        authorizationHandle: 'private-worker-capability',
      }));
      const worker = executor({});
      const gateway = new AgentProviderToolGateway(
        worker,
        identity,
        definitions,
        vi.fn(),
        vi.fn(),
        undefined,
        undefined,
        lazy,
      );
      if (lazy)
        await gateway
          .tools()
          .find((tool) => tool.name === 'tools.load')!
          .execute('load-looks', {
            names: authoringNames,
          });
      const received = gateway.currentDefinitions();
      for (const name of authoringNames) {
        const tool = received.find((entry) => entry.name === name);
        expect(tool).toBeDefined();
        expect(tool!.description.split(PRODUCTION_AUTHORING_GUIDANCE)).toHaveLength(2);
        expect(tool!.authorizationHandle).toBe('private-worker-capability');
      }
      expect(worker.executeTools).not.toHaveBeenCalled();
    },
  );
  it('keeps the authorization handle outside Provider arguments and returns the Worker result', async () => {
    const nextDefinition = definition('research.search', 'next-handle');
    const worker = executor({
      continuation: {
        protocol: 'openai-responses',
        previousResponseId: 'response-1',
        outputs: [{ callId: 'call-1', output: '{"status":"draft_created"}' }],
      },
      tools: [nextDefinition],
    });
    const gateway = new AgentProviderToolGateway(
      worker,
      identity,
      [definition()],
      vi.fn(),
      vi.fn(),
    );

    gateway.captureProviderCall('call-1', 'response-1', {
      inputTokens: 8,
      outputTokens: 3,
      totalTokens: 11,
    });
    const result = await gateway.tools()[0]!.execute('call-1', { title: 'Draft' });

    expect(worker.executeTools).toHaveBeenCalledWith({
      ...identity,
      providerResponseId: 'response-1',
      calls: [
        {
          id: 'call-1',
          name: 'document.create_draft',
          argumentsJson: '{"title":"Draft"}',
          authorizationHandle: 'worker-only-handle',
        },
      ],
      usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
    });
    expect(
      JSON.parse(vi.mocked(worker.executeTools).mock.calls[0]![0].calls[0]!.argumentsJson),
    ).toEqual({ title: 'Draft' });
    expect(result.content).toEqual([{ type: 'text', text: '{"status":"draft_created"}' }]);
    expect(gateway.currentDefinitions()).toEqual([nextDefinition]);
  });

  it.each([true, false])(
    'returns an explicit confirmation decision to Worker (%s)',
    async (approved) => {
      const request = {
        version: 1 as const,
        confirmationId: 'confirmation',
        confirmationToken: 'confirmation-token',
        taskId: 'task',
        toolCallId: 'tool-call',
        operation: 'document.archive',
        action: 'document.archive' as const,
        argumentsHash: 'arguments-hash',
        projectSessionId: identity.projectSessionId,
        riskLevel: 'R2' as const,
        summary: '归档文档“Draft”',
        affectedEntities: [{ type: 'document', id: 'document', label: 'Draft' }],
        documentId: 'document',
        documentTitle: 'Draft',
        expiresAt: '2099-01-01T00:00:00.000Z',
      };
      const worker = executor(
        { confirmation: request },
        {
          continuation: {
            protocol: 'openai-responses',
            previousResponseId: 'response-2',
            outputs: [{ callId: 'call-2', output: JSON.stringify({ approved }) }],
          },
          tools: [],
        },
      );
      const ask = vi.fn(() => Promise.resolve(approved));
      const gateway = new AgentProviderToolGateway(worker, identity, [definition()], ask, vi.fn());

      gateway.captureProviderCall('call-2', 'response-2');
      await expect(gateway.tools()[0]!.execute('call-2', {})).resolves.toMatchObject({
        content: [{ type: 'text', text: JSON.stringify({ approved }) }],
      });
      expect(ask).toHaveBeenCalledWith(request);
      expect(worker.confirmTool).toHaveBeenCalledWith({
        ...identity,
        confirmationToken: request.confirmationToken,
        approved,
      });
    },
  );

  it('returns an explicit media model selection to Worker without changing the Agent model', async () => {
    const request = {
      selectionToken: 'media-selection-token',
      kind: 'video' as const,
      prompt: 'Dragon flying in the sky',
      inputAssetIds: [],
      inputAttachmentCount: 0,
      proposedParameters: {},
      candidates: [],
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    const selection = {
      providerProfileId: 'media-profile',
      modelId: 'media-model',
      adapterKey: 'video-adapter',
      parameters: { prompt: request.prompt },
    };
    const worker = executor(
      { mediaSelection: request },
      { mediaSelection: request },
      {
        continuation: {
          protocol: 'openai-responses',
          previousResponseId: 'response-media',
          outputs: [{ callId: 'call-media', output: '{"status":"polling","taskId":"media-job"}' }],
        },
        tools: [],
      },
    );
    const askMedia = vi.fn(() => Promise.resolve(selection));
    const askSubmission = vi.fn();
    const gateway = new AgentProviderToolGateway(
      worker,
      identity,
      [definition('media.video.prepare')],
      vi.fn(),
      askMedia,
      askSubmission,
    );

    gateway.captureProviderCall('call-media', 'response-media');
    const result = await gateway.tools()[0]!.execute('call-media', { prompt: request.prompt });

    expect(askMedia).toHaveBeenCalledWith(request);
    expect(worker.selectMedia).toHaveBeenCalledWith({
      ...identity,
      selectionToken: request.selectionToken,
      selection,
    });
    expect(askSubmission).not.toHaveBeenCalled();
    expect(result.content).toEqual([
      { type: 'text', text: '{"status":"polling","taskId":"media-job"}' },
    ]);
  });

  it('rejects calls without Provider response context before reaching Worker', async () => {
    const worker = executor({});
    const gateway = new AgentProviderToolGateway(
      worker,
      identity,
      [definition()],
      vi.fn(),
      vi.fn(),
    );

    await expect(gateway.tools()[0]!.execute('missing', {})).rejects.toThrow(
      'missing its Provider response context',
    );
    expect(worker.executeTools).not.toHaveBeenCalled();
  });

  it('exposes only the operations that are ready in the frozen plan', () => {
    const worker = executor({});
    const image = definition('media.image.prepare', 'image-handle');
    const video = definition('media.video.prepare', 'video-handle');
    const gateway = new AgentProviderToolGateway(
      worker,
      identity,
      [image, video],
      vi.fn(),
      vi.fn(),
    );

    expect(gateway.currentDefinitions(['media.image.prepare'])).toEqual([image]);
    expect(gateway.tools(['media.video.prepare']).map((tool) => tool.name)).toEqual([
      'media.video.prepare',
    ]);
    expect(gateway.currentDefinitions([])).toEqual([]);
  });

  it('keeps authorized library retrieval available while restricting all other operations', async () => {
    const search = definition('library.search', 'search-handle');
    const read = definition('library.read', 'read-handle');
    const image = definition('media.image.prepare', 'image-handle');
    const video = definition('media.video.prepare', 'video-handle');
    const worker = executor({
      continuation: {
        protocol: 'openai-responses',
        previousResponseId: 'retrieval-response',
        outputs: [{ callId: 'read-call', output: '{"status":"read","content":"第一章正文"}' }],
      },
    });
    const planHooks = { begin: vi.fn(() => undefined), succeed: vi.fn(() => true), fail: vi.fn() };
    const gateway = new AgentProviderToolGateway(
      worker,
      identity,
      [search, read, image, video],
      vi.fn(),
      vi.fn(),
      undefined,
      planHooks,
    );
    expect(gateway.currentDefinitions(['media.image.prepare'])).toEqual([search, read, image]);
    expect(gateway.tools([]).map((tool) => tool.name)).toEqual(['library.search', 'library.read']);
    gateway.captureProviderCall('read-call', 'retrieval-response');
    await gateway
      .tools([])
      .find((tool) => tool.name === 'library.read')!
      .execute('read-call', { sourceHandle: 'source' });
    expect(worker.executeTools).toHaveBeenCalledOnce();
    expect(planHooks.begin).toHaveBeenCalledWith('library.read');
    expect(planHooks.succeed).not.toHaveBeenCalled();
    expect(planHooks.fail).not.toHaveBeenCalled();
  });

  it('records planned tool success only after a successful Worker Tool Result', async () => {
    const worker = executor({
      continuation: {
        protocol: 'openai-responses',
        previousResponseId: 'response-planned',
        outputs: [{ callId: 'call-planned', output: '{"status":"prepared"}' }],
      },
      tools: [],
    });
    const planHooks = {
      begin: vi.fn(() => 'step-image'),
      succeed: vi.fn(() => true),
      fail: vi.fn(),
    };
    const gateway = new AgentProviderToolGateway(
      worker,
      identity,
      [definition('media.image.prepare')],
      vi.fn(),
      vi.fn(),
      undefined,
      planHooks,
    );

    gateway.captureProviderCall('call-planned', 'response-planned');
    await gateway.tools()[0]!.execute('call-planned', { title: 'Dragon' });

    expect(planHooks.begin).toHaveBeenCalledWith('media.image.prepare');
    expect(planHooks.succeed).toHaveBeenCalledWith(
      'step-image',
      'media.image.prepare',
      '{"status":"prepared"}',
    );
    expect(planHooks.fail).not.toHaveBeenCalled();
  });

  it('records a planned tool failure when Worker execution rejects', async () => {
    const worker = executor({});
    vi.mocked(worker.executeTools).mockRejectedValueOnce(new Error('Worker execution failed.'));
    const planHooks = {
      begin: vi.fn(() => 'step-video'),
      succeed: vi.fn(() => true),
      fail: vi.fn(),
    };
    const gateway = new AgentProviderToolGateway(
      worker,
      identity,
      [definition('media.video.prepare')],
      vi.fn(),
      vi.fn(),
      undefined,
      planHooks,
    );

    gateway.captureProviderCall('call-failed', 'response-failed');
    await expect(gateway.tools()[0]!.execute('call-failed', {})).rejects.toThrow(
      'Worker execution failed.',
    );
    expect(planHooks.succeed).not.toHaveBeenCalled();
    expect(planHooks.fail).toHaveBeenCalledWith(
      'step-video',
      'media.video.prepare',
      expect.any(Error),
    );
  });

  it('uses the live authorization handle after Worker returns replacement tools', async () => {
    const search = definition('library.search', 'handle-one');
    const worker = executor({
      continuation: {
        protocol: 'openai-responses',
        previousResponseId: 'response-1',
        outputs: [{ callId: 'call-1', output: '{"status":"ok"}' }],
      },
      tools: [definition('library.search', 'handle-two')],
    });
    const gateway = new AgentProviderToolGateway(worker, identity, [search], vi.fn(), vi.fn());
    const tool = gateway.tools()[0]!;

    gateway.captureProviderCall('call-1', 'response-1');
    await tool.execute('call-1', { query: 'first' });
    gateway.captureProviderCall('call-2', 'response-2');
    vi.mocked(worker.executeTools).mockResolvedValueOnce({
      continuation: {
        protocol: 'openai-responses',
        previousResponseId: 'response-2',
        outputs: [{ callId: 'call-2', output: '{"status":"ok"}' }],
      },
    });
    await tool.execute('call-2', { query: 'second' });

    expect(worker.executeTools).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        calls: [
          expect.objectContaining({
            name: 'library.search',
            authorizationHandle: 'handle-one',
          }),
        ],
      }),
    );
    expect(worker.executeTools).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        calls: [
          expect.objectContaining({
            name: 'library.search',
            authorizationHandle: 'handle-two',
          }),
        ],
      }),
    );
  });

  it('keeps current tools when Worker omits a replacement set', async () => {
    const search = definition('library.search', 'handle-one');
    const worker = executor({
      continuation: {
        protocol: 'openai-responses',
        previousResponseId: 'response-keep',
        outputs: [{ callId: 'call-keep', output: '{"status":"ok"}' }],
      },
    });
    const gateway = new AgentProviderToolGateway(worker, identity, [search], vi.fn(), vi.fn());

    gateway.captureProviderCall('call-keep', 'response-keep');
    await gateway.tools()[0]!.execute('call-keep', { query: 'keep' });
    expect(gateway.currentDefinitions()).toEqual([search]);
  });

  it('forwards provider-step and terminal lifecycle operations', () => {
    const worker = executor({});
    const gateway = new AgentProviderToolGateway(worker, identity, [], vi.fn(), vi.fn());

    gateway.startProviderStep();
    gateway.completeProviderStep('response-final', 'stop', { totalTokens: 9 });
    gateway.terminate('failed');

    expect(worker.startProviderStep).toHaveBeenCalledWith(identity);
    expect(worker.completeProviderStep).toHaveBeenCalledWith({
      ...identity,
      providerResponseId: 'response-final',
      finishReason: 'stop',
      usage: { totalTokens: 9 },
    });
    expect(worker.terminateGeneration).toHaveBeenCalledWith(identity.generationId, 'failed');
  });
});

it('freezes one read response, limits actual overlap to four and refreshes definitions once at the barrier', async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0,
    peak = 0,
    started = 0;
  const next = definition('library.search', 'authoritative-next');
  const worker = { ...executor({}), refreshTools: vi.fn(() => [next]) };
  worker.executeTools.mockImplementation(async (params) => {
    active += 1;
    started += 1;
    peak = Math.max(peak, active);
    await barrier;
    active -= 1;
    return {
      continuation: {
        protocol: 'openai-responses',
        previousResponseId: 'response',
        outputs: [{ callId: params.calls[0]!.id, output: '{}' }],
      },
      tools: [],
    };
  });
  const gateway = new AgentProviderToolGateway(
    worker,
    identity,
    [definition('research.search', 'frozen-handle')],
    vi.fn(),
    vi.fn(),
  );
  const calls = Array.from({ length: 6 }, (_, index) => ({
    id: 'call-' + index,
    name: 'research.search',
  }));
  gateway.freezeProviderResponse(calls);
  for (const call of calls) gateway.captureProviderCall(call.id, 'response');
  const tool = gateway.tools()[0]!;
  const results = calls.map((call) => tool.execute(call.id, { title: 'independent query' }));
  await vi.waitFor(() => expect(started).toBe(4));
  expect(worker.refreshTools).not.toHaveBeenCalled();
  release();
  await Promise.all(results);
  expect(peak).toBe(4);
  expect(
    worker.executeTools.mock.calls.every(
      ([params]) => params.calls[0]?.authorizationHandle === 'frozen-handle',
    ),
  ).toBe(true);
  gateway.finishProviderResponse();
  expect(worker.refreshTools).toHaveBeenCalledTimes(1);
  expect(gateway.currentDefinitions()).toEqual([next]);
});
