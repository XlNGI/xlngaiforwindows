import { describe, expect, it } from 'vitest';
import {
  CHARACTER_SHEET_IMAGE_REQUIREMENTS,
  VIDEO_PROMPT_AUTHORING_REQUIREMENTS,
} from '@ai-video/contracts';
import { withAgentToolInstructions } from './agent-policy-instructions.js';
import { loadedToolGuidance } from './agent-workflow-guidance.js';

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
    const instructions = withAgentToolInstructions('', [{ name }]);
    expect(instructions).toContain(VIDEO_PROMPT_AUTHORING_REQUIREMENTS);
    expect(instructions).toContain(
      '分段时长由 LLM 根据动作复杂度、对白长度、表演停顿、镜头运动和叙事节奏自主设计',
    );
    expect(loadedToolGuidance([name])).toContain(VIDEO_PROMPT_AUTHORING_REQUIREMENTS);
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
