import type {
  AgentInputForm,
  AgentTaskDetail,
  ChatMessageInfo,
  MediaReviewSummary,
} from '@ai-video/contracts';

/** A delayed task snapshot must not erase stages already received by the conversation. */
export function newerAgentTaskDetail(
  current: AgentTaskDetail | undefined,
  incoming: AgentTaskDetail,
): AgentTaskDetail {
  if (!current) return incoming;
  const lastSequence = (detail: AgentTaskDetail) =>
    detail.events.reduce((last, event) => Math.max(last, event.sequence), -1);
  const order =
    lastSequence(incoming) - lastSequence(current) ||
    incoming.task.rowVersion - current.task.rowVersion ||
    incoming.task.updatedAt.localeCompare(current.task.updatedAt);
  return order < 0 ? current : incoming;
}

export type ConversationTimelineItem =
  | {
      kind: 'message';
      id: string;
      createdAt: string;
      message: ChatMessageInfo;
      content: string;
      streaming: boolean;
      staged: boolean;
    }
  | {
      kind: 'tools';
      id: string;
      createdAt: string;
      detail: AgentTaskDetail;
      messageId: string;
      tail: boolean;
      live: boolean;
      staged: boolean;
    }
  | { kind: 'form'; id: string; createdAt: string; form: MediaReviewSummary }
  | { kind: 'question'; id: string; createdAt: string; form: AgentInputForm };

/** Keep stored event order within a turn, and actual creation order between turns. */
export function conversationTimeline(
  messages: ChatMessageInfo[],
  tasks: Map<string, AgentTaskDetail>,
  liveMessageId?: string,
  forms: MediaReviewSummary[] = [],
): ConversationTimelineItem[] {
  const items: ConversationTimelineItem[] = [];
  const questionIds = new Set<string>();
  const questions = (events: AgentTaskDetail['events']): ConversationTimelineItem[] =>
    events.flatMap((event) => {
      if (!event.userInput || questionIds.has(event.userInput.id)) return [];
      questionIds.add(event.userInput.id);
      return [
        {
          kind: 'question' as const,
          id: `question:${event.userInput.id}`,
          createdAt: event.createdAt,
          form: event.userInput,
        },
      ];
    });
  for (const message of messages) {
    const detail = message.role === 'assistant' ? tasks.get(message.id) : undefined;
    const live = message.id === liveMessageId;
    const events = detail?.events.slice().sort((a, b) => a.sequence - b.sequence) ?? [];
    const boundaries = events.filter((event) => event.messageBoundary?.messageId === message.id);
    if (!detail || boundaries.length === 0) {
      // Existing history has no text boundaries. Preserve it without inventing stages.
      const text: ConversationTimelineItem = {
        kind: 'message',
        id: message.id,
        createdAt: message.createdAt,
        message,
        content: message.content,
        streaming: live,
        staged: false,
      };
      const tools: ConversationTimelineItem | undefined = detail && {
        kind: 'tools',
        id: `tools:${detail.task.id}:${message.id}`,
        createdAt: message.createdAt,
        detail,
        messageId: message.id,
        tail: true,
        live,
        staged: false,
      };
      if (tools && !live) items.push(tools);
      items.push(text);
      if (tools && live) items.push(tools);
      items.push(...questions(events));
      continue;
    }
    const blocks: ConversationTimelineItem[] = [];
    const prefix = message.content.slice(0, boundaries[0]!.messageBoundary!.startOffset).trim();
    if (prefix)
      blocks.push({
        kind: 'message',
        id: `${message.id}:prefix`,
        createdAt: message.createdAt,
        message,
        content: prefix,
        streaming: false,
        staged: true,
      });
    let pending: AgentTaskDetail['events'] = [];
    const flushTools = (last = false) => {
      if (pending.length === 0 && !(last && live)) return;
      const first = pending[0];
      blocks.push({
        kind: 'tools',
        messageId: message.id,
        tail: last,
        id: `tools:${detail.task.id}:${first?.id ?? boundaries.at(-1)!.id}`,
        createdAt: first?.createdAt ?? boundaries.at(-1)!.createdAt,
        detail: {
          ...detail,
          task: last
            ? detail.task
            : { ...detail.task, status: 'completed', errorMessage: undefined },
          events: pending,
          librarySources: [],
        },
        live: last && live,
        staged: true,
      });
      // Include the tool receipt before the form; never split a tool's start/result pair.
      blocks.push(...questions(pending));
      pending = [];
    };
    for (const event of events) {
      const boundary = event.messageBoundary;
      if (!boundary || boundary.messageId !== message.id) {
        pending.push(event);
        continue;
      }
      flushTools();
      const next = boundaries[boundaries.indexOf(event) + 1];
      const start = boundary.startOffset;
      const end = next?.messageBoundary?.startOffset ?? message.content.length;
      const content = message.content.slice(start, Math.max(start, end)).trim();
      if (content)
        blocks.push({
          kind: 'message',
          id: event.id,
          createdAt: event.createdAt,
          message,
          content,
          streaming: live && !next,
          staged: true,
        });
    }
    flushTools(true);
    const lastTools = blocks
      .slice()
      .reverse()
      .find(
        (block) =>
          block.kind === 'tools' &&
          block.detail.events.some(
            (event) =>
              event.eventType === 'agent.tool.started' &&
              /library\.(search|read)/.test(event.summary),
          ),
      );
    if (lastTools?.kind === 'tools') lastTools.detail.librarySources = detail.librarySources;
    items.push(...blocks);
  }
  items.push(
    ...forms.map((form): ConversationTimelineItem => ({
      kind: 'form',
      id: `form:${form.id}`,
      createdAt: form.createdAt,
      form,
    })),
  );
  return items.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}
