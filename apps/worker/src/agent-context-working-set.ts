import type { Context } from '@earendil-works/pi-ai';

/** Retain whole protocol groups; a tool batch is never cut at an arbitrary message count. */
export function contextWorkingSet(
  messages: Context['messages'],
  targetSize = 32,
): Context['messages'] {
  const groups: Context['messages'][] = [];
  let calls = new Set<string>();
  for (const message of messages) {
    if (message.role === 'toolResult') {
      if (calls.has(message.toolCallId)) groups.at(-1)!.push(message);
      continue;
    }
    groups.push([message]);
    calls = new Set(
      message.role === 'assistant'
        ? message.content.filter((p) => p.type === 'toolCall').map((p) => p.id)
        : [],
    );
  }
  let size = 0,
    start = groups.length;
  while (start > 0) {
    const next = groups[start - 1]!;
    if (size && size + next.length > targetSize) break;
    size += next.length;
    start--;
  }
  return groups.slice(start).flat();
}
