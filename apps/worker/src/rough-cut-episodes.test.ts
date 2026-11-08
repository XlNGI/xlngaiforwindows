import { describe, expect, it } from 'vitest';
import { episodeNumber } from './rough-cut-episodes.js';

describe('explicit episode labels', () => {
  it.each([
    ['第 １２ 集 · 标题', 12],
    ['第一集', 1],
    ['第十二集', 12],
    ['第二十一集', 21],
    ['第一百零二集', 102],
    ['第两百集', 200],
    ['第二〇集', 20],
  ])('reads %s', (title, number) => {
    expect(episodeNumber(title)).toBe(number);
  });
  it.each(['第一场', 'chapter 2', '未命名粗剪', '第0集', '第100000集', '第十一万集'])(
    'does not guess %s',
    (title) => {
      expect(episodeNumber(title)).toBeUndefined();
    },
  );
});
