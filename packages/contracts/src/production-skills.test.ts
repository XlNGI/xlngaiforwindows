import { describe, expect, it } from 'vitest';
import { PRODUCTION_SKILLS, productionSkillPrompt } from './production-skills.js';

describe('production skill contracts', () => {
  it('uses the existing plan document contract for chapters without requesting shot deliverables', () => {
    const instructions = PRODUCTION_SKILLS['chapters-to-script'].instructions;
    expect(instructions).toContain('documentKind="plan"');
    expect(instructions).toContain('workspace:documents');
    expect(instructions).not.toContain('novel.episode.submit_draft');
    const prompt = productionSkillPrompt('chapters-to-script', []);
    expect(prompt).toContain('chapters-to-script');
    expect(prompt).toContain('production.skill.read');
    expect(prompt).not.toContain('再为每个镜头');
  });
  it('declares complete material prompts and explicit per-shot references', () => {
    const instructions = PRODUCTION_SKILLS['script-to-media'].instructions;
    expect(instructions).toContain('每项完整普通文本都放prompt');
    expect(instructions).toContain('characterDocumentIds');
    expect(instructions).toContain('sceneDocumentIds');
    expect(instructions).toContain('propDocumentIds');
    expect(instructions).toContain('prompts:[{localKey,kind,title,prompt');
    expect(instructions).toContain('location是地点图片资料，scene是剧情场次');
    expect(instructions).toContain('[]');
    expect(instructions).toContain('唯一IR是bindings=');
    expect(instructions).toContain('timing仅用于scene/shot');
    expect(instructions).toContain('所有对象可联合创作和绑定');
    expect(instructions).toContain('Worker自动执行结构校验');
    expect(instructions).not.toContain('requirementAssessments');
    expect(instructions).toContain('bundle_readback_verified');
    expect(instructions).not.toContain('阶段一只生成');
  });
});
