import { describe, expect, it } from 'vitest';
import {
  CHARACTER_SHEET_IMAGE_REQUIREMENTS,
  SCENE_REFERENCE_IMAGE_REQUIREMENTS,
  VIDEO_PROMPT_AUTHORING_REQUIREMENTS,
} from '@ai-video/contracts';
import {
  withAgentResponseLanguageInstruction,
  withAgentToolInstructions,
} from './agent-policy-instructions.js';
import { loadedToolGuidance } from './agent-workflow-guidance.js';

describe('Agent visible progress guidance', () => {
  it('requests user-facing updates during multi-step work without exposing private reasoning', () => {
    const instructions = withAgentResponseLanguageInstruction('project assistant');
    expect(instructions).toContain('面向用户的可见进展说明');
    expect(instructions).toContain('说明随执行过程出现并保留');
    expect(instructions).toContain('不写空泛的“我将调用工具”播报');
    expect(instructions).toContain('不要输出私有推演');
    expect(instructions).toContain('问答表单的标题、说明、问题、选项和选项描述');
    expect(instructions).toContain('不是切换回复语言的理由');
    expect(instructions).toContain('再调用 conversation.ask 展示表单');
    expect(instructions).toContain('不要把这些面向用户的进展只写进 thinking/reasoning 通道');
    expect(withAgentResponseLanguageInstruction(instructions)).toBe(instructions);
  });
});

describe('Agent character image guidance', () => {
  it('includes the sheet requirements for document authoring and direct image generation', () => {
    const instructions = withAgentToolInstructions('', [
      { name: 'document.submit_draft' },
      { name: 'media.image.prepare' },
    ]);

    expect(instructions).toContain('# Agent character image deliverable');
    expect(instructions).toContain(CHARACTER_SHEET_IMAGE_REQUIREMENTS);
    expect(instructions).toContain('只放在 contentIR.data、备注或聊天解释里不会进入生图');
  });

  it('requires current-session requirements in the final authored prompt', () => {
    const instructions = withAgentToolInstructions('', [
      { name: 'document.create_draft' },
      { name: 'scene.update_shot_prompts' },
      { name: 'library.search' },
      { name: 'media.image.prepare' },
    ]);

    expect(instructions).toContain('# Agent final prompt coverage policy');
    expect(instructions).toContain('本轮输入中的【本会话要求约束】和【用户本次请求】');
    expect(instructions).toContain('剧情约束文档使用 documentKind=constraint');
    expect(instructions).toContain('将已读取且适用的剧情、人物行为和连续性条款落实到作品内容');
    expect(instructions).toContain('只写在 contentIR.data、authoringIR.data、references');
    expect(instructions).toContain('界面只负责展示、参数审核和用户确认');
    expect(withAgentToolInstructions(instructions, [{ name: 'document.update_draft' }])).toBe(
      instructions,
    );
  });

  it('does not add character sheet requirements to scene-only authoring', () => {
    const instructions = withAgentToolInstructions('', [{ name: 'scene.submit_structure' }]);
    expect(instructions).not.toContain('# Agent character image deliverable');
  });

  it('delivers the same requirements through lazy image-tool loading', () => {
    expect(loadedToolGuidance(['media.image.prepare'])).toContain(
      CHARACTER_SHEET_IMAGE_REQUIREMENTS,
    );
  });
});

