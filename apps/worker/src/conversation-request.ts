/** Compatibility framing only: semantic task routing remains the LLM's decision. */
export function composeConversationRequest(request: string, constraints: string): string {
  // Even an empty template needs a boundary: the request itself may contain
  // literal legacy markers or a JSON frame that is just user-authored text.
  return `【会话请求 JSON v2】\n${JSON.stringify({ request, constraints })}`;
}

export function splitConversationRequest(prompt: string): { request: string; constraints: string } {
  const frame = '【会话请求 JSON v2】\n';
  if (prompt.startsWith(frame)) {
    try {
      const value = JSON.parse(prompt.slice(frame.length)) as Record<string, unknown>;
      if (typeof value.request === 'string' && typeof value.constraints === 'string')
        return { request: value.request, constraints: value.constraints };
    } catch {
      /* Legacy unframed requests remain readable. */
    }
  }
  const prefix = '【本会话要求约束】\n';
  const separator = '\n\n【用户本次请求】\n';
  const normalized = prompt.replace(/\r\n/g, '\n');
  const boundary = normalized.indexOf(separator, prefix.length);
  if (normalized.startsWith(prefix) && boundary >= 0)
    return {
      constraints: normalized.slice(prefix.length, boundary),
      request: normalized.slice(boundary + separator.length),
    };
  return { request: prompt, constraints: '' };
}
