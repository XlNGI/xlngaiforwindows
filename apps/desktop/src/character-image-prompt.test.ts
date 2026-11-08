import { describe, expect, it } from 'vitest';
import { composeCharacterImagePrompt } from './character-image-prompt.js';

describe('character image prompts', () => {
  it('passes authored character text through unchanged', () => {
    const authored = '林澈，灯塔守望员；黑色长发，穿青色雨衣。';

    expect(composeCharacterImagePrompt(authored)).toBe(authored);
  });

  it('trims only the outer whitespace', () => {
    expect(composeCharacterImagePrompt('   ')).toBe('');
    expect(composeCharacterImagePrompt('  已有正文  ')).toBe('已有正文');
  });
});
