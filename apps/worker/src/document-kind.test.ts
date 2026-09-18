import { describe, expect, it } from 'vitest';
import { inferDocumentKindFromDraft } from './document-kind.js';

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
