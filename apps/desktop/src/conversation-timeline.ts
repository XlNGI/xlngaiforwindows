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

export interface ConversationProcessGroup {
  messageId: string;
  itemIds: string[];
  label: string;
}

/** Collapse recorded progress only when a completed turn has a final visible reply. */
export function conversationProcessGroups(
  items: ConversationTimelineItem[],
  tasks: Map<string, AgentTaskDetail>,
): ConversationProcessGroup[] {
  const groups: ConversationProcessGroup[] = [];
  for (const [messageId, detail] of tasks) {
    if (detail.task.status !== 'completed' || detail.task.completionState === 'partial') continue;
    if (
      items.some(
        (item) =>
          item.kind === 'question' &&
          item.form.taskId === detail.task.id &&
          item.form.status === 'pending',
      )
    )
      continue;
    const stages = items.filter(
      (item) =>
        (item.kind === 'message' && item.message.id === messageId) ||
        (item.kind === 'tools' && item.messageId === messageId),
    );
    const final = stages
      .slice()
      .reverse()
      .find((item) => item.kind === 'message' && item.content.trim());
    if (
      final?.kind !== 'message' ||
      final.message.status !== 'complete' ||
      final.streaming ||
      stages.some((item) => item.kind === 'tools' && item.live) ||
      stages
        .slice(final ? stages.indexOf(final) + 1 : 0)
        .some(
          (item) =>
            item.kind === 'tools' &&
            item.detail.events.some((event) => event.eventType.startsWith('agent.tool.')),
        )
    )
      continue;
    const itemIds = stages.filter((item) => item !== final).map((item) => item.id);
    if (itemIds.length === 0) continue;
    const task = detail.task;
    const completed = detail.events.find((event) => event.eventType === 'agent.task.completed');
    const start = Date.parse(task.startedAt ?? task.createdAt);
    const end = Date.parse(task.completedAt ?? completed?.createdAt ?? task.updatedAt);
    const elapsed = end - start;
    let label = '执行过程';
    if (Number.isFinite(elapsed) && elapsed >= 0) {
      const seconds = Math.floor(elapsed / 1000);
      const hours = Math.floor(seconds / 3600);
      const minutes = Math.floor((seconds % 3600) / 60);
      const duration = [
        hours ? `${hours}小时` : '',
        minutes ? `${minutes}分钟` : '',
        seconds % 60 ? `${seconds % 60}秒` : '',
      ]
        .filter(Boolean)
        .join(' ');
      label = `用时 ${duration || '不足1秒'}`;
    }
    groups.push({ messageId, itemIds, label });
  }
  return groups;
}

/** Keep stored event order within a turn, and actual creation order between turns. */
export function conversationTimeline(
  messages: ChatMessageInfo[],
  tasks: Map<string, AgentTaskDetail>,
  liveMessageId?: string,
  forms: MediaReviewSummary[] = [],
): ConversationTimelineItem[] {
  const items: Array<{ item: ConversationTimelineItem; orderAt: string }> = [];
  const appendTurn = (blocks: ConversationTimelineItem[]) => {
    let orderAt = '';
    for (const item of blocks) {
      // Event sequence is authoritative within a turn. Separate callbacks can
      // stamp a receipt slightly earlier than the event that preceded it.
      if (item.createdAt > orderAt) orderAt = item.createdAt;
      items.push({ item, orderAt });
    }
  };
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
    const errorOnly =
      detail?.task.status === 'failed' &&
      message.status === 'failed' &&
      Boolean(detail.task.errorMessage) &&
      message.content.trim() === detail.task.errorMessage?.trim();
    if (!detail || boundaries.length === 0 || errorOnly) {
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
      const blocks: ConversationTimelineItem[] = [];
      if (tools && !live) blocks.push(tools);
      if (!errorOnly) blocks.push(text);
      if (tools && live) blocks.push(tools);
      blocks.push(...questions(events));
      appendTurn(blocks);
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
    // Older tasks sometimes saved their only explanatory text after asking.
    // Keep that introduction above its form, without inspecting the wording or
    // changing the recorded order of any other tool or assistant stage.
    const firstText = blocks.findIndex((block) => block.kind === 'message');
    if (firstText >= 0) {
      const precedingQuestions = blocks
        .slice(0, firstText)
        .filter((block) => block.kind === 'question');
      for (const question of precedingQuestions) blocks.splice(blocks.indexOf(question), 1);
      blocks.splice(
        blocks.findIndex((block) => block.kind === 'message') + 1,
        0,
        ...precedingQuestions,
      );
    }
    appendTurn(blocks);
  }
  for (const form of forms)
    items.push({
      item: { kind: 'form', id: `form:${form.id}`, createdAt: form.createdAt, form },
      orderAt: form.createdAt,
    });
  return items
    .sort((left, right) => left.orderAt.localeCompare(right.orderAt))
    .map(({ item }) => item);
}
