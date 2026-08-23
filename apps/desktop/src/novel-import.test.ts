import { describe, expect, it } from 'vitest';
import { splitNovelSource } from './novel-import';

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
