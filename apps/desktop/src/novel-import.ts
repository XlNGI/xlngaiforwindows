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
