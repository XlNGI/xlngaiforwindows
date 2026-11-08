import { createHash } from 'node:crypto';
import { estimateTokenCount } from '@ai-video/context';
import type { LlmGenerationRuntimeRequest, LlmRequestContextInfo } from '@ai-video/contracts';
import type { Context } from '@earendil-works/pi-ai';
import { isVersionedProductionRead, readEvidenceKey } from './repeated-read-results.js';
import { NAVIGATION_TOOLS, taskEvidenceKey } from './agent-preparation-evidence.js';

import {
  DEFAULT_UNKNOWN_MODEL_CONTEXT_WINDOW,
  hasVerifiedContextLimit,
} from './model-context-policy.js';
export const FALLBACK_CONTEXT_WINDOW = DEFAULT_UNKNOWN_MODEL_CONTEXT_WINDOW;
function outputAllowance(runtime: LlmGenerationRuntimeRequest, window: number): number {
  const verified = hasVerifiedContextLimit(runtime);
  const maximum = verified ? runtime.modelCapabilities?.maxOutputTokens : undefined;
  return Math.min(
    runtime.inferenceSettings?.maxOutputTokens ??
      maximum ??
      Math.min(16_384, Math.floor(window / 4)),
    maximum ?? Infinity,
    verified ? window - Math.max(256, Math.ceil(window * 0.05)) - 1 : Infinity,
  );
}
const REREADABLE_TOOLS = new Set([
  'library.read',
  'document.read',
  'novel.chapter.read',
  'scene.read',
  'production.read',
]);
const PROGRESS_TOOLS = new Set([
  'scene.structure.stage',
  'scene.submit_structure',
  'novel.episode.submit_structure',
  'scene.update_shot_prompts',
  'scene.update_shot_timings',
  'document.submit_draft',
  'novel.chapter.submit_draft',
  'novel.chapter.update_metadata',
  'media.image.prepare',
  'media.video.prepare',
]);
const WORK_PROGRESS_TOOLS = new Set([
  ...PROGRESS_TOOLS,
  'document.create_draft',
  'document.update_draft',
  'novel.chapter.write_draft',
  'novel.reference.submit_draft',
  'novel.episode.submit_draft',
  'novel.adaptation.submit_proposal',
  'media.review.prepare',
  'shot.continuity.save',
]);
const BODY_KEYS = new Set(['content', 'contentMarkdown', 'text']);
const PROTECTED_KEYS = /constraint|continuity|locked|requirement|instruction|manual/i;

type HistoryEntry = {
  role: string;
  content?: unknown;
  callId?: string;
  toolName?: string;
  isError?: boolean;
  imageCount?: number;
  source?: string;
};

/** Task-local, deterministic budgeting. Never truncates user input or writes a second conversation. */
export class AgentContextBudget {
  private readonly replacements = new Map<string, string>();
  private readonly callReplacements = new Map<string, string>();
  private compactionCount = 0;
  lastInfo?: LlmRequestContextInfo;

  resetStage(): void {
    this.replacements.clear();
    this.callReplacements.clear();
  }

  inspect(runtime: LlmGenerationRuntimeRequest, context: Context): LlmRequestContextInfo {
    const window =
      runtime.modelCapabilities?.contextWindow ??
      runtime.contextWindowTokens ??
      FALLBACK_CONTEXT_WINDOW;
    return this.measure(runtime, this.history(context), window, outputAllowance(runtime, window));
  }

  get replacedResultIds(): ReadonlySet<string> {
    return new Set(this.replacements.keys());
  }

