import { describe, expect, it } from 'vitest';
import { VIDEO_PROMPT_AUTHORING_REQUIREMENTS } from '@ai-video/contracts';
import {
  composeConversationPrompt,
  SCENE_PROMPT_CONSTRAINT_TEMPLATE,
} from './conversation-prompt-template.js';

describe('conversation prompt constraints', () => {
  it('keeps temporary props as individually generated assets with real references', () => {
    expect(SCENE_PROMPT_CONSTRAINT_TEMPLATE).toContain('每件道具分别提供独立的道具图片提示词');
    expect(SCENE_PROMPT_CONSTRAINT_TEMPLATE).toContain('不自动发起图片生成');
    expect(SCENE_PROMPT_CONSTRAINT_TEMPLATE).toContain('每件道具分别生成独立图片');
    expect(SCENE_PROMPT_CONSTRAINT_TEMPLATE).toContain('不能代替道具自身的独立素材');
    expect(SCENE_PROMPT_CONSTRAINT_TEMPLATE).toContain('引用实际读取／生成的道具资料 ID 和素材');
    expect(composeConversationPrompt('设计一场戏', SCENE_PROMPT_CONSTRAINT_TEMPLATE)).toContain(
      '临时道具独立生成',
    );
  });

  it('uses a full default character sheet while respecting explicitly requested layouts', () => {
    expect(SCENE_PROMPT_CONSTRAINT_TEMPLATE).toContain('全身五视图');
    expect(SCENE_PROMPT_CONSTRAINT_TEMPLATE).toContain('头部六角度');
    expect(SCENE_PROMPT_CONSTRAINT_TEMPLATE).toContain('材质参考与色彩板');
    expect(SCENE_PROMPT_CONSTRAINT_TEMPLATE).toContain('本次明确指定其他版式');
    expect(SCENE_PROMPT_CONSTRAINT_TEMPLATE).toContain('不添加超能力、符文或发光装饰');
  });

  it('includes the video prose format with reference roles, timed actions and scoped visibility', () => {
    const request = composeConversationPrompt(
      '写一段八秒的车站告别视频提示词',
      SCENE_PROMPT_CONSTRAINT_TEMPLATE,
    );
    expect(request).toContain(VIDEO_PROMPT_AUTHORING_REQUIREMENTS);
    expect(request).toContain(
      '输入图片说明 → 视频目标 → 【基础设定】→ 【氛围与画质】→ 动态流程 → 负面约束',
    );
    expect(request).toContain('参考图中的瞬间不自动成为第一帧');
    expect(request).toContain('纯背影、脸部不可见或完全遮挡的转场');
    expect(request).toContain(
      '由 LLM 根据动作复杂度、台词长度、表演停顿、镜头运动和叙事节奏自主设计自然时长',
    );
    expect(request).toContain('不套用固定秒数、均匀切分或示例时长');
    expect(request).toContain('视频提示词');
  });
});
