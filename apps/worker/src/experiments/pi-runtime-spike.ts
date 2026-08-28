import {
  Agent,
  type AgentOptions,
  type AgentTool,
  type StreamFn,
  type ToolExecutionMode,
} from '@earendil-works/pi-agent-core';
import {
  Type,
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  type AssistantMessage,
  type FauxResponseStep,
  type ToolResultMessage,
} from '@earendil-works/pi-ai';

export const PI_RUNTIME_SPIKE_VERSION = '0.84.3' as const;

export const PI_RUNTIME_SPIKE_CHECKS = [
  'text-only',
  'single-tool-result-feedback',
  'multi-tool',
  'parallel-default',
  'sequential-global',
  'sequential-tool-override',
  'before-tool-hook',
  'after-tool-hook-terminate',
  'abort-signal',
  'length-truncated-tool-call',
  'terminate-batch-unanimity',
  'isolation-no-network-no-credentials',
] as const;

export type PiRuntimeSpikeCheckName = (typeof PI_RUNTIME_SPIKE_CHECKS)[number];

export interface PiRuntimeSpikeCheckResult {
  name: PiRuntimeSpikeCheckName;
  durationMs: number;
}

export interface PiRuntimeSpikeReport {
  ok: true;
  piVersion: typeof PI_RUNTIME_SPIKE_VERSION;
  provider: 'faux';
  nodeVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  durationMs: number;
  providerCalls: number;
  networkAttempts: number;
  credentialPayloads: number;
  rssBeforeBytes: number;
  rssAfterBytes: number;
  heapUsedAfterBytes: number;
  checks: PiRuntimeSpikeCheckResult[];
}

interface IsolationAudit {
  providerCalls: number;
  networkAttempts: number;
  credentialPayloads: number;
}

interface HarnessOptions {
  audit: IsolationAudit;
  responses: FauxResponseStep[];
  tools?: Agent['state']['tools'];
  toolExecution?: ToolExecutionMode;
  beforeToolCall?: AgentOptions['beforeToolCall'];
  afterToolCall?: AgentOptions['afterToolCall'];
  faux?: Omit<Parameters<typeof createFauxCore>[0], 'api' | 'provider'>;
}

const VALUE_PARAMETERS = Type.Object({ value: Type.String() });

