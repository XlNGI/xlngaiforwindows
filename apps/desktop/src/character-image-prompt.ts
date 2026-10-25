import { CHARACTER_SHEET_IMAGE_REQUIREMENTS } from '@ai-video/contracts';

/** Seed the editable image form; preserve authored details without truncating them. */
export function composeCharacterImagePrompt(content: string): string {
  const prompt = content.trim();
  if (!prompt || prompt.includes(CHARACTER_SHEET_IMAGE_REQUIREMENTS)) return prompt;
  return `${prompt}\n\n${CHARACTER_SHEET_IMAGE_REQUIREMENTS}`;
}