  prepare(
    runtime: LlmGenerationRuntimeRequest,
    context: Context,
  ): {
    request: LlmGenerationRuntimeRequest;
    compacted: boolean;
  } {
    const enforceLimit = hasVerifiedContextLimit(runtime);
    const window =
      runtime.modelCapabilities?.contextWindow ??
      runtime.contextWindowTokens ??
      FALLBACK_CONTEXT_WINDOW;
    let reserved = outputAllowance(runtime, window);
    const safety = Math.max(256, Math.ceil(window * 0.05));
    let inputBudget = Math.min(
      runtime.modelCapabilities?.maxInputTokens ?? Infinity,
      window - reserved - safety,
    );
    const initialInputBudget = inputBudget;
    const minimumOutput = Math.min(2048, reserved);
    const maximumInput = Math.min(
      runtime.modelCapabilities?.maxInputTokens ?? Infinity,
      window - safety - minimumOutput,
    );
    let inferenceSettings = runtime.inferenceSettings;
    const history = this.history(context);
    assertNoReadLoop(context);
    let estimated = this.measure(runtime, history, window, reserved);
    let compacted = false;
    if (estimated.estimatedInputTokens > inputBudget * 0.8) {
      const reads = history.filter((entry) => entry.role === 'toolResult');
      const recentResultIds = new Set(
        reads.slice(-2).flatMap((entry) => (entry.callId ? [entry.callId] : [])),
      );
      // A recent short reference requires its earlier full result to remain available.
      for (const entry of reads.slice(-2)) {
        const result = typeof entry.content === 'string' ? parseRecord(entry.content) : undefined;
        if (result?.status === 'identical_result' && typeof result.fullResultCallId === 'string')
          recentResultIds.add(result.fullResultCallId);
      }
      const navigationSummaries = summarizeProductionHistory(
        this.history(context, false),
        recentResultIds,
      );
      const reacquired = reacquiredReadIds(history);
      const toolCalls = new Map<string, { name: string; arguments: unknown }>();
      for (const entry of history) {
        if (entry.role !== 'assistant' || !Array.isArray(entry.content)) continue;
        for (const part of entry.content as unknown[]) {
          if (!isRecord(part) || part.type !== 'toolCall') continue;
          if (typeof part.id !== 'string' || typeof part.name !== 'string') continue;
          toolCalls.set(part.id, {
            name: part.name,
            arguments: part.arguments ?? {},
          });
        }
      }
      const completedStages = new Set(
        reads.flatMap((entry) => {
          if (entry.toolName !== 'scene.structure.stage' || typeof entry.content !== 'string')
            return [];
          const result = parseRecord(entry.content);
          return result &&
            (result.complete === true ||
              result.stagePageComplete === true ||
              result.status === 'scene_structure_saved' ||
              result.operationStatus === 'scene_structure_saved') &&
            typeof result.stageId === 'string'
            ? [result.stageId]
            : [];
        }),
      );
      const candidates = [
        ...reads.filter((entry) => !REREADABLE_TOOLS.has(entry.toolName ?? '')),
        ...reads.filter((entry) => REREADABLE_TOOLS.has(entry.toolName ?? '')),
      ];
      for (const entry of candidates) {
        if (!entry.callId || entry.isError || typeof entry.content !== 'string') continue;
        let replacement = navigationSummaries.get(entry.callId);
        if (replacement && estimateTokenCount(replacement) >= estimateTokenCount(entry.content))
          replacement = undefined;
        if (!replacement && this.replacements.has(entry.callId)) continue;
        let callCompacted = false;
        if (
          !replacement &&
          REREADABLE_TOOLS.has(entry.toolName ?? '') &&
          !recentResultIds.has(entry.callId)
        ) {
          replacement = summarizeProductionNavigation(entry.callId, entry.content);
          // Soft targets must not evict the active evidence merely to create spare room.
          // Once an omitted body was reacquired, retain it until progress/user input.
          if (
            !replacement &&
            estimated.estimatedInputTokens > maximumInput &&
            !reacquired.has(entry.callId)
          )
            replacement = summarizeRead(entry.callId, entry.content);
        } else if (!replacement && !recentResultIds.has(entry.callId)) {
          replacement = summarizeNavigation(entry.callId, entry.toolName ?? '', entry.content);
        }
        if (!replacement && PROGRESS_TOOLS.has(entry.toolName ?? '') && !entry.isError) {
          const output = parseRecord(entry.content);
          const stageComplete =
            entry.toolName === 'scene.structure.stage' &&
            typeof output?.stageId === 'string' &&
            completedStages.has(output.stageId);
          const progress = summarizeProgress(
            entry.callId,
            entry.toolName!,
            entry.content,
            stageComplete,
          );
          if (progress) {
            // The latest receipts are the model's evidence for closing the task.
            // Saved request bodies can be removed independently of those receipts.
            if (!recentResultIds.has(entry.callId)) replacement = progress;
            const call = toolCalls.get(entry.callId);
            if (call && !this.callReplacements.has(entry.callId)) {
              this.callReplacements.set(
                entry.callId,
                JSON.stringify({
                  historyCompacted: true,
                  toolName: call.name,
                  originalArgumentsHash: createHash('sha256')
                    .update(JSON.stringify(call.arguments))
                    .digest('hex'),
                }),
              );
              callCompacted = true;
            }
          }
        }
        if (!replacement && !callCompacted) continue;
        if (replacement) {
          this.replacements.set(entry.callId, replacement);
          entry.content = replacement;
        }
        // Previously delivered references must not point at a body we just omitted.
        const summary = replacement ? parseRecord(replacement) : undefined;
        if (
          isRecord(summary?.contextCompaction) &&
          summary.contextCompaction.status === 'reread_required'
        )
          for (const reference of reads) {
            const result =
              typeof reference.content === 'string' ? parseRecord(reference.content) : undefined;
            if (
              reference.callId &&
              result?.status === 'identical_result' &&
              result.fullResultCallId === entry.callId
            ) {
              const updated = JSON.stringify({
                ...summary,
                contextCompaction: {
                  ...summary.contextCompaction,
                  originalCallId: reference.callId,
                },
              });
              reference.content = updated;
              this.replacements.set(reference.callId, updated);
            }
          }
        applyCallReplacements(history, this.callReplacements);
        compacted = true;
        estimated = this.measure(runtime, history, window, reserved);
        if (estimated.estimatedInputTokens <= inputBudget * 0.65) break;
      }
      if (compacted) this.compactionCount += 1;
    }
    // Preserve the full user input. When evidence needs more room, use a smaller
    // output allowance for this call and send that same allowance to the Provider.
    const fitOutput = (info: LlmRequestContextInfo): void => {
      const available = Math.floor(window - safety - info.estimatedInputTokens);
      if (enforceLimit && available >= Math.min(2048, reserved) && available < reserved) {
        reserved = available;
        inputBudget = Math.min(
          runtime.modelCapabilities?.maxInputTokens ?? Infinity,
          window - safety - reserved,
        );
        // A missing model contract must not disable output budgeting. These are
        // the selected transport protocol's fields, not a model capacity claim.
        inferenceSettings ??= {
          maxOutputTokens: reserved,
          outputTokenParameter:
            runtime.protocol === 'openai-responses' ? 'max_output_tokens' : 'max_tokens',
          reasoning: 'provider_default',
        };
      }
      info.reservedOutputTokens = reserved;
      info.safetyTokens = safety;
      info.minimumOutputTokens = minimumOutput;
      info.initialInputBudgetTokens = initialInputBudget;
      info.maximumInputBudgetTokens = maximumInput;
      info.effectiveInputBudgetTokens = inputBudget;
      info.deficitTokens = Math.max(0, info.estimatedInputTokens - maximumInput);
    };
    const budgetError = (info: LlmRequestContextInfo): Error =>
      new Error(
        `CONTEXT_BUDGET_EXCEEDED: 必要上下文约 ${info.estimatedInputTokens} Token，超过自适应输入上限 ${maximumInput}，缺口 ${info.deficitTokens}（初始预算 ${initialInputBudget}；模型窗口 ${window}，${info.windowSource === 'contract' ? '已核实合同' : '保守回退'}；安全余量 ${safety}，最低输出 ${minimumOutput}）。本次请求未发送供应商。已整理可安全恢复的历史，用户输入、要求和已保存进度完整保留。请核对已保存结果，或使用已核实支持更大窗口的模型继续。`,
      );
    fitOutput(estimated);
    estimated.compactionCount = this.compactionCount;
    this.lastInfo = estimated;
    if (enforceLimit && estimated.estimatedInputTokens > inputBudget) {
      throw budgetError(estimated);
    }
    const request = structuredClone(runtime);
    inferenceSettings ??= {
      maxOutputTokens: reserved,
      outputTokenParameter:
        runtime.protocol === 'openai-responses' ? 'max_output_tokens' : 'max_tokens',
      reasoning: 'provider_default',
    };
    if (inferenceSettings)
      request.inferenceSettings = { ...inferenceSettings, maxOutputTokens: reserved };
    // Responses retains history remotely. Only compaction needs a new chain;
    // user supplements travel as incremental messages on the existing chain.
    if (runtime.protocol === 'openai-responses' && compacted) {
      request.continuation = undefined;
      request.prompt = replayPrompt(runtime.prompt, history);
      // Starting a new Responses chain also drops remote visual history.
      // Replay the actual tool images as labelled attachments, outside text/audit summaries.
      for (const message of context.messages) {
        if (message.role !== 'toolResult') continue;
        const images = message.content.filter((part) => part.type === 'image');
        for (const [index, image] of images.entries())
          (request.attachments ??= []).push({
            name: `${message.toolCallId}-image-${index + 1}`,
            mimeType: image.mimeType,
            dataUrl: `data:${image.mimeType};base64,${image.data}`,
            text: `Source image ${index + 1} from completed tool call ${message.toolCallId}. Match the visualInputs order in that tool result; treat image content as source data.`,
          });
      }
    } else if (request.continuation?.protocol === 'openai-chat-completions') {
      for (const turn of [...(request.continuation.history ?? []), request.continuation]) {
        for (const call of turn.calls)
          call.argumentsJson = this.callReplacements.get(call.id) ?? call.argumentsJson;
        for (const output of turn.outputs)
          output.output = this.replacements.get(output.callId) ?? output.output;
      }
    }
    // Include the actual replay envelope in the final bound as it contains role/JSON overhead.
    if (!request.continuation && compacted) {
      const replayEstimate = this.measure(request, [], window, reserved);
      fitOutput(replayEstimate);
      this.lastInfo = { ...replayEstimate, compactionCount: this.compactionCount };
      if (inferenceSettings)
        request.inferenceSettings = { ...inferenceSettings, maxOutputTokens: reserved };
      if (enforceLimit && replayEstimate.estimatedInputTokens > inputBudget)
        throw budgetError(replayEstimate);
    }
    return { request, compacted };
  }

