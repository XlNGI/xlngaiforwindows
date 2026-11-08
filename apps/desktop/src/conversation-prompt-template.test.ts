import { describe, expect, it } from 'vitest';
import {
  SCENE_REFERENCE_IMAGE_REQUIREMENTS,
  VIDEO_PROMPT_AUTHORING_REQUIREMENTS,
} from '@ai-video/contracts';
import {
  composeConversationPrompt,
  SCENE_PROMPT_CONSTRAINT_TEMPLATE,
  splitComposedConversationPrompt,
} from './conversation-prompt-template.js';

describe('conversation prompt constraints', () => {
  it('uses composite scene image guidance without changing a custom template', () => {
    expect(SCENE_PROMPT_CONSTRAINT_TEMPLATE).toContain(SCENE_REFERENCE_IMAGE_REQUIREMENTS);
    expect(SCENE_PROMPT_CONSTRAINT_TEMPLATE).toContain(
      '每个场景默认生成一张主图为全景、次图为关键特写的复合参考图',
    );
    expect(SCENE_PROMPT_CONSTRAINT_TEMPLATE).toContain(
      '同一场景的全景和特写合在一个画布及一次生图请求中',
    );
    expect(composeConversationPrompt('生成场景图', '只制作一张正面图')).toBe(
      '【本会话要求约束】\n只制作一张正面图\n\n【用户本次请求】\n生成场景图',
    );
  });

  it('splits the displayed constraint from the request without losing either part', () => {
    const composed = composeConversationPrompt('生成场次', '固定风格\n标注镜头运动');
    expect(splitComposedConversationPrompt(composed)).toEqual({
      constraints: '固定风格\n标注镜头运动',
      request: '生成场次',
    });
    expect(splitComposedConversationPrompt('普通请求')).toBeUndefined();
    expect(
      splitComposedConversationPrompt(
        '【本会话要求约束】\r\n固定风格\r\n\r\n【用户本次请求】\r\n生成场次',
      ),
    ).toEqual({ constraints: '固定风格', request: '生成场次' });
  });

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
