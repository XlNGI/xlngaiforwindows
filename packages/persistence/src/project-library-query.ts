export type LibraryQueryMatchKind = 'title' | 'body';

export interface LibraryQueryAnalysis {
  raw: string;
  normalized: string;
  remainder: string;
  quotedTitles: string[];
  chapterNumbers: number[];
  chapterLabels: string[];
  kindHints: string[];
  sourceTypeHints: string[];
  identityTerms: string[];
}

export const LIBRARY_SOURCE_TYPE_LABELS: Record<string, string> = {
  document: '项目文档',
  'novel-chapter': '小说章节',
  'novel-reference': '小说参考',
  memory: '项目记忆',
  constraint: '生产约束',
  conversation: '会话记录',
  scene: '场次',
  shot: '镜头',
  storyboard: '分镜',
  asset: '素材',
  'change-set': '变更集',
  adaptation: '改编提案',
  'media-task': '媒体任务',
};

export const LIBRARY_KIND_LABELS: Record<string, string> = {
  character: '角色设定',
  scene: '场景设定',
  outline: '大纲',
  plan: '计划',
  storyboard: '分镜',
  note: '笔记',
  image: '图片',
  video: '视频',
  production: '生产',
};

const KIND_HINT_PATTERNS: Array<{ pattern: RegExp; kind: string; sourceType?: string }> = [
  { pattern: /角色设定|人物设定|角色卡|人物卡/, kind: 'character' },
  { pattern: /场景设定|场景卡/, kind: 'scene' },
  { pattern: /大纲/, kind: 'outline' },
  { pattern: /计划/, kind: 'plan' },
  { pattern: /分镜/, kind: 'storyboard', sourceType: 'storyboard' },
  { pattern: /笔记/, kind: 'note' },
];

const SOURCE_TYPE_HINT_PATTERNS: Array<{ pattern: RegExp; sourceType: string }> = [
  { pattern: /章节|小说/, sourceType: 'novel-chapter' },
  { pattern: /记忆/, sourceType: 'memory' },
  { pattern: /约束/, sourceType: 'constraint' },
  { pattern: /素材/, sourceType: 'asset' },
  { pattern: /场次/, sourceType: 'scene' },
  { pattern: /镜头/, sourceType: 'shot' },
];

const IDENTITY_KIND_SUFFIX = /的?(角色设定|人物设定|场景设定|角色卡|人物卡|大纲|计划|分镜|笔记)$/u;

export function analyzeLibraryQuery(query: string): LibraryQueryAnalysis {
  const raw = query.trim();
  const normalized = raw.toLocaleLowerCase('zh-CN');
  const quotedTitles = extractQuotedTitles(raw);
  const chapterNumbers = extractChapterNumbers(raw);
  const chapterLabels = [...new Set(chapterNumbers.flatMap((value) => chapterLabelsFor(value)))];
  const kindHints = [
    ...new Set(
      KIND_HINT_PATTERNS.filter((item) => item.pattern.test(raw)).map((item) => item.kind),
    ),
  ];
  const sourceTypeHints = [
    ...new Set([
      ...(chapterNumbers.length > 0 ? ['novel-chapter'] : []),
      ...KIND_HINT_PATTERNS.filter((item) => item.sourceType && item.pattern.test(raw)).map(
        (item) => item.sourceType!,
      ),
      ...SOURCE_TYPE_HINT_PATTERNS.filter((item) => item.pattern.test(raw)).map(
        (item) => item.sourceType,
      ),
    ]),
  ];
  const remainder = stripLibraryTaskLanguage(raw)
    .replace(IDENTITY_KIND_SUFFIX, '')
    .trim()
    .toLocaleLowerCase('zh-CN');
  const identityTerms = uniqueStrings([
    ...quotedTitles.map((title) => title.toLocaleLowerCase('zh-CN')),
    ...chapterLabels,
    ...(remainder.length >= 2 ? [remainder] : []),
  ]).filter((term) => term.length >= 2 && term.length <= 80);

  return {
    raw,
    normalized,
    remainder,
    quotedTitles,
    chapterNumbers,
    chapterLabels,
    kindHints,
    sourceTypeHints,
    identityTerms,
  };
}