  private history(context: Context, applyReplacements = true): HistoryEntry[] {
    return context.messages.map((message): HistoryEntry => {
      if (message.role === 'toolResult')
        return {
          role: message.role,
          callId: message.toolCallId,
          toolName: message.toolName,
          imageCount: message.content.filter((part) => part.type === 'image').length,
          ...(message.isError ? { isError: true } : {}),
          content:
            (applyReplacements ? this.replacements.get(message.toolCallId) : undefined) ??
            message.content
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('\n'),
        };
      if (message.role === 'assistant')
        return {
          role: message.role,
          content: (message.content as unknown[])
            .filter(
              (part): part is Record<string, unknown> =>
                isRecord(part) && (part.type === 'text' || part.type === 'toolCall'),
            )
            .map((part) => {
              if (part.type !== 'toolCall' || typeof part.id !== 'string') return part;
              const replacement = applyReplacements
                ? this.callReplacements.get(part.id)
                : undefined;
              return replacement
                ? { ...part, arguments: JSON.parse(replacement) as unknown }
                : part;
            }),
        };
      return {
        role: message.role,
        source: 'source' in message ? String(message.source) : undefined,
        content:
          typeof message.content === 'string'
            ? message.content
            : message.content.map((part) => (part.type === 'text' ? part : { type: 'image' })),
      };
    });
  }

