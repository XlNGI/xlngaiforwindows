import { describe, expect, it } from 'vitest';
import {
  normalizeChapterHeadings,
  normalizeNovelText,
  parseNovelSource,
  splitNovelSource,
} from './novel-import';

describe('splitNovelSource', () => {
  it('imports a file without headings as one chapter', () => {
    expect(
      splitNovelSource({ title: '雾港纪事', contentMarkdown: '\uFEFF故事从雨夜开始。\n' }),
    ).toEqual([{ title: '雾港纪事', displayLabel: '', contentMarkdown: '故事从雨夜开始。' }]);
  });

  it('uses a single H1 as the chapter title and removes the heading', () => {
    expect(
      splitNovelSource({ title: '文件名', contentMarkdown: '# 第一章\n\n故事开始。' }),
    ).toEqual([{ title: '第一章', displayLabel: '', contentMarkdown: '故事开始。' }]);
  });

  it('splits H1 and H2 headings into ordered chapters', () => {
    expect(
      splitNovelSource({
        title: '文件名',
        contentMarkdown: '# 第一章\n\n开端。\n## 第二章\n\n转折。\n# 第三章\n\n结尾。',
      }),
    ).toEqual([
      { title: '第一章', displayLabel: '', contentMarkdown: '开端。' },
      { title: '第二章', displayLabel: '', contentMarkdown: '转折。' },
      { title: '第三章', displayLabel: '', contentMarkdown: '结尾。' },
    ]);
  });

  it('filters headings that have no body', () => {
    expect(
      splitNovelSource({
        title: '文件名',
        contentMarkdown: '# 空章\n\n# 有内容\n\n正文。\n## 也为空\n',
      }),
    ).toEqual([{ title: '有内容', displayLabel: '', contentMarkdown: '正文。' }]);
  });
});

describe('normalizeChapterHeadings', () => {
  it('promotes only 第*章 markers and leaves other numbering untouched', () => {
    expect(
      normalizeChapterHeadings('第一章 雨夜\n\n（一）开端。\n\n第二章 灯塔\n\n一、转折。'),
    ).toBe('# 第一章 雨夜\n\n（一）开端。\n\n# 第二章 灯塔\n\n一、转折。');
  });

  it('merges a name line directly above 第*章 into the title', () => {
    expect(
      normalizeChapterHeadings(
        '我叫白三妮\n　　第一章\n　　正文一。\n\n二伯娘反对\n　　第二章\n　　正文二。',
      ),
    ).toBe('# 第一章 我叫白三妮\n　　正文一。\n\n# 第二章 二伯娘反对\n　　正文二。');
  });

  it('does not merge an indented body line that precedes 第*章', () => {
    expect(normalizeChapterHeadings('　　正文以缩进开头。\n第一章\n　　下一章正文。')).toBe(
      '　　正文以缩进开头。\n# 第一章\n　　下一章正文。',
    );
  });
});

describe('normalizeNovelText', () => {
  it('promotes plain-text chapter markers to Markdown headings', () => {
    expect(normalizeNovelText('第一章 雨夜\n\n故事开始。\n第二章 灯塔\n\n转折。')).toBe(
      '# 第一章 雨夜\n\n故事开始。\n# 第二章 灯塔\n\n转折。',
    );
  });

  it('leaves existing Markdown headings and body lines untouched', () => {
    expect(normalizeNovelText('# 第一章\n\n正文里提到“第二章”但不是行首标题。')).toBe(
      '# 第一章\n\n正文里提到“第二章”但不是行首标题。',
    );
  });

  it('recognizes 序章, 楔子 and Chapter markers', () => {
    expect(normalizeNovelText('序章\n\n开始。\nChapter 2 The Storm\n\n风雨。')).toBe(
      '# 序章\n\n开始。\n# Chapter 2 The Storm\n\n风雨。',
    );
  });

  it('recognizes spaced numbers, parenthesized numbers and enumerated markers', () => {
    expect(normalizeNovelText('第 一 章\n\n开端。\n（二）雨夜\n\n继续。\n一、转折\n\n推进。')).toBe(
      '# 第 一 章\n\n开端。\n# （二）雨夜\n\n继续。\n# 一、转折\n\n推进。',
    );
  });

  it('recognizes English chapter markers and volume words', () => {
    expect(
      normalizeNovelText('Chapter One\n\n开端。\nChapter: Prologue\n\n引子。\n第二部\n\n新篇。'),
    ).toBe('# Chapter One\n\n开端。\n# Chapter: Prologue\n\n引子。\n# 第二部\n\n新篇。');
  });

  it('does not promote body sentences that only mention markers', () => {
    expect(
      normalizeNovelText('他数着一、二、三，慢慢向前走。\n第一章的内容其实在正文里继续展开。'),
    ).toBe('他数着一、二、三，慢慢向前走。\n第一章的内容其实在正文里继续展开。');
  });
});

describe('parseNovelSource', () => {
  it('splits plain-text TXT markers into chapters', () => {
    expect(
      parseNovelSource({
        title: '雾港纪事',
        contentMarkdown: '第一章\n\n开端。\n\n第二章\n\n转折。',
      }),
    ).toEqual([
      { title: '第一章', displayLabel: '', contentMarkdown: '开端。' },
      { title: '第二章', displayLabel: '', contentMarkdown: '转折。' },
    ]);
  });

  it('keeps Markdown headings when they already exist', () => {
    expect(
      parseNovelSource({
        title: '文件名',
        contentMarkdown: '# 第一章\n\n开端。\n## 第二章\n\n转折。',
      }),
    ).toEqual([
      { title: '第一章', displayLabel: '', contentMarkdown: '开端。' },
      { title: '第二章', displayLabel: '', contentMarkdown: '转折。' },
    ]);
  });

  it('splits parenthesized numbered plain-text markers into chapters', () => {
    expect(
      parseNovelSource({
        title: '雾港纪事',
        contentMarkdown: '（一）\n\n开端。\n\n（二）雨夜\n\n转折。',
      }),
    ).toEqual([
      { title: '（一）', displayLabel: '', contentMarkdown: '开端。' },
      { title: '（二）雨夜', displayLabel: '', contentMarkdown: '转折。' },
    ]);
  });

  it('uses 第*章 as the primary rule and keeps body numbering inside chapters', () => {
    expect(
      parseNovelSource({
        title: '雾港纪事',
        contentMarkdown: '第一章\n\n（一）开端。\n\n一、继续。\n\n第二章\n\n（二）转折。',
      }),
    ).toEqual([
      { title: '第一章', displayLabel: '', contentMarkdown: '（一）开端。\n\n一、继续。' },
      { title: '第二章', displayLabel: '', contentMarkdown: '（二）转折。' },
    ]);
  });

  it('splits two-line 第*章 titles without leaking the next chapter name', () => {
    expect(
      parseNovelSource({
        title: '我是墙头草的闺女[七零]',
        contentMarkdown:
          '我叫白三妮\n　　第一章\n　　正文一。\n\n二伯娘反对\n　　第二章\n　　正文二。',
      }),
    ).toEqual([
      { title: '第一章 我叫白三妮', displayLabel: '', contentMarkdown: '正文一。' },
      { title: '第二章 二伯娘反对', displayLabel: '', contentMarkdown: '正文二。' },
    ]);
  });
});