describe('Agent scene reference image guidance', () => {
  it.each([
    'document.submit_draft',
    'document.create_draft',
    'document.update_draft',
    'media.review.prepare',
    'media.image.prepare',
  ])('carries composite scene image guidance through %s and lazy tool loading', (name) => {
    const workflow = name.startsWith('document.') ? 'scene-image' : undefined;
    const instructions = withAgentToolInstructions('', [{ name }], workflow);
    expect(instructions).toContain(SCENE_REFERENCE_IMAGE_REQUIREMENTS);
    expect(instructions).toContain(
      '每个场景默认只准备一个完整提示词并调用一次 media.image.prepare',
    );
    expect(instructions).toContain('不要为全景和特写分别发起图片请求');
    expect(instructions).toContain('默认 n=1');
    expect(loadedToolGuidance([name], workflow)).toContain(SCENE_REFERENCE_IMAGE_REQUIREMENTS);
    expect(withAgentToolInstructions(instructions, [{ name }], workflow)).toBe(instructions);
  });

  it('keeps image requirements out of ordinary reads and scene/shot video authoring', () => {
    for (const name of ['library.read', 'scene.submit_structure', 'media.video.prepare']) {
      expect(withAgentToolInstructions('', [{ name }])).not.toContain(
        SCENE_REFERENCE_IMAGE_REQUIREMENTS,
      );
    }
  });
});

describe('Agent video prompt guidance', () => {
  it.each([
    'document.submit_draft',
    'document.create_draft',
    'document.update_draft',
    'scene.submit_structure',
    'scene.structure.stage',
    'scene.update_shot_prompts',
    'novel.episode.submit_structure',
    'media.video.prepare',
  ])('delivers the same video writing requirements through %s', (name) => {
    const workflow = name.startsWith('document.') ? 'video-prompt' : undefined;
    const instructions = withAgentToolInstructions('', [{ name }], workflow);
    expect(instructions).toContain(VIDEO_PROMPT_AUTHORING_REQUIREMENTS);
    expect(instructions).toContain(
      '分段内容时长由 LLM 根据动作复杂度、对白长度、表演停顿、镜头运动和叙事节奏自主设计',
    );
    expect(loadedToolGuidance([name], workflow)).toContain(VIDEO_PROMPT_AUTHORING_REQUIREMENTS);
  });

  it('keeps video writing defaults out of image-only and ordinary read tools', () => {
    const instructions = withAgentToolInstructions('', [
      { name: 'media.image.prepare' },
      { name: 'library.read' },
    ]);
    expect(instructions).not.toContain(VIDEO_PROMPT_AUTHORING_REQUIREMENTS);
  });
});

describe('Agent conversation input guidance', () => {
  it('declares the form protocol when conversation.ask is available', () => {
    const instructions = withAgentToolInstructions('', [{ name: 'conversation.ask' }]);

    expect(instructions).toContain('# Agent conversation input policy');
    expect(instructions).toContain('任务完成后的可选下一步也属于用户选择');
    expect(instructions).toContain('即使只用一句话表达');
    expect(instructions).toContain('完成情况和内容概览继续作为普通总结');
    expect(instructions).toContain('没有需要用户选择的方向时直接结束');
    expect(instructions).toContain('不要把待用户选择的编号列表');
    expect(instructions).toContain('不要解析 Markdown 猜测表单');
  });

  it('keeps the form protocol once when tools refresh after a write', () => {
    const initial = withAgentToolInstructions('项目助理', [{ name: 'conversation.ask' }]);
    const refreshed = withAgentToolInstructions(initial, [
      { name: 'conversation.ask' },
      { name: 'novel.chapter.write_draft' },
    ]);

    expect(refreshed.split('# Agent conversation input policy')).toHaveLength(2);
    expect(refreshed).toContain(initial);
  });

  it('does not add the form protocol when the tool is unavailable', () => {
    expect(withAgentToolInstructions('', [{ name: 'library.read' }])).not.toContain(
      '# Agent conversation input policy',
    );
  });

  it('applies the response language policy to every loaded tool set', () => {
    const instructions = withAgentToolInstructions('', [{ name: 'library.read' }]);
    expect(instructions).toContain('# Agent response language policy');
    expect(instructions).toContain('用户使用中文时使用简体中文');
    expect(instructions).toContain('除非用户明确要求翻译或输出英文');
    expect(withAgentToolInstructions(instructions, [{ name: 'library.read' }])).toBe(instructions);
  });
});