  private measure(
    runtime: LlmGenerationRuntimeRequest,
    history: HistoryEntry[],
    window: number,
    reserved: number,
  ): LlmRequestContextInfo {
    const sections: LlmRequestContextInfo['sections'] = {};
    // Native sends runtime.prompt once. Pi also keeps that same initial user
    // message for its own history; it is not a second Provider input.
    const budgetHistory =
      history[0]?.role === 'user' && userText(history[0]) === runtime.prompt
        ? history.slice(1)
        : history;
    const continuation = runtime.continuation;
    const pendingSupplements = continuation?.userMessages ?? [];
    const mirroredSupplements =
      pendingSupplements.length > 0 &&
      budgetHistory.length >= pendingSupplements.length &&
      budgetHistory
        .slice(-pendingSupplements.length)
        .every(
          (entry, index) => entry.role === 'user' && userText(entry) === pendingSupplements[index],
        );
    const visualOutputs = continuation
      ? continuation.protocol === 'openai-chat-completions'
        ? [...(continuation.history ?? []), continuation].flatMap((turn) => turn.outputs)
        : continuation.outputs
      : [];
    const toolImageCount = Math.max(
      history.reduce((count, entry) => count + (entry.imageCount ?? 0), 0),
      visualOutputs.reduce((count, output) => count + (output.images?.length ?? 0), 0),
    );
    const imageCount =
      (runtime.attachments?.filter((attachment) => attachment.mimeType.startsWith('image/'))
        .length ?? 0) + toolImageCount;
    const parts: Record<string, string> = {
      system: runtime.systemInstruction,
      tools: JSON.stringify(
        runtime.tools?.map(({ name, description, parameters }) => ({
          name,
          description,
          parameters,
        })) ?? [],
      ),
      context: runtime.context,
      user: runtime.prompt,
      history: JSON.stringify(
        runtime.contextTurns?.map(({ content, calls, userMessages }) => ({
          content,
          calls,
          userMessages,
        })) ?? budgetHistory,
      ),
      toolResults: runtime.contextTurns
        ? JSON.stringify(runtime.contextTurns.flatMap((turn) => turn.outputs))
        : '',
      supplements: JSON.stringify(mirroredSupplements ? [] : pendingSupplements),
      attachments: JSON.stringify(
        runtime.attachments?.map(({ name, mimeType, text }) => ({ name, mimeType, text })) ?? [],
      ),
    };
    for (const [key, value] of Object.entries(parts))
      sections[key] = {
        bytes: Buffer.byteLength(value),
        hash: createHash('sha256').update(value).digest('hex'),
        estimatedTokens: estimateTokenCount(value),
      };
    sections.protocolAndImages = {
      bytes: 0,
      hash: createHash('sha256')
        .update(JSON.stringify([budgetHistory.length, imageCount]))
        .digest('hex'),
      estimatedTokens: 256 + budgetHistory.length * 24 + imageCount * 4096,
    };
    return {
      capabilitySource: runtime.modelCapabilities?.capabilitySource ?? 'fallback',
      tokenizer: runtime.modelCapabilities?.tokenizer ?? 'heuristic',
      estimatedInputTokens: Object.values(sections).reduce(
        (sum, section) => sum + section.estimatedTokens,
        0,
      ),
      contextWindowTokens: window,
      windowSource: runtime.contextWindowSource ?? 'fallback',
      limitEnforcement: hasVerifiedContextLimit(runtime)
        ? 'verified_capability'
        : 'advisory_fallback',
      reservedOutputTokens: reserved,
      compactionCount: this.compactionCount,
      sections,
    };
  }
}

