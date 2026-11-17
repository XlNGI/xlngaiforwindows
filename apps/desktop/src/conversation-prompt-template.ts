/** Historical framing remains readable; new submissions carry only purpose templates. */
export function composeConversationPrompt(userPrompt: string, template?: string): string {
  const constraint = template?.trim();
  return constraint
    ? `【本会话要求约束】\n${constraint}\n\n【用户本次请求】\n${userPrompt}`
    : userPrompt;
}

export function splitComposedConversationPrompt(
  prompt: string,
): { constraints: string; request: string } | undefined {
  const frame = '【会话请求 JSON v2】\n';
  if (prompt.startsWith(frame)) {
    try {
      const value = JSON.parse(prompt.slice(frame.length)) as Record<string, unknown>;
      if (typeof value.request === 'string' && typeof value.constraints === 'string')
        return { request: value.request, constraints: value.constraints };
    } catch {
      /* An unframed historical message remains ordinary text. */
    }
  }
  const normalized = prompt.replace(/\r\n/g, '\n');
  const prefix = '【本会话要求约束】\n';
  const separator = '\n\n【用户本次请求】\n';
  if (!normalized.startsWith(prefix)) return undefined;
  const boundary = normalized.indexOf(separator, prefix.length);
  if (boundary < 0) return undefined;
  return {
    constraints: normalized.slice(prefix.length, boundary),
    request: normalized.slice(boundary + separator.length),
  };
}
