import type { NovelWritingIntent } from './index.js';

const chapterLabel = '第\\s*[0-9零〇一二三四五六七八九十百千万两]+\\s*章';
const novelQualifier = '(?:\\s*小说(?:\\s*的)?)?\\s*';

export interface NovelChapterRequest {
  prompt: string;
  intent: NovelWritingIntent;
}

/** Only split an explicit list attached to a chapter creation verb. */
export function splitNovelChapterCreationRequest(prompt: string): NovelChapterRequest[] {
  if (/(不要|不需要|取消|别|续写|继续写|重写|重新|改写|修改|更新|保存|写入)/u.test(prompt))
    return [];
  const list = prompt.match(
    new RegExp(
      `(?:生成|创作|撰写|写作|新建|创建)${novelQualifier}(${chapterLabel}(?:\\s*(?:和|与|及|、|，|,)\\s*${chapterLabel})+)`,
      'u',
    ),
  );
  if (!list || list.index === undefined) return [];
  const expression = list[1]!;
  const labels = [...expression.matchAll(new RegExp(chapterLabel, 'gu'))].map((match) =>
    match[0].replace(/\s+/gu, ''),
  );
  // Keep repeated targets out of a batch: they would contend with review locks.
  if (labels.length > 50 || new Set(labels).size !== labels.length) return [];
  const start = list.index + list[0].indexOf(expression);
  return labels.map((displayLabel, index) => ({
    prompt: `${prompt.slice(0, start)}${displayLabel}${prompt.slice(start + expression.length)}\n\n本次为分章任务 ${index + 1}/${labels.length}，仅创作并提交${displayLabel}。前序章节草稿请按需检索读取，后续章节由独立任务生成。`,
    intent: { action: 'create_chapter', displayLabel, chapterTitle: displayLabel },
  }));
}

export function hasMultipleNovelChapterTargets(prompt: string): boolean {
  return new RegExp(
    `(?:生成|创作|撰写|写作|新建|创建|续写|重写|改写|修改)${novelQualifier}${chapterLabel}\\s*(?:和|与|及|、|，|,|到|至|[-—~～])\\s*${chapterLabel}`,
    'u',
  ).test(prompt);
}