function userText(entry: HistoryEntry): string | undefined {
  if (typeof entry.content === 'string') return entry.content;
  if (!Array.isArray(entry.content)) return undefined;
  return (entry.content as unknown[])
    .filter((part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string')
    .map((part) => (part as { text: string }).text)
    .join('\n');
}

function parseRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isWorkBoundary(entry: HistoryEntry, seenProgress: Set<string>): boolean {
  if (entry.role === 'user' && entry.source !== 'runtime-continuation') {
    seenProgress.clear();
    return true;
  }
  if (entry.role !== 'toolResult' || entry.isError || typeof entry.content !== 'string')
    return false;
  const result = parseRecord(entry.content);
  if (entry.toolName === 'conversation.task.checkpoint' && result && !result.error) {
    const keys: string[] = [];
    if (result.status === 'task_plan_saved' && typeof result.contractHash === 'string')
      keys.push(`contract:${result.contractHash}`);
    if (
      result.status === 'task_review_recorded' &&
      [3, 4].includes(Number(result.protocolVersion))
    ) {
      if (Array.isArray(result.coverage))
        for (const raw of result.coverage) {
          if (
            isRecord(raw) &&
            typeof raw.id === 'string' &&
            typeof raw.key === 'string' &&
            typeof raw.dependencyHash === 'string'
          )
            keys.push(`review:${raw.id}:${raw.key}:${raw.dependencyHash}`);
        }
      if (Array.isArray(result.resolutions))
        for (const raw of result.resolutions)
          if (
            isRecord(raw) &&
            typeof raw.issueId === 'string' &&
            ['resolved', 'withdrawn'].includes(String(raw.disposition))
          )
            keys.push(`issue-closed:${raw.issueId}`);
    }
    const fresh = keys.some((key) => !seenProgress.has(key));
    for (const key of keys) seenProgress.add(key);
    return fresh;
  }
  if (!WORK_PROGRESS_TOOLS.has(entry.toolName ?? '')) return false;
  if (isRecord(result?.execution)) {
    const execution = result.execution;
    if (execution.replayed === true || !['created', 'updated'].includes(String(execution.effect)))
      return false;
    const key = typeof execution.receiptId === 'string' ? execution.receiptId : '';
    if (!key || seenProgress.has(key)) return false;
    seenProgress.add(key);
    return true;
  }
  if (!result || result.error || typeof result.status !== 'string') return false;
  if (
    entry.toolName === 'scene.structure.stage' &&
    ['get', 'list'].includes(String(result.stageOperation))
  )
    return false;
  const stageProgress =
    entry.toolName === 'scene.structure.stage' &&
    result.status === 'scene_structure_staging' &&
    typeof result.rowVersion === 'number';
  const mediaProgress =
    (entry.toolName === 'media.image.prepare' || entry.toolName === 'media.video.prepare') &&
    typeof result.taskId === 'string' &&
    [
      'draft',
      'awaiting_confirmation',
      'submitting',
      'polling',
      'submission_unknown',
      'downloading',
      'validating',
      'committing',
      'succeeded',
    ].includes(result.status);
  if (
    !stageProgress &&
    !mediaProgress &&
    !/(?:^|_)(?:saved|created|updated|submitted|prepared|applied|history_compacted)$/u.test(
      result.status,
    )
  )
    return false;
  const receipt = isRecord(result.persisted) ? result.persisted : result;
  const fields = [
    'stageId',
    'rowVersion',
    'documentId',
    'documentVersionId',
    'versionId',
    'currentVersionId',
    'chapterId',
    'referenceId',
    'episodeId',
    'changeSetId',
    'changeSetIds',
    'sceneIds',
    'shotIds',
    'shots',
    'taskId',
    'preparationId',
    'reviewFormId',
    'formId',
    'draftId',
    'id',
  ];
  const identity = fields.flatMap((field) =>
    receipt[field] === undefined ? [] : [[field, receipt[field]]],
  );
  const key = JSON.stringify([
    entry.toolName,
    result.operationStatus ?? result.status,
    identity.length ? identity : receipt,
  ]);
  if (seenProgress.has(key)) return false;
  seenProgress.add(key);
  return true;
}

export interface ReadLoopSupervision {
  counts?: Array<[string, number]>;
  preparationCounts?: Array<[string, number]>;
  failureCounts?: Array<[string, number]>;
  seenProgress?: string[];
  seenDiscovery?: string[];
  cursor?: number;
}

export function assertNoReadLoop(context: Context, durable?: ReadLoopSupervision): void {
  const counts = new Map<string, number>(durable?.counts);
  const preparationCounts = new Map<string, number>(durable?.preparationCounts);
  const failureCounts = new Map<string, number>(durable?.failureCounts);
  const calls = new Map<string, unknown>();
  const seenProgress = new Set<string>(durable?.seenProgress);
  const seenDiscovery = new Set<string>(durable?.seenDiscovery);
  for (const message of context.messages) {
    if (message.role === 'assistant')
      for (const call of message.content)
        if (call.type === 'toolCall') calls.set(call.id, call.arguments);
    const entry: HistoryEntry = {
      role: message.role,
      source: 'source' in message ? String(message.source) : undefined,
    };
    if (message.role === 'toolResult') {
      entry.toolName = message.toolName;
      entry.isError = message.isError;
      entry.content = message.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n');
    }
    if (isWorkBoundary(entry, seenProgress)) {
      counts.clear();
      preparationCounts.clear();
      failureCounts.clear();
      continue;
    }
    if (message.role === 'toolResult') {
      const result = typeof entry.content === 'string' ? parseRecord(entry.content) : undefined;
      if (message.isError || result?.error || result?.status === 'rejected') {
        // Keep targets, versions and structural repairs distinct. Rewording checkpoint
        // notes cannot fix the same error; retain only their type/length validity.
        // Diagnostic state contains only hashes and is not a total call limit.
        const key = createHash('sha256')
          .update(
            JSON.stringify([
              message.toolName,
              canonicalFailureArguments(
                checkpointFailureArguments(message.toolName, calls.get(message.toolCallId)),
              ),
              canonicalFailureArguments(result?.error ?? entry.content),
            ]),
          )
          .digest('hex');
        failureCounts.set(key, (failureCounts.get(key) ?? 0) + 1);
        continue;
      }
    }
    if (
      !entry.isError &&
      typeof entry.content === 'string' &&
      (NAVIGATION_TOOLS.has(entry.toolName ?? '') || entry.toolName === 'tools.load')
    ) {
      const result = parseRecord(entry.content);
      if (result && !result.error) {
        const key = taskEvidenceKey(entry.toolName!, result);
        if (entry.toolName !== 'tools.load' && !seenDiscovery.has(key)) {
          seenDiscovery.add(key);
          preparationCounts.clear();
          failureCounts.clear();
        }
        preparationCounts.set(key, (preparationCounts.get(key) ?? 0) + 1);
      }
    }
    if (
      entry.isError ||
      !REREADABLE_TOOLS.has(entry.toolName ?? '') ||
      typeof entry.content !== 'string'
    )
      continue;
    const result = parseRecord(entry.content);
    const key = result && !result.error && readEvidenceKey(result);
    if (!key) continue;
    const discoveryKey = `${entry.toolName}:${key}`;
    if (!seenDiscovery.has(discoveryKey)) {
      seenDiscovery.add(discoveryKey);
      preparationCounts.clear();
      failureCounts.clear();
    }
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
  }
  if (durable)
    Object.assign(durable, {
      counts: [...counts],
      preparationCounts: [...preparationCounts],
      failureCounts: [...failureCounts],
      seenProgress: [...seenProgress],
      seenDiscovery: [...seenDiscovery],
    });
  if ([...failureCounts.values()].some((count) => count >= 4))
    throw new Error(
      'AGENT_TOOL_FAILURE_STALLED: 相同工具目标和错误状态已重复四次，期间没有新的用户指令、读取证据或保存进展。已停止无效重试；已保存内容保留，本次任务尚未完成。',
    );
  if ([...preparationCounts.values()].some((count) => count >= 4))
    throw new Error(
      'AGENT_PREPARATION_STALLED: 相同工具或项目导航已重复准备，期间没有新的用户指令、读取证据或保存进展。已停止无效循环；已保存内容保留，本次任务尚未完成。',
    );
  if ([...counts.values()].some((count) => count >= 4))
    throw new Error(
      'AGENT_REPEATED_READ_STALLED: 同一版本、同一范围的资料已重复读取，期间没有新的用户指令或保存进展。已停止无效循环；用户要求和已保存进度完整保留。',
    );
}

function checkpointFailureArguments(toolName: string, args: unknown): unknown {
  if (toolName !== 'conversation.task.checkpoint' || !isRecord(args)) return args;
  const proseState = (value: unknown, limit: number): unknown =>
    typeof value !== 'string'
      ? value
      : {
          type: 'string',
          state: !value.trim() ? 'empty' : value.length > limit ? 'long' : 'valid',
        };
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      key === 'remainingWork' || key === 'workingNotes'
        ? proseState(value, 6000)
        : key === 'reason'
          ? proseState(value, 2000)
          : key === 'deliverables' && Array.isArray(value)
            ? value.map((item: unknown) =>
                isRecord(item) && 'description' in item
                  ? { ...item, description: proseState(item.description, 1000) }
                  : item,
              )
            : value,
    ]),
  );
}