export function libraryFtsMatchQuery(query: string): string | undefined {
  const analysis = analyzeLibraryQuery(query);
  const phrases = uniqueStrings([
    analysis.normalized,
    ...analysis.quotedTitles,
    ...analysis.chapterLabels,
    ...analysis.identityTerms,
  ]).filter((phrase) => [...phrase].length >= 3);
  if (phrases.length === 0) return undefined;
  return phrases.map((phrase) => `"${phrase.replaceAll('"', '""')}"`).join(' OR ');
}

export function escapeLibraryLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

export function libraryKindLabel(kind: string | undefined): string | undefined {
  if (!kind) return undefined;
  return LIBRARY_KIND_LABELS[kind] ?? kind;
}

export function librarySourceTypeLabel(sourceType: string): string {
  return LIBRARY_SOURCE_TYPE_LABELS[sourceType] ?? sourceType;
}

export function parseChapterNumberFromTitle(title: string): number | undefined {
  const match = title.match(/第\s*([0-9]{1,3}|[零〇一二两三四五六七八九十百]+)\s*章/u);
  if (!match?.[1]) return undefined;
  return parseCountToken(match[1]);
}

export function scoreLibraryChunk(
  input: {
    title: string;
    content: string;
    sourceType: string;
    status: string;
    kind?: string;
  },
  query: string,
): { score: number; matchKind: LibraryQueryMatchKind } {
  const analysis = analyzeLibraryQuery(query);
  const title = input.title.toLocaleLowerCase('zh-CN');
  const content = input.content.toLocaleLowerCase('zh-CN');
  const needle = analysis.normalized;
  let score = 0;
  let titleMatched = false;

  const markTitle = (amount: number) => {
    score += amount;
    titleMatched = true;
  };

  if (needle && title === needle) markTitle(240);
  if (analysis.remainder && title === analysis.remainder) markTitle(220);

  for (const quoted of analysis.quotedTitles) {
    const value = quoted.toLocaleLowerCase('zh-CN');
    if (title === value) markTitle(230);
    else if (title.includes(value)) markTitle(160);
    else if (content.includes(value)) score += 12;
  }

  const titleChapter = parseChapterNumberFromTitle(input.title);
  for (const chapterNumber of analysis.chapterNumbers) {
    if (titleChapter === chapterNumber) markTitle(200);
    else if (
      content.includes(`第${chapterNumber}章`) ||
      content.includes(chapterLabelsFor(chapterNumber)[1] ?? '')
    ) {
      score += 8;
    }
  }

  for (const term of analysis.identityTerms) {
    if (title === term) markTitle(180);
    else if (title.startsWith(term) || includesAsTitleToken(title, term)) markTitle(90);
    else if (content.includes(term)) score += Math.min(term.length, 8);
  }

  if (needle && title.includes(needle)) markTitle(80);
  if (needle && content.includes(needle)) score += Math.min(needle.length, 12);

  for (const term of libraryQueryTerms(query)) {
    if (title.includes(term)) markTitle(Math.min(term.length, 6));
    else if (content.includes(term)) score += Math.min(term.length, 3);
  }

  if (input.kind && analysis.kindHints.includes(input.kind)) score += 28;
  if (analysis.sourceTypeHints.includes(input.sourceType)) score += 36;

  if (input.sourceType === 'document' || input.sourceType === 'novel-chapter') {
    score = score * 1.5 + (input.status === 'published' ? 10 : 5);
  } else if (input.sourceType === 'conversation') {
    score = Math.floor(score * 0.3);
  }

  return { score, matchKind: titleMatched ? 'title' : 'body' };
}

export function stripLibraryTaskLanguage(query: string): string {
  return query
    .replace(/[\s，,。！？!?]+/gu, ' ')
    .replace(/^(请你?|麻烦你?|帮我|帮忙)?(根据|基于|按照|用|把|将)/u, '')
    .replace(
      /(生成|写出|改写|改编|创作|写成|做)(一个|一份|一篇|一集)?(剧本|大纲|分镜|短剧|内容|草稿).*$/u,
      '',
    )
    .trim();
}

