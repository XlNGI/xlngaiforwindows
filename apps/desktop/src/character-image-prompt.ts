/** Return the Agent-authored document text without adding UI-generated requirements. */
export function composeCharacterImagePrompt(content: string): string {
  return content.trim();
}