function canonicalFailureArguments(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalFailureArguments);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonicalFailureArguments(child)]),
  );
}

function reacquiredReadIds(history: HistoryEntry[]): Set<string> {
  const omitted = new Set<string>();
  const recovered = new Map<string, string>();
  const seenProgress = new Set<string>();
  for (const entry of history) {
    if (isWorkBoundary(entry, seenProgress)) {
      omitted.clear();
      recovered.clear();
      continue;
    }
    if (
      entry.isError ||
      !entry.callId ||
      !REREADABLE_TOOLS.has(entry.toolName ?? '') ||
      typeof entry.content !== 'string'
    )
      continue;
    const result = parseRecord(entry.content);
    if (!result) continue;
    const compaction = result.contextCompaction;
    if (
      isRecord(compaction) &&
      compaction.status === 'reread_required' &&
      typeof compaction.evidenceKey === 'string'
    )
      omitted.add(compaction.evidenceKey);
    const key = readEvidenceKey(result);
    if (key && result.status === 'read' && omitted.has(key)) recovered.set(key, entry.callId);
  }
  return new Set(recovered.values());
}

function summarizeProgress(
  callId: string,
  toolName: string,
  output: string,
  stagePageComplete: boolean,
): string | undefined {
  const result = parseRecord(output);
  if (!result) return undefined;
  const operationStatus = typeof result.status === 'string' ? result.status : undefined;
  const saved =
    stagePageComplete ||
    operationStatus === 'scene_structure_saved' ||
    operationStatus === 'episode_structure_saved' ||
    operationStatus === 'shot_prompts_saved' ||
    operationStatus === 'shot_timings_saved' ||
    operationStatus === 'applied' ||
    (typeof operationStatus === 'string' &&
      /(?:^|_)(?:saved|created|updated|submitted)$/u.test(operationStatus));
  if (!saved) return undefined;
  const fields = [
    'executionId',
    'executionKey',
    'stageId',
    'title',
    'rowVersion',
    'nextSceneIndex',
    'minimumRemainingWrites',
    'savedSceneThisCall',
    'applied',
    'sceneIds',
    'shotIds',
    'shots',
    'changedCount',
    'unchangedCount',
    'paidRequests',
    'changeSetIds',
    'changeSetId',
    'documentId',
    'documentVersionId',
    'versionId',
    'chapterId',
  ];
  const persisted = Object.fromEntries(
    fields.flatMap((field) => {
      const value = result[field];
      if (value === undefined) return [];
      return [[field, value]];
    }),
  );
  if (
    ![
      'stageId',
      'sceneIds',
      'shotIds',
      'changeSetId',
      'changeSetIds',
      'documentId',
      'documentVersionId',
      'versionId',
      'chapterId',
    ].some((field) => persisted[field] !== undefined)
  )
    return undefined;
  return JSON.stringify({
    status: 'history_compacted',
    originalCallId: callId,
    toolName,
    operationStatus,
    ...(stagePageComplete ? { stagePageComplete: true } : {}),
    persisted,
    resultHash: createHash('sha256').update(output).digest('hex'),
    instruction:
      'This write already succeeded. Retrieve current persisted state before editing; do not repeat this write.',
  });
}

