/** Compatibility framing only: semantic task routing remains the LLM's decision. */
export function splitConversationRequest(prompt: string): { request: string; constraints: string } {
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
