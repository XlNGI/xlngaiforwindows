import { describe, expect, it } from 'vitest';
import { CHARACTER_SHEET_IMAGE_REQUIREMENTS } from '@ai-video/contracts';
import { composeCharacterImagePrompt } from './character-image-prompt.js';

describe('character image prompts', () => {
  it('keeps the authored character design and adds the complete default sheet layout', () => {
    const prompt = composeCharacterImagePrompt('林澈，灯塔守望员；黑色长发，穿青色雨衣。');

    expect(prompt).toContain('林澈，灯塔守望员；黑色长发，穿青色雨衣。');
    expect(prompt).toContain('正面、前 3/4 面、侧面、背面、后 3/4 面');
    expect(prompt).toContain('正面、3/4 面、侧面、俯视、仰视、动态角度');
    expect(prompt).toContain('主色、辅色、点缀色');
    expect(prompt).toContain('未知信息省略，不编造');
    expect(prompt).toContain('本次明确要求头像、单幅立绘、仅三视图或其他版式');
  });

  it('does not duplicate requirements or add them to empty documents', () => {
    expect(composeCharacterImagePrompt('   ')).toBe('');
    const existing = `已有正文\n\n${CHARACTER_SHEET_IMAGE_REQUIREMENTS}`;
    expect(composeCharacterImagePrompt(existing)).toBe(existing);
  });
});
