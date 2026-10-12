import { describe, expect, it } from 'vitest';
import { inferDocumentIntent, inferNovelWritingIntent, inferShortDramaIntent } from './App';

describe('inferNovelWritingIntent', () => {
  it.each([
    '帮我生成一个小说',
    '请创作一部悬疑小说',
    '我要写一部小说',
    '请生成小说大纲',
    '生成小说人物设定',
    '重写项目简介',
  ])('lets the assistant interpret %s without freezing a chapter target', (prompt) => {
    expect(inferNovelWritingIntent(prompt)).toBeUndefined();
    expect(inferNovelWritingIntent(prompt, 'selected-chapter')).toBeUndefined();
  });

  it('keeps explicit chapter shortcuts subject to target validation', () => {
    expect(inferNovelWritingIntent('帮我生成第二章小说正文')).toEqual({
      action: 'create_chapter',
      displayLabel: '第二章',
      chapterTitle: '第二章',
    });
    expect(inferNovelWritingIntent('生成小说章节')).toEqual({ action: 'create_chapter' });
    expect(inferNovelWritingIntent('续写本章', 'selected-chapter')).toEqual({
      action: 'continue_chapter',
      chapterId: 'selected-chapter',
    });
    expect(inferNovelWritingIntent('修改正文', 'selected-chapter')).toEqual({
      action: 'rewrite_chapter',
      chapterId: 'selected-chapter',
    });
  });

  it.each([
    ['现在生成第二章', '第二章'],
    ['帮我生成第 2 章小说正文', '第2章'],
    ['请创作第十二章', '第十二章'],
  ])(
    'creates the requested numbered chapter while another chapter is selected: %s',
    (prompt, label) => {
      const intent = inferNovelWritingIntent(prompt, 'selected-first-chapter');
      expect(intent).toEqual({
        action: 'create_chapter',
        displayLabel: label,
        chapterTitle: label,
      });
      expect(intent).not.toHaveProperty('chapterId');
    },
  );
});

describe('inferDocumentIntent', () => {
  it('recognizes explicit document creation without changing ordinary chat', () => {
    expect(inferDocumentIntent('Create a project brief')).toEqual({
      intent: { operation: 'document.create_draft' },
      needsTarget: false,
    });
    expect(inferDocumentIntent('Explain how a project brief works')).toEqual({
      needsTarget: false,
    });
  });

  it('picks the primary tool for short-drama episode prompts', () => {
    expect(inferShortDramaIntent('生成本集整体把控')).toBe('novel.episode.submit_draft');
    expect(inferShortDramaIntent('生成这一集的场次和镜头提示词')).toBe(
      'novel.episode.submit_structure',
    );
    expect(inferShortDramaIntent('把前三章的人物和场景做成提示词')).toBe('document.create_draft');
    expect(inferShortDramaIntent('写一下本集分镜')).toBe('novel.episode.submit_structure');
  });

  it('requires the currently selected document for targeted operations', () => {
    expect(inferDocumentIntent('Update this document')).toEqual({ needsTarget: true });
    expect(inferDocumentIntent('Update this document', 'document-1')).toEqual({
      intent: { operation: 'document.update_draft', documentId: 'document-1' },
      needsTarget: false,
    });
    expect(inferDocumentIntent('Archive this document', 'document-1')).toEqual({
      intent: { operation: 'document.archive', documentId: 'document-1' },
      needsTarget: false,
    });
    expect(inferDocumentIntent('Unarchive this document', 'document-1')).toEqual({
      intent: { operation: 'document.restore', documentId: 'document-1' },
      needsTarget: false,
    });
  });

  it('keeps negated requests side-effect free', () => {
    expect(inferDocumentIntent("Don't create a document")).toEqual({ needsTarget: false });
  });
});