function extractQuotedTitles(query: string): string[] {
  const titles: string[] = [];
  for (const match of query.matchAll(/《([^》]{1,80})》/gu)) {
    if (match[1]?.trim()) titles.push(match[1].trim());
  }
  for (const match of query.matchAll(/[「『“"]([^」』”"]{1,80})[」』”"]/gu)) {
    if (match[1]?.trim()) titles.push(match[1].trim());
  }
  return uniqueStrings(titles);
}

function extractChapterNumbers(query: string): number[] {
  const numbers: number[] = [];
  const pushRange = (startRaw: string | undefined, endRaw: string | undefined) => {
    const start = parseCountToken(startRaw ?? '');
    if (start === undefined) return;
    const end = endRaw ? parseCountToken(endRaw) : start;
    const last = end === undefined || end < start ? start : Math.min(end, start + 20);
    for (let value = start; value <= last; value += 1) numbers.push(value);
  };
  for (const match of query.matchAll(
    /第\s*([0-9]{1,3}|[零〇一二两三四五六七八九十百]+)\s*[-~—到至]\s*第?\s*([0-9]{1,3}|[零〇一二两三四五六七八九十百]+)\s*章/gu,
  )) {
    pushRange(match[1], match[2]);
  }
  for (const match of query.matchAll(
    /第\s*([0-9]{1,3}|[零〇一二两三四五六七八九十百]+)\s*章(?:\s*[-~—到至]\s*第?\s*([0-9]{1,3}|[零〇一二两三四五六七八九十百]+)\s*章)?/gu,
  )) {
    pushRange(match[1], match[2]);
  }
  return [...new Set(numbers)];
}

function chapterLabelsFor(value: number): string[] {
  const labels = [`第${value}章`];
  const chinese = toChineseCount(value);
  if (chinese) labels.push(`第${chinese}章`);
  return labels;
}

function parseCountToken(raw: string): number | undefined {
  const token = raw.trim();
  if (/^\d{1,3}$/.test(token)) return Number(token);
  return parseChineseCount(token);
}

function parseChineseCount(raw: string): number | undefined {
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (raw === '十') return 10;
  if (raw.length === 1 && raw in digits && raw !== '零' && raw !== '〇') return digits[raw];
  const tenSuffix = raw.match(/^十([一二三四五六七八九])$/u);
  if (tenSuffix?.[1]) return 10 + digits[tenSuffix[1]]!;
  const tensOnly = raw.match(/^([一二三四五六七八九])十$/u);
  if (tensOnly?.[1]) return digits[tensOnly[1]]! * 10;
  const both = raw.match(/^([一二三四五六七八九])十([一二三四五六七八九])$/u);
  if (both?.[1] && both[2]) return digits[both[1]]! * 10 + digits[both[2]]!;
  return undefined;
}

function toChineseCount(value: number): string | undefined {
  if (value <= 0 || value > 99) return undefined;
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  if (value < 10) return digits[value];
  if (value === 10) return '十';
  if (value < 20) return `十${digits[value - 10]}`;
  const tens = Math.floor(value / 10);
  const ones = value % 10;
  return ones === 0 ? `${digits[tens]}十` : `${digits[tens]}十${digits[ones]}`;
}

function includesAsTitleToken(title: string, term: string): boolean {
  if (!title.includes(term)) return false;
  if (/第\d+章|第[零〇一二两三四五六七八九十百]+章/u.test(term)) {
    return parseChapterNumberFromTitle(title) === parseChapterNumberFromTitle(term);
  }
  return true;
}

export function libraryQueryTerms(query: string): string[] {
  const terms = new Set<string>();
  const segments = query.toLocaleLowerCase('zh-CN').match(/[\p{L}\p{N}_-]+/gu) ?? [];
  for (const segment of segments) {
    if (/^[\u3400-\u9fff]+$/u.test(segment)) {
      if (segment.length === 1) terms.add(segment);
      for (let index = 0; index < segment.length - 1 && terms.size < 64; index += 1) {
        terms.add(segment.slice(index, index + 2));
      }
    } else if (segment.length >= 2) {
      terms.add(segment);
    }
    if (terms.size >= 64) break;
  }
  return [...terms];
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const next = value.trim();
    if (!next || seen.has(next)) continue;
    seen.add(next);
    result.push(next);
  }
  return result;
}
