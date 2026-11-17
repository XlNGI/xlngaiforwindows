import { describe, expect, it } from 'vitest';
import { DEFAULT_PROMPT_TEMPLATES } from '@ai-video/contracts';
import {
  composeConversationPrompt,
  splitComposedConversationPrompt,
} from './conversation-prompt-template';
describe('conversation prompt templates', () => {
  it('keeps each starter scoped to its purpose', () => {
    expect(DEFAULT_PROMPT_TEMPLATES['character-image']).toContain('全身五视图');
    expect(DEFAULT_PROMPT_TEMPLATES['video-prompt']).not.toContain('全身五视图');
    expect(DEFAULT_PROMPT_TEMPLATES['scene-image']).not.toContain('动态流程');
    expect(DEFAULT_PROMPT_TEMPLATES['shot-image']).toContain('静态');
  });
  it('retains legacy display framing and respects empty custom templates', () => {
    const composed = composeConversationPrompt('写镜头', '自定义要求');
    expect(splitComposedConversationPrompt(composed)).toEqual({
      request: '写镜头',
      constraints: '自定义要求',
    });
    expect(composeConversationPrompt('普通请求', '')).toBe('普通请求');
    expect(splitComposedConversationPrompt('普通请求')).toBeUndefined();
  });
  it('displays exact new framed input, including empty templates and literal old markers', () => {
    const request = '【本会话要求约束】\n原文\n\n【用户本次请求】\n仍是原文\r\n  ';
    for (const constraints of ['', '模板\r\n  原文\n【用户本次请求】\n']) {
      expect(
        splitComposedConversationPrompt(
          `【会话请求 JSON v2】\n${JSON.stringify({ request, constraints })}`,
        ),
      ).toEqual({ request, constraints });
    }
  });
});
