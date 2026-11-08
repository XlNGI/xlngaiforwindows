import { describe, expect, it } from 'vitest';
import { inferNovelWritingIntent } from './App';

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
