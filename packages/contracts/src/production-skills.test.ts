import { describe, expect, it } from 'vitest';
import { PRODUCTION_SKILLS, productionSkillPrompt } from './production-skills.js';

describe('production skill contracts', () => {
  it('uses the existing plan document contract for chapters without requesting shot deliverables', () => {
    const instructions = PRODUCTION_SKILLS['chapters-to-script'].instructions;
    expect(instructions).toContain('documentKind="plan"');
    expect(instructions).toContain('workspace:documents');
    expect(instructions).not.toContain('novel.episode.submit_draft');
    const prompt = productionSkillPrompt('chapters-to-script', []);
    expect(prompt).toContain('documentKind="plan"');
    expect(prompt).not.toContain('再为每个镜头');
  });
  it('declares complete material prompts and explicit per-shot references', () => {
    const instructions = PRODUCTION_SKILLS['script-to-media'].instructions;
    expect(instructions).toContain('完整提示词');
    expect(instructions).toContain('characterDocumentIds');
    expect(instructions).toContain('sceneDocumentIds');
    expect(instructions).toContain('propDocumentIds');
    expect(instructions).toContain('contentMarkdown');
    expect(instructions).toContain('[]');
    expect(instructions).toContain('requiredTexts');
    expect(instructions).toContain('全部原对白');
    expect(instructions).toContain('结构 ready');
  });
});
