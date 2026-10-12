import { describe, expect, it } from 'vitest';
import {
  hasMultipleNovelChapterTargets,
  splitNovelChapterCreationRequest,
} from './novel-chapter-requests.js';

describe('splitNovelChapterCreationRequest', () => {
  it.each(['生成小说的第四章和第五章', '生成 小说 的 第四章和第五章'])(
    'splits %s instead of reusing a single chapter authorization',
    (prompt) => {
      const requests = splitNovelChapterCreationRequest(prompt);
      expect(requests.map((request) => request.intent.displayLabel)).toEqual(['第四章', '第五章']);
      expect(requests[0]?.prompt).not.toContain('第五章');
      expect(requests[1]?.prompt).not.toContain('第四章');
      expect(hasMultipleNovelChapterTargets(prompt)).toBe(true);
    },
  );

  it('splits consecutive targets while preserving writing requirements and references', () => {
    const requests = splitNovelChapterCreationRequest(
      '生成第四章和第五章，每章3000字，根据第三章衔接。',
    );
    expect(requests.map((request) => request.intent.displayLabel)).toEqual(['第四章', '第五章']);
    expect(requests[0]?.prompt).toContain('每章3000字，根据第三章衔接');
    expect(requests[0]?.prompt).not.toContain('第五章');
    expect(requests[1]?.prompt).not.toContain('第四章');
    expect(requests[1]?.prompt).toContain('仅创作并提交第五章');
  });

  it('supports a list of spaced numeric chapter labels', () => {
    expect(
      splitNovelChapterCreationRequest('请创作小说第 4 章、第5章、第6章').map(
        (request) => request.intent.displayLabel,
      ),
    ).toEqual(['第4章', '第5章', '第6章']);
  });

  it.each([
    '根据第四章和第五章生成角色提示词',
    '生成第四章',
    '不要生成第四章和第五章',
    '重写第四章和第五章',
    '不要生成小说的第四章和第五章',
    '重写小说的第四章和第五章',
    '生成第四章和第四章',
  ])('does not split %s', (prompt) => expect(splitNovelChapterCreationRequest(prompt)).toEqual([]));
});

it('requires clarification for a rewrite list instead of creating chapters', () => {
  expect(hasMultipleNovelChapterTargets('重写小说的第四章和第五章')).toBe(true);
});