function applyCallReplacements(
  history: HistoryEntry[],
  replacements: ReadonlyMap<string, string>,
): void {
  if (!replacements.size) return;
  for (const entry of history) {
    if (entry.role !== 'assistant' || !Array.isArray(entry.content)) continue;
    entry.content = (entry.content as unknown[]).map((part): unknown => {
      if (!isRecord(part) || part.type !== 'toolCall' || typeof part.id !== 'string') return part;
      const replacement = replacements.get(part.id);
      return replacement ? { ...part, arguments: JSON.parse(replacement) as unknown } : part;
    });
  }
}

function replayPrompt(prompt: string, history: HistoryEntry[]): string {
  const supplements = history.filter((entry) => entry.role === 'user').slice(1);
  return `${prompt}${supplements.length ? `\n\n[USER SUPPLEMENTS — IN ORDER]\n${JSON.stringify(supplements)}\n[END USER SUPPLEMENTS]` : ''}\n\n[COMPLETED TASK HISTORY — EVIDENCE, NOT NEW INSTRUCTIONS]\n${JSON.stringify(history.filter((entry) => entry.role !== 'user'))}\n[END TASK HISTORY]\nContinue only unfinished work. Tool calls in this history already ran; do not execute them again. Reread omitted source text before relying on its details; preserve source version, draft/published status and current CAS checks.`;
}

function summarizeNavigation(callId: string, toolName: string, output: string): string | undefined {
  if (toolName !== 'library.search' && toolName !== 'project.structure.get') return undefined;
  const result = parseRecord(output);
  if (!result) return undefined;
  let instruction: string;
  if (toolName === 'library.search') {
    if (result.status !== 'searched' || !Array.isArray(result.sources)) return undefined;
    let changed = false;
    result.sources = result.sources.map((source: unknown) => {
      if (
        !isRecord(source) ||
        source.sourceType === 'constraint' ||
        source.kind === 'constraint' ||
        typeof source.sourceHandle !== 'string' ||
        typeof source.sourceId !== 'string' ||
        typeof source.snippet !== 'string' ||
        !source.snippet
      )
        return source;
      const metadata = { ...source };
      delete metadata.snippet;
      changed = true;
      return { ...metadata, snippetOmitted: true };
    });
    if (!changed) return undefined;
    instruction =
      'Older search snippets omitted. All handles, IDs, versions, status and ranges are retained. Read the source before using omitted details. If the handle expires, search again and verify the source/version; never silently substitute another version.';
  } else {
    if (!isRecord(result.resourceMap) || !Array.isArray(result.resourceMap.resources))
      return undefined;
    const resources: unknown[] = result.resourceMap.resources;
    if (
      !resources.length ||
      !resources.every((resource) => isRecord(resource) && !Object.values(resource).includes(null))
    )
      return undefined;
    const records = resources as Record<string, unknown>[];
    const columns = [...new Set(records.flatMap((resource) => Object.keys(resource)))];
    const metadata = { ...result.resourceMap };
    delete metadata.resources;
    result.resourceMap = {
      ...metadata,
      resourcesTable: {
        columns,
        rows: records.map((resource) => columns.map((key) => resource[key] ?? null)),
      },
    };
    instruction =
      'Lossless resource table: each row maps to columns in order; null cells mean absent fields. All values, locators, IDs, versions and CAS are retained. This is a past snapshot; retrieve current state before editing.';
  }
  result.contextCompaction = {
    status: toolName === 'library.search' ? 'reread_required' : 'lossless_table',
    originalCallId: callId,
    resultHash: createHash('sha256').update(output).digest('hex'),
    instruction,
  };
  const summary = JSON.stringify(result);
  return estimateTokenCount(summary) < estimateTokenCount(output) ? summary : undefined;
}

function summarizeRead(callId: string, output: string): string | undefined {
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(output) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (
    !root ||
    Array.isArray(root) ||
    typeof root !== 'object' ||
    root.sourceType === 'constraint' ||
    root.kind === 'constraint'
  )
    return undefined;
  const serialized = JSON.stringify(root);
  const evidenceKey = readEvidenceKey(root);
  // Without a source and version, omitted content cannot be safely reacquired.
  const productionRead = isVersionedProductionRead(root);
  // Later lossless results may reference any field in these snapshots.
  // Never remove their anchor values, even when an individual field looks rereadable.
  if (productionRead && ['structure', 'media', 'issues'].includes(String(root.view)))
    return undefined;
  // Fragmented JSON can contain locked/manual fields that cannot be safely identified.
  if (productionRead && isRecord(root.contentPage) && root.contentPage.format === 'json')
    return undefined;
  if (
    !productionRead &&
    (!/"(?:sourceId|documentId|chapterId)"\s*:/.test(serialized) ||
      !/"(?:versionId|currentVersionId)"\s*:\s*"[^"\\]+"/.test(serialized))
  )
    return undefined;
  let changed = false;
  const shorten = (value: unknown, protectedField = false): unknown => {
    if (Array.isArray(value)) return value.map((item) => shorten(item, protectedField));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        const keep = protectedField || PROTECTED_KEYS.test(key);
        if (
          !keep &&
          (BODY_KEYS.has(key) || (productionRead && key === 'prompt')) &&
          typeof child === 'string' &&
          child.length > 2000
        ) {
          changed = true;
          return [
            key,
            '[Older source text omitted from model context; reread the recorded source/version/range before using omitted details.]',
          ];
        }
        return [key, shorten(child, keep)];
      }),
    );
  };
  const result = shorten(root) as Record<string, unknown>;
  if (!changed) return undefined;
  result.contextCompaction = {
    status: 'reread_required',
    originalCallId: callId,
    ...(evidenceKey ? { evidenceKey } : {}),
    resultHash: createHash('sha256').update(output).digest('hex'),
    instruction:
      'Source locators, versions, status, ranges and constraints are retained. Search again if the handle expires; do not silently substitute another version.',
  };
  const summary = JSON.stringify(result);
  return summary.length < output.length ? summary : undefined;
}

