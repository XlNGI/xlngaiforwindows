export interface NovelImportSource {
  title: string;
  contentMarkdown: string;
}

export interface NovelImportChapterDraft {
  title: string;
  displayLabel: string;
  contentMarkdown: string;
}

const headingPattern = /^\s{0,3}#{1,2}\s+(.+?)\s*$/;

/**
 * Recognizes the chapter/volume markers that downloaded plain-text novels usually use, for example
 * `第一章`, `第12章 风起`, `第 一 章`, `Chapter 3 The Storm`, `Chapter One`, `序章`,
 * `楔子`, `番外：婚礼`, `上篇`, `第二部`, `（一）`, `一、`, `1.` or `- 1 -`.
 */
const chapterMarkerPattern =
  /^\s{0,3}(?:(?:第\s*[0-9０-９零一二三四五六七八九十百千万两〇]+\s*[章回节卷篇部集](?:[：:、．.\s].*)?)|(?:上篇|中篇|下篇|前篇|后篇)(?:[：:、\s].*)?|(?:Chapter\s*[:：]?\s*(?:[0-9０-９]+|[A-Za-z]+)(?:[：:、\s].*)?)|(?:序章|楔子|尾声|后记|引子|前言|序言|番外)(?:[：:、\s].*)?|(?:[（(]\s*[0-9０-９零一二三四五六七八九十百千万两〇]+\s*[）)].*)|(?:[0-9０-９零一二三四五六七八九十百千万两〇]+[、.．].*)|(?:[-—]\s*[0-9０-９零一二三四五六七八九十百千万两〇]+\s*[-—]))\s*$/;

/**
 * Recognizes the primary `第*章` chapter markers, for example `第一章`, `第12章 风起` or
 * `第 一 章`. This is the preferred marker used to split downloaded novels.
 */
const chapterHeadingPattern =
  /^\s{0,3}第\s*[0-9０-９零一二三四五六七八九十百千万两〇]+\s*章(?:[：:、．.\s].*)?\s*$/;

function isIndentedLine(line: string): boolean {
  return line.startsWith('\u3000') || line.startsWith('\t') || line.startsWith(' ');
}

/**
 * Promotes only `第*章` markers to Markdown `#` headings. Used as the primary chapter split
 * rule so body-text numbering such as `（一）` or `一、` is never mistaken for a chapter.
 *
 * Some downloaded novels use a two-line title where the chapter name sits directly above the
 * `第*章` marker (for example a name line such as `我叫白三妮` followed by an indented
 * `第一章` line). When the line directly above a `第*章` marker is a short, unindented,
 * non-marker line, it is merged into the title so it is not mistaken for the previous chapter's
 * body text.
 */
export function normalizeChapterHeadings(content: string): string {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !chapterHeadingPattern.test(trimmed)) {
      output.push(line);
      continue;
    }
    const previous = index > 0 ? (lines[index - 1] ?? '') : '';
    const previousTrimmed = previous.trim();
    const previousIsNameLine =
      Boolean(previousTrimmed) &&
      !previousTrimmed.startsWith('#') &&
      !isIndentedLine(previous) &&
      !chapterHeadingPattern.test(previousTrimmed) &&
      previousTrimmed.length <= 40;
    if (previousIsNameLine) {
      output.pop();
      output.push('# ' + trimmed + ' ' + previousTrimmed);
    } else {
      output.push('# ' + trimmed);
    }
  }
  return output.join('\n');
}

/**
 * Converts plain-text chapter markers into Markdown `#` headings so `splitNovelSource` can split
 * a downloaded `.txt` novel into chapter drafts. Lines that already look like Markdown headings
 * are left untouched.
 */
export function normalizeNovelText(content: string): string {
  return content
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;
      return chapterMarkerPattern.test(trimmed) ? `# ${trimmed}` : line;
    })
    .join('\n');
}

/**
 * Splits a novel source into chapter drafts. Markdown headings are preferred; when the source has
 * fewer than two headings, plain-text chapter markers (common in `.txt` novels) are promoted to
 * headings and the split is retried.
 */
export function parseNovelSource(source: NovelImportSource): NovelImportChapterDraft[] {
  const markdownChapters = splitNovelSource(source);
  if (markdownChapters.length >= 2) return markdownChapters;

  // 以“第*章”为准：只要文件里出现“第*章”标记，就只按它切分，避免把正文中的
  // “（一）”“一、”等编号误当成章节。
  const headingText = normalizeChapterHeadings(source.contentMarkdown);
  if (headingText !== source.contentMarkdown.replace(/^\uFEFF/, '')) {
    const chapterChapters = splitNovelSource({
      title: source.title,
      contentMarkdown: headingText,
    });
    if (chapterChapters.length > 0) return chapterChapters;
  }

  // 兜底：没有“第*章”时才使用宽泛章节标记（（一）、一、、Chapter One、上篇等）。
  const normalized = normalizeNovelText(source.contentMarkdown);
  if (normalized === source.contentMarkdown.replace(/^\uFEFF/, '')) return markdownChapters;
  const textChapters = splitNovelSource({ title: source.title, contentMarkdown: normalized });
  return textChapters.length > 0 ? textChapters : markdownChapters;
}

export function splitNovelSource(source: NovelImportSource): NovelImportChapterDraft[] {
  const lines = source.contentMarkdown.replace(/^\uFEFF/, '').split(/\r?\n/);
  const headings: Array<{ index: number; title: string }> = [];
  lines.forEach((line, index) => {
    const match = headingPattern.exec(line);
    if (match?.[1]?.trim()) headings.push({ index, title: match[1].trim() });
  });
  if (headings.length < 2) {
    const first = headings[0];
    const body = (first ? lines.slice(first.index + 1) : lines).join('\n').trim();
    return body
      ? [{ title: first?.title ?? source.title, displayLabel: '', contentMarkdown: body }]
      : [];
  }
  return headings.flatMap((heading, index) => {
    const next = headings[index + 1]?.index ?? lines.length;
    const body = lines
      .slice(heading.index + 1, next)
      .join('\n')
      .trim();
    return body ? [{ title: heading.title, displayLabel: '', contentMarkdown: body }] : [];
  });
}
