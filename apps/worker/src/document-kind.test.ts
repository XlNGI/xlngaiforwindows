import { describe, expect, it } from 'vitest';
import {
  assertSingleCharacterPromptDocument,
  inferDocumentKindFromDraft,
  listCharacterPromptSubjects,
} from './document-kind.js';

describe('inferDocumentKindFromDraft', () => {
  it('maps character and scene prompt titles onto workspace kinds', () => {
    expect(inferDocumentKindFromDraft('前三章人物提示词')).toBe('character');
    expect(inferDocumentKindFromDraft('白家三房场景设定')).toBe('scene');
  });

  it('maps episode overviews to plan before generic outlines', () => {
    expect(inferDocumentKindFromDraft('第1集整体大纲 | 白小弟')).toBe('plan');
    expect(inferDocumentKindFromDraft('本集整体把控')).toBe('plan');
    expect(inferDocumentKindFromDraft('AI短剧整体大纲（基于现有小说）')).toBe('outline');
  });

  it('keeps unmatched drafts as notes so they stay out of the project-document list', () => {
    expect(inferDocumentKindFromDraft('Production brief')).toBe('note');
    expect(inferDocumentKindFromDraft('第一百二十五章《白小弟学医》')).toBe('note');
  });
});

describe('character prompt subjects', () => {
  it('extracts named character sections from a combined chapter prompt', () => {
    expect(
      listCharacterPromptSubjects(
        '## 角色：许大山\n肩宽背厚。\n\n## 角色：沈清禾\n温婉清雅。\n\n## 群体角色：青萝村村民\n邻里互助。\n',
      ),
    ).toEqual(['许大山', '沈清禾', '青萝村村民']);
  });

  it('allows a single character document and rejects a combined character bible', () => {
    expect(() =>
      assertSingleCharacterPromptDocument(
        'character',
        '许大山',
        '## 角色：许大山\n肩宽背厚，勤劳朴实。\n',
      ),
    ).not.toThrow();
    expect(() =>
      assertSingleCharacterPromptDocument(
        'character',
        '第一章 角色提示词',
        '## 角色：许大山\n肩宽背厚。\n\n## 角色：沈清禾\n温婉清雅。\n',
      ),
    ).toThrow(/CHARACTER_PROMPT_NOT_SINGLE/);
    expect(() =>
      assertSingleCharacterPromptDocument(
        'scene',
        '青萝村',
        '## 角色：许大山\n\n## 角色：沈清禾\n',
      ),
    ).not.toThrow();
  });
});