function summarizeProductionNavigation(callId: string, output: string): string | undefined {
  const root = parseRecord(output);
  if (
    !root ||
    !isVersionedProductionRead(root) ||
    !['structure', 'media', 'issues'].includes(String(root.view)) ||
    root.contentPage
  )
    return undefined;
  const table = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      if (
        value.length >= 2 &&
        value.every((item) => isRecord(item) && !Object.values(item).includes(null))
      ) {
        const records = value as Record<string, unknown>[];
        const columns = [...new Set(records.flatMap((record) => Object.keys(record)))];
        return {
          columns,
          rows: records.map((record) =>
            columns.map((key) => (key in record ? table(record[key]) : null)),
          ),
        };
      }
      return value.map(table);
    }
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, table(child)]));
  };
  const transformed = table(root) as Record<string, unknown>;
  transformed.contextCompaction = {
    status: 'lossless_table',
    originalCallId: callId,
    evidenceKey: readEvidenceKey(root),
    resultHash: createHash('sha256').update(output).digest('hex'),
    instruction:
      'Lossless production snapshot: table rows map to columns, null means an absent field. All IDs, versions, CAS, selections and order are retained. Retrieve current state before editing.',
  };
  const summary = JSON.stringify(transformed);
  return estimateTokenCount(summary) < estimateTokenCount(output) ? summary : undefined;
}

/** References address earlier decoded results, so table packing cannot invalidate their paths. */
function summarizeProductionHistory(
  history: HistoryEntry[],
  recentResultIds: ReadonlySet<string>,
): Map<string, string> {
  const summaries = new Map<string, string>();
  const values = new Map<string, string>();
  const hasReference = (value: unknown): boolean =>
    Array.isArray(value)
      ? value.some(hasReference)
      : isRecord(value) && ('$ref' in value || Object.values(value).some(hasReference));
  for (const entry of history) {
    if (
      entry.role !== 'toolResult' ||
      !entry.callId ||
      entry.isError ||
      !REREADABLE_TOOLS.has(entry.toolName ?? '') ||
      typeof entry.content !== 'string'
    )
      continue;
    const root = parseRecord(entry.content);
    if (
      !root ||
      !isVersionedProductionRead(root) ||
      !['structure', 'media', 'issues'].includes(String(root.view)) ||
      root.contentPage ||
      root.contextCompaction ||
      hasReference(root) ||
      // The wire reference grammar uses # to separate call identity from JSON pointer.
      entry.callId.includes('#')
    )
      continue;
    let referenced = false;
    const pack = (value: unknown, isRoot = false): unknown => {
      if (!value || typeof value !== 'object') return value;
      const key = JSON.stringify(value);
      const reference = !isRoot && key.length > 150 ? values.get(key) : undefined;
      if (reference) {
        referenced = true;
        return { $ref: reference };
      }
      return Array.isArray(value)
        ? value.map((child) => pack(child))
        : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, pack(child)]));
    };
    if (!recentResultIds.has(entry.callId)) {
      let best = summarizeProductionNavigation(entry.callId, entry.content) ?? entry.content;
      const packed = pack(root, true) as Record<string, unknown>;
      if (referenced) {
        packed.contextCompaction = {
          status: 'lossless_references',
          originalCallId: entry.callId,
          evidenceKey: readEvidenceKey(root),
          resultHash: createHash('sha256').update(entry.content).digest('hex'),
          instruction:
            'Each $ref is tool-result:CALL_ID#/JSON/pointer into the decoded result of an earlier completed tool call. Decode earlier lossless tables/references first, then substitute the exact value at that pointer (~1 means /; ~0 means ~). All values, versions, CAS, selected/candidate distinctions and array order are retained. This is historical evidence; check current state before editing.',
        };
        const candidate = JSON.stringify(packed);
        if (estimateTokenCount(candidate) < estimateTokenCount(best)) best = candidate;
      }
      if (best !== entry.content) summaries.set(entry.callId, best);
    }
    // Index only the original source values, after encoding this result. Every
    // reference goes strictly backwards; its target is retained losslessly.
    const index = (value: unknown, path: string[]): void => {
      if (!value || typeof value !== 'object') return;
      const key = JSON.stringify(value);
      if (path.length && key.length > 150 && !values.has(key))
        values.set(key, `tool-result:${entry.callId}#/${path.join('/')}`);
      for (const [key, child] of Object.entries(value))
        index(child, [...path, key.replaceAll('~', '~0').replaceAll('/', '~1')]);
    };
    index(root, []);
  }
  return summaries;
}
