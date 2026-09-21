import { describe, expect, it } from 'vitest';
import {
  analyzeLibraryQuery,
  parseChapterNumberFromTitle,
  scoreLibraryChunk,
} from './project-library-query.js';

describe('project library query analysis', () => {
  it('extracts a character name from a role-setting request', () => {
    const analysis = analyzeLibraryQuery('林澈的角色设定');
    expect(analysis.remainder).toBe('林澈');
    expect(analysis.identityTerms).toContain('林澈');
    expect(analysis.kindHints).toContain('character');
  });

  it('extracts chapter identity from a generation request', () => {
    const analysis = analyzeLibraryQuery('根据第一章生成剧本');
    expect(analysis.chapterNumbers).toEqual([1]);
    expect(analysis.identityTerms).toEqual(expect.arrayContaining(['第一章', '第1章']));
    expect(analysis.sourceTypeHints).toContain('novel-chapter');
  });

  it('extracts quoted titles and chapter ranges', () => {
    const quoted = analyzeLibraryQuery('根据《雾港》写大纲');
    expect(quoted.quotedTitles).toEqual(['雾港']);
    const ranged = analyzeLibraryQuery('用第3-5章做一集');
    expect(ranged.chapterNumbers).toEqual([3, 4, 5]);
  });

  it('parses chapter numbers from titles', () => {
    expect(parseChapterNumberFromTitle('第一章 雾港')).toBe(1);
    expect(parseChapterNumberFromTitle('第11章')).toBe(11);
    expect(parseChapterNumberFromTitle('第十一章')).toBe(11);
  });

  it('ranks a named title above a body that repeats the whole request', () => {
    const character = scoreLibraryChunk(
      {
        title: '林澈',
        content: '林澈是灯塔守望员。',
        sourceType: 'document',
        status: 'draft',
        kind: 'character',
      },
      '林澈的角色设定',
    );
    const outline = scoreLibraryChunk(
      {
        title: '项目大纲',
        content: '根据林澈的角色设定生成剧本。'.repeat(20),
        sourceType: 'document',
        status: 'draft',
        kind: 'outline',
      },
      '林澈的角色设定',
    );
    expect(character.matchKind).toBe('title');
    expect(character.score).toBeGreaterThan(outline.score);
  });
});