function assertSpike(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Pi runtime Spike failed: ${message}`);
}

function getMessageText(message: AssistantMessage | ToolResultMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function getToolResults(agent: Agent): ToolResultMessage[] {
  return agent.state.messages.filter(
    (message): message is ToolResultMessage => message.role === 'toolResult',
  );
}

function getLastAssistant(agent: Agent): AssistantMessage {
  const message = [...agent.state.messages]
    .reverse()
    .find((candidate): candidate is AssistantMessage => candidate.role === 'assistant');
  assertSpike(message, 'expected an assistant message');
  return message;
}

function createValueTool(
  name: string,
  execute: (
    value: string,
    signal: AbortSignal | undefined,
  ) =>
    | {
        text: string;
        details?: unknown;
        terminate?: boolean;
      }
    | Promise<{
        text: string;
        details?: unknown;
        terminate?: boolean;
      }>,
  executionMode?: ToolExecutionMode,
): AgentTool<typeof VALUE_PARAMETERS> {
  return {
    name,
    label: name,
    description: `In-memory Spike tool: ${name}`,
    parameters: VALUE_PARAMETERS,
    ...(executionMode ? { executionMode } : {}),
    execute: async (_toolCallId, params, signal) => {
      const result = await execute(params.value, signal);
      return {
        content: [{ type: 'text', text: result.text }],
        details: result.details ?? { value: params.value },
        ...(result.terminate === undefined ? {} : { terminate: result.terminate }),
      };
    },
  };
}

function createHarness(options: HarnessOptions) {
  const faux = createFauxCore({
    api: 'pi-runtime-spike',
    provider: 'pi-runtime-spike',
    ...options.faux,
  });
  faux.setResponses(options.responses);

  const streamFn: StreamFn = (_model, context, streamOptions) => {
    options.audit.providerCalls += 1;
    if (streamOptions?.apiKey !== undefined) options.audit.credentialPayloads += 1;
    return faux.streamSimple(faux.getModel(), context, streamOptions);
  };

  const agent = new Agent({
    streamFn,
    initialState: {
      systemPrompt: 'Pi low-level Agent feasibility Spike. Use in-memory tools only.',
      model: faux.getModel(),
      thinkingLevel: 'off',
      tools: options.tools ?? [],
    },
    ...(options.toolExecution ? { toolExecution: options.toolExecution } : {}),
    ...(options.beforeToolCall ? { beforeToolCall: options.beforeToolCall } : {}),
    ...(options.afterToolCall ? { afterToolCall: options.afterToolCall } : {}),
  });

  return { agent, faux };
}

async function verifyTextOnly(audit: IsolationAudit): Promise<void> {
  const { agent, faux } = createHarness({
    audit,
    responses: [fauxAssistantMessage('text-only-ok')],
  });

  await agent.prompt('Return a text-only response.');

  assertSpike(getMessageText(getLastAssistant(agent)) === 'text-only-ok', 'text response mismatch');
  assertSpike(faux.state.callCount === 1, 'text response should use one provider turn');
}

async function verifySingleToolFeedback(audit: IsolationAudit): Promise<void> {
  let executions = 0;
  const echo = createValueTool('memory_echo', (value) => {
    executions += 1;
    return { text: `echo:${value}` };
  });
  const { agent, faux } = createHarness({
    audit,
    tools: [echo],
    responses: [
      fauxAssistantMessage([fauxToolCall('memory_echo', { value: 'hello' }, { id: 'echo-1' })], {
        stopReason: 'toolUse',
      }),
      (context) => {
        const feedback = context.messages.find(
          (message): message is ToolResultMessage =>
            message.role === 'toolResult' && message.toolCallId === 'echo-1',
        );
        assertSpike(feedback, 'tool result was not fed back to the next provider turn');
        assertSpike(getMessageText(feedback) === 'echo:hello', 'tool feedback content mismatch');
        return fauxAssistantMessage('tool-feedback-ok');
      },
    ],
  });

  await agent.prompt('Call the echo tool.');

  assertSpike(executions === 1, 'single tool should execute exactly once');
  assertSpike(faux.state.callCount === 2, 'tool feedback should trigger the next provider turn');
  assertSpike(
    getMessageText(getLastAssistant(agent)) === 'tool-feedback-ok',
    'final tool response mismatch',
  );
}

async function verifyMultiTool(audit: IsolationAudit): Promise<void> {
  const executed: string[] = [];
  const tool = createValueTool('memory_multi', (value) => {
    executed.push(value);
    return { text: `done:${value}` };
  });
  const { agent } = createHarness({
    audit,
    tools: [tool],
    responses: [
      fauxAssistantMessage(
        [
          fauxToolCall('memory_multi', { value: 'first' }, { id: 'multi-1' }),
          fauxToolCall('memory_multi', { value: 'second' }, { id: 'multi-2' }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('multi-ok'),
    ],
  });

  await agent.prompt('Call two tools.');

  const results = getToolResults(agent);
  assertSpike(executed.length === 2, 'both tool calls should execute');
  assertSpike(results.length === 2, 'both tool results should be persisted in the transcript');
  assertSpike(
    results[0]?.toolCallId === 'multi-1' && results[1]?.toolCallId === 'multi-2',
    'tool results should remain in assistant source order',
  );
}

async function runConcurrencyScenario(
  audit: IsolationAudit,
  options: { toolExecution?: ToolExecutionMode; toolOverride?: ToolExecutionMode },
): Promise<number> {
  let active = 0;
  let maxActive = 0;
  const tool = createValueTool(
    'memory_wait',
    async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { text: `waited:${value}` };
    },
    options.toolOverride,
  );
  const { agent } = createHarness({
    audit,
    tools: [tool],
    ...(options.toolExecution ? { toolExecution: options.toolExecution } : {}),
    responses: [
      fauxAssistantMessage(
        [
          fauxToolCall('memory_wait', { value: 'one' }, { id: 'wait-1' }),
          fauxToolCall('memory_wait', { value: 'two' }, { id: 'wait-2' }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('wait-ok'),
    ],
  });

  await agent.prompt('Check tool scheduling.');
  return maxActive;
}

async function verifyParallelDefault(audit: IsolationAudit): Promise<void> {
  const maxActive = await runConcurrencyScenario(audit, {});
  assertSpike(maxActive === 2, 'default tool execution should be parallel');
}

async function verifySequentialGlobal(audit: IsolationAudit): Promise<void> {
  const maxActive = await runConcurrencyScenario(audit, { toolExecution: 'sequential' });
  assertSpike(maxActive === 1, 'global sequential mode should serialize a batch');
}

async function verifySequentialToolOverride(audit: IsolationAudit): Promise<void> {
  const maxActive = await runConcurrencyScenario(audit, { toolOverride: 'sequential' });
  assertSpike(maxActive === 1, 'tool-level sequential mode should serialize a batch');
}

async function verifyBeforeToolHook(audit: IsolationAudit): Promise<void> {
  const executed: string[] = [];
  const tool = createValueTool('memory_policy', (value) => {
    executed.push(value);
    return { text: `allowed:${value}` };
  });
  const { agent } = createHarness({
    audit,
    tools: [tool],
    beforeToolCall: ({ args }) => {
      const value = (args as { value: string }).value;
      return Promise.resolve(
        value === 'blocked' ? { block: true, reason: 'blocked-by-spike-policy' } : undefined,
      );
    },
    responses: [
      fauxAssistantMessage(
        [
          fauxToolCall('memory_policy', { value: 'allowed' }, { id: 'policy-1' }),
          fauxToolCall('memory_policy', { value: 'blocked' }, { id: 'policy-2' }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('policy-ok'),
    ],
  });

  await agent.prompt('Check preflight policy.');

  const results = getToolResults(agent);
  assertSpike(executed.join(',') === 'allowed', 'blocked tool must not execute');
  assertSpike(results[0]?.isError === false, 'allowed tool should succeed');
  assertSpike(results[1]?.isError === true, 'blocked tool should emit an error result');
  assertSpike(
    getMessageText(results[1]).includes('blocked-by-spike-policy'),
    'blocked result should include the policy reason',
  );
}

async function verifyAfterToolHook(audit: IsolationAudit): Promise<void> {
  const tool = createValueTool('memory_redact', (value) => ({ text: `raw:${value}` }));
  const { agent, faux } = createHarness({
    audit,
    tools: [tool],
    afterToolCall: () =>
      Promise.resolve({
        content: [{ type: 'text' as const, text: 'redacted-by-after-hook' }],
        details: { redacted: true },
        terminate: true,
      }),
    responses: [
      fauxAssistantMessage(
        [fauxToolCall('memory_redact', { value: 'secret' }, { id: 'redact-1' })],
        { stopReason: 'toolUse' },
      ),
    ],
  });

  await agent.prompt('Check post-processing.');

  const result = getToolResults(agent)[0];
  assertSpike(result, 'after hook should retain a tool result');
  assertSpike(
    getMessageText(result) === 'redacted-by-after-hook',
    'after hook content override failed',
  );
  assertSpike(
    (result.details as { redacted?: boolean }).redacted === true,
    'after hook details override failed',
  );
  assertSpike(
    faux.state.callCount === 1,
    'terminate=true should skip the automatic follow-up turn',
  );
}

async function verifyAbort(audit: IsolationAudit): Promise<void> {
  const { agent } = createHarness({
    audit,
    faux: { tokensPerSecond: 100, tokenSize: { min: 1, max: 1 } },
    responses: [fauxAssistantMessage('abort-stream-'.repeat(30))],
  });
  let abortRequested = false;
  agent.subscribe((event) => {
    if (
      !abortRequested &&
      event.type === 'message_update' &&
      event.assistantMessageEvent.type === 'text_delta'
    ) {
      abortRequested = true;
      agent.abort();
    }
  });

  await agent.prompt('Start a cancellable stream.');

  const message = getLastAssistant(agent);
  assertSpike(abortRequested, 'abort was not requested during streaming');
  assertSpike(message.stopReason === 'aborted', 'AbortSignal should produce stopReason=aborted');
  assertSpike(agent.state.isStreaming === false, 'agent should become idle after abort');
}

async function verifyLengthTruncation(audit: IsolationAudit): Promise<void> {
  let executions = 0;
  const tool = createValueTool('memory_length', (value) => {
    executions += 1;
    return { text: value };
  });
  const { agent, faux } = createHarness({
    audit,
    tools: [tool],
    responses: [
      fauxAssistantMessage(
        [fauxToolCall('memory_length', { value: 'possibly-truncated' }, { id: 'length-1' })],
        { stopReason: 'length' },
      ),
      (context) => {
        const result = context.messages.find(
          (message): message is ToolResultMessage =>
            message.role === 'toolResult' && message.toolCallId === 'length-1',
        );
        assertSpike(result?.isError, 'truncated tool call should feed back an error result');
        return fauxAssistantMessage('length-recovery-ok');
      },
    ],
  });

  await agent.prompt('Return a truncated tool call.');

  const result = getToolResults(agent)[0];
  assertSpike(executions === 0, 'length-truncated tool call must not execute');
  assertSpike(result?.isError, 'length-truncated tool call should be marked as an error');
  assertSpike(
    getMessageText(result).includes('output token limit'),
    'length-truncated result should explain the retry reason',
  );
  assertSpike(faux.state.callCount === 2, 'length error should be available to a correction turn');
  assertSpike(
    getMessageText(getLastAssistant(agent)) === 'length-recovery-ok',
    'length recovery turn did not complete',
  );
}

async function verifyTerminateUnanimity(audit: IsolationAudit): Promise<void> {
  const tool = createValueTool('memory_terminate', (value) => ({
    text: `terminate:${value}`,
    terminate: value === 'stop',
  }));

  const mixed = createHarness({
    audit,
    tools: [tool],
    responses: [
      fauxAssistantMessage(
        [
          fauxToolCall('memory_terminate', { value: 'stop' }, { id: 'mixed-1' }),
          fauxToolCall('memory_terminate', { value: 'continue' }, { id: 'mixed-2' }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('mixed-continued'),
    ],
  });
  await mixed.agent.prompt('Check mixed termination.');
  assertSpike(
    mixed.faux.state.callCount === 2 &&
      getMessageText(getLastAssistant(mixed.agent)) === 'mixed-continued',
    'a mixed terminate batch should continue',
  );

  const unanimous = createHarness({
    audit,
    tools: [tool],
    responses: [
      fauxAssistantMessage(
        [
          fauxToolCall('memory_terminate', { value: 'stop' }, { id: 'all-1' }),
          fauxToolCall('memory_terminate', { value: 'stop' }, { id: 'all-2' }),
        ],
        { stopReason: 'toolUse' },
      ),
    ],
  });
  await unanimous.agent.prompt('Check unanimous termination.');
  assertSpike(unanimous.faux.state.callCount === 1, 'an all-terminate batch should stop early');
  assertSpike(
    getToolResults(unanimous.agent).length === 2,
    'all terminating results should be retained',
  );
}

export async function runPiRuntimeSpike(): Promise<PiRuntimeSpikeReport> {
  const startedAt = performance.now();
  const rssBeforeBytes = process.memoryUsage().rss;
  const audit: IsolationAudit = {
    providerCalls: 0,
    networkAttempts: 0,
    credentialPayloads: 0,
  };
  const checks: PiRuntimeSpikeCheckResult[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    audit.networkAttempts += 1;
    return Promise.reject(new Error('Network access is forbidden in the Pi runtime Spike'));
  };

  const record = async (name: PiRuntimeSpikeCheckName, verify: () => void | Promise<void>) => {
    const checkStartedAt = performance.now();
    await verify();
    checks.push({ name, durationMs: performance.now() - checkStartedAt });
  };

  try {
    await record('text-only', () => verifyTextOnly(audit));
    await record('single-tool-result-feedback', () => verifySingleToolFeedback(audit));
    await record('multi-tool', () => verifyMultiTool(audit));
    await record('parallel-default', () => verifyParallelDefault(audit));
    await record('sequential-global', () => verifySequentialGlobal(audit));
    await record('sequential-tool-override', () => verifySequentialToolOverride(audit));
    await record('before-tool-hook', () => verifyBeforeToolHook(audit));
    await record('after-tool-hook-terminate', () => verifyAfterToolHook(audit));
    await record('abort-signal', () => verifyAbort(audit));
    await record('length-truncated-tool-call', () => verifyLengthTruncation(audit));
    await record('terminate-batch-unanimity', () => verifyTerminateUnanimity(audit));
    await record('isolation-no-network-no-credentials', () => {
      assertSpike(audit.networkAttempts === 0, 'the Spike attempted network access');
      assertSpike(
        audit.credentialPayloads === 0,
        'the Spike passed credentials to the fake provider',
      );
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assertSpike(
    checks.map((check) => check.name).join(',') === PI_RUNTIME_SPIKE_CHECKS.join(','),
    'not all planned checks completed',
  );

  const memory = process.memoryUsage();
  return {
    ok: true,
    piVersion: PI_RUNTIME_SPIKE_VERSION,
    provider: 'faux',
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    durationMs: performance.now() - startedAt,
    providerCalls: audit.providerCalls,
    networkAttempts: audit.networkAttempts,
    credentialPayloads: audit.credentialPayloads,
    rssBeforeBytes,
    rssAfterBytes: memory.rss,
    heapUsedAfterBytes: memory.heapUsed,
    checks,
  };
}
