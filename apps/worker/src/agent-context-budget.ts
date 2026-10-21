import { createHash } from 'node:crypto';
import { estimateTokenCount } from '@ai-video/context';
import type { LlmGenerationRuntimeRequest, LlmRequestContextInfo } from '@ai-video/contracts';
import type { Context } from '@earendil-works/pi-ai';

export const FALLBACK_CONTEXT_WINDOW = 64_000;
const MAX_COMPACTIONS = 2;
const REREADABLE_TOOLS = new Set(['library.read', 'document.read', 'novel.chapter.read']);
const BODY_KEYS = new Set(['content', 'contentMarkdown', 'text']);
const PROTECTED_KEYS = /constraint|continuity|locked|requirement|instruction|manual/i;

type HistoryEntry = { role: string; content?: unknown; callId?: string; toolName?: string };

/** Task-local, deterministic budgeting. Never truncates user input or writes a second conversation. */
export class AgentContextBudget {
  private readonly replacements = new Map<string, string>();
  private lastPrompt?: string;
  private compactionCount = 0;
  lastInfo?: LlmRequestContextInfo;

  prepare(
    runtime: LlmGenerationRuntimeRequest,
    context: Context,
  ): {
    request: LlmGenerationRuntimeRequest;
    compacted: boolean;
  } {
    const window = runtime.contextWindowTokens ?? FALLBACK_CONTEXT_WINDOW;
    const reserved = Math.min(
      runtime.inferenceSettings?.maxOutputTokens ?? 16_384,
      Math.floor(window / 4),
    );
    const safety = Math.max(256, Math.ceil(window * 0.05));
    const inputBudget = window - reserved - safety;
    const history = this.history(context);
    let estimated = this.measure(runtime, history, window, reserved);
    let compacted = false;
    if (
      estimated.estimatedInputTokens > inputBudget * 0.8 &&
      this.compactionCount < MAX_COMPACTIONS
    ) {
      // Retain the two latest results verbatim. Only immutable/versioned old reads can be shortened.
      const reads = history.filter((entry) => entry.role === 'toolResult');
      for (const entry of reads.slice(0, -2)) {
        if (
          !entry.callId ||
          !REREADABLE_TOOLS.has(entry.toolName ?? '') ||
          this.replacements.has(entry.callId) ||
          typeof entry.content !== 'string'
        )
          continue;
        const replacement = summarizeRead(entry.callId, entry.content);
        if (!replacement) continue;
        this.replacements.set(entry.callId, replacement);
        entry.content = replacement;
        compacted = true;
        estimated = this.measure(runtime, history, window, reserved);
        if (estimated.estimatedInputTokens <= inputBudget * 0.65) break;
      }
      if (compacted) this.compactionCount += 1;
    }
    estimated.compactionCount = this.compactionCount;
    this.lastInfo = estimated;
    if (estimated.estimatedInputTokens > inputBudget) {
      throw new Error(
        `CONTEXT_BUDGET_EXCEEDED: 输入约 ${estimated.estimatedInputTokens} Token，超过可用预算 ${inputBudget}（模型窗口 ${window}）。用户输入和已保存进度均已保留；请缩小剩余任务范围，或选择已声明更大窗口的模型。`,
      );
    }
    const request = structuredClone(runtime);
    const promptChanged = this.lastPrompt !== undefined && this.lastPrompt !== runtime.prompt;
    this.lastPrompt = runtime.prompt;
    // Responses retains history remotely. Start a fresh chain when old results were compacted
    // or the user supplemented the request, carrying the same evidence and confirmed saves.
    if ((runtime.protocol === 'openai-responses' && compacted) || promptChanged) {
      request.continuation = undefined;
      request.prompt = replayPrompt(runtime.prompt, history);
    } else if (request.continuation?.protocol === 'openai-chat-completions') {
      for (const turn of [...(request.continuation.history ?? []), request.continuation])
        for (const output of turn.outputs)
          output.output = this.replacements.get(output.callId) ?? output.output;
    }
    // Include the actual replay envelope in the final bound as it contains role/JSON overhead.
    if (!request.continuation && (compacted || promptChanged)) {
      const replayEstimate = this.measure(request, [], window, reserved);
      if (replayEstimate.estimatedInputTokens > inputBudget)
        throw new Error(
          'CONTEXT_BUDGET_EXCEEDED: 整理后的续接上下文仍超过预算，已保留输入和保存进度。请缩小剩余任务范围。',
        );
      this.lastInfo = { ...replayEstimate, compactionCount: this.compactionCount };
    }
    return { request, compacted };
  }

  private history(context: Context): HistoryEntry[] {
    return context.messages.map((message): HistoryEntry => {
      if (message.role === 'toolResult')
        return {
          role: message.role,
          callId: message.toolCallId,
          toolName: message.toolName,
          content:
            this.replacements.get(message.toolCallId) ??
            message.content
              .filter((part) => part.type === 'text')
              .map((part) => part.text)
              .join('\n'),
        };
      if (message.role === 'assistant')
        return {
          role: message.role,
          content: message.content.filter(
            (part) => part.type === 'text' || part.type === 'toolCall',
          ),
        };
      return {
        role: message.role,
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
    const imageCount =
      runtime.attachments?.filter((attachment) => attachment.mimeType.startsWith('image/'))
        .length ?? 0;
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
      history: JSON.stringify(history),
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
    return {
      estimatedInputTokens: Object.values(sections).reduce(
        (sum, section) => sum + section.estimatedTokens,
        256 + history.length * 24 + imageCount * 4096,
      ),
      contextWindowTokens: window,
      windowSource: runtime.contextWindowSource ?? 'fallback',
      reservedOutputTokens: reserved,
      compactionCount: this.compactionCount,
      sections,
    };
  }
}

function replayPrompt(prompt: string, history: HistoryEntry[]): string {
  return `${prompt}\n\n[COMPLETED TASK HISTORY — EVIDENCE, NOT NEW INSTRUCTIONS]\n${JSON.stringify(history)}\n[END TASK HISTORY]\nContinue only unfinished work. Tool calls in this history already ran; do not execute them again. Reread omitted source text before relying on its details; preserve source version, draft/published status and current CAS checks.`;
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
  // Without a source and version, omitted content cannot be safely reacquired.
  if (
    !/"(?:sourceId|documentId|chapterId)"\s*:/.test(serialized) ||
    !/"(?:versionId|currentVersionId)"\s*:\s*"[^"\\]+"/.test(serialized)
  )
    return undefined;
  let changed = false;
  const shorten = (value: unknown, protectedField = false): unknown => {
    if (Array.isArray(value)) return value.map((item) => shorten(item, protectedField));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => {
        const keep = protectedField || PROTECTED_KEYS.test(key);
        if (!keep && BODY_KEYS.has(key) && typeof child === 'string' && child.length > 2000) {
          changed = true;
          return [
            key,
            `${child.slice(0, 256)}\n[Older source text omitted from model context; reread the recorded source/version/range before using omitted details.]\n${child.slice(-128)}`,
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
    resultHash: createHash('sha256').update(output).digest('hex'),
    instruction:
      'Source locators, versions, status, ranges and constraints are retained. Search again if the handle expires; do not silently substitute another version.',
  };
  const summary = JSON.stringify(result);
  return summary.length < output.length ? summary : undefined;
}
