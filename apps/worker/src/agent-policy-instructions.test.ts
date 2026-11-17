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
describe('Agent prompt template policy', () => {
  it('declares template precedence before any authoring tools are loaded', () => {
    const instructions = withAgentToolInstructions('', [{ name: 'tools.load' }]);
    expect(instructions).toContain('本轮明确修正优先');
    expect(instructions).toContain('先用 prompt.generation.request 声明真实源版本与全部 purposes');
    expect(instructions).toContain('通过 tools.load 的 workflow 声明对应图片类型');
    expect(instructions).not.toContain(VIDEO_PROMPT_AUTHORING_REQUIREMENTS);
  });
  it('requires current-session requirements in the final authored prompt', () => {
    const instructions = withAgentToolInstructions('', [
      { name: 'document.create_draft' },
      { name: 'scene.update_shot_prompts' },
      { name: 'library.search' },
      { name: 'media.image.prepare' },
    ]);
    expect(instructions).toContain('# Agent final prompt coverage policy');
    expect(instructions).toContain('本轮用户请求和按产物类型选择的专项模板');
    expect(instructions).toContain('新任务没有通用创作模板');
    expect(instructions).toContain('剧情约束文档使用 documentKind=constraint');
    expect(instructions).toContain('将已读取且适用的剧情、人物行为和连续性条款落实到作品内容');
    expect(instructions).toContain('只写在 bindings、备注或普通回复');
    expect(instructions).toContain('界面只负责展示、参数审核和用户确认');
    expect(withAgentToolInstructions(instructions, [{ name: 'document.update_draft' }])).toBe(
      instructions,
    );
  });
  it.each(['character-image', 'scene-image', 'prop-image', 'shot-image', 'video-prompt'])(
    'keeps editable defaults out of system and tool policy for %s',
    (workflow) => {
      const names = [
        'document.submit_draft',
        'media.image.prepare',
        'media.video.prepare',
        'scene.submit_structure',
      ];
      for (const policy of [
        withAgentToolInstructions(
          '',
          names.map((name) => ({ name })),
          workflow,
        ),
        loadedToolGuidance(names, workflow),
      ]) {
        expect(policy).not.toContain(CHARACTER_SHEET_IMAGE_REQUIREMENTS);
        expect(policy).not.toContain(SCENE_REFERENCE_IMAGE_REQUIREMENTS);
        expect(policy).not.toContain(VIDEO_PROMPT_AUTHORING_REQUIREMENTS);
        expect(policy).toContain('用户清空或修改模板后，不补回默认创作要求');
        expect(policy).toContain('只要求提示词不代表授权生成图片、视频或首帧');
      }
    },
  );
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
