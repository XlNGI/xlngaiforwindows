import { createHash } from 'node:crypto';

/** The small, deterministic vocabulary exposed to retrieval callers. */
export const PROJECT_STRUCTURE_KINDS = [
  'document',
  'volume',
  'chapter',
  'scene',
  'shot',
  'section',
] as const;

export type ProjectStructureKind = (typeof PROJECT_STRUCTURE_KINDS)[number];

export interface ProjectStructureNodeDraft {
  kind: ProjectStructureKind;
  title: string;
  path: string[];
  level: number;
  ordinal: number;
  startOffset: number;
  endOffset: number;
  contentText: string;
  contentHash: string;
}

/**
 * Parse the stable, human-authored structure of a Markdown source.
 *
 * This deliberately stays syntactic. It never asks an LLM to infer a scene
 * or silently invent a relationship. A heading owns the text until the next
 * heading at the same or a shallower level; the path is therefore stable
 * across indexing and can be shown beside a library hit.
 */
export function parseProjectStructure(
  content: string,
  documentTitle: string,
): ProjectStructureNodeDraft[] {
  const title = documentTitle.trim() || '未命名文档';
  const headings = markdownHeadingsOutsideFences(content);
  const nodes: ProjectStructureNodeDraft[] = [];
  const rootEnd = content.length;
  nodes.push(makeNode('document', title, [title], 0, 0, 0, rootEnd, content));

  const stack: Array<{ level: number; title: string; path: string[] }> = [];
  for (const [index, heading] of headings.entries()) {
    while (stack.length > 0 && stack[stack.length - 1]!.level >= heading.level) stack.pop();
    const parentPath = stack.at(-1)?.path ?? [title];
    const path = [...parentPath, heading.title];
    const nextHeading = headings[index + 1];
    const endOffset = nextHeading?.startOffset ?? rootEnd;
    const text = content.slice(heading.startOffset, endOffset).trim();
    nodes.push(
      makeNode(
        classifyHeading(heading.title, heading.level),
        heading.title,
        path,
        heading.level,
        nodes.length,
        heading.startOffset,
        endOffset,
        text,
      ),
    );
    stack.push({ level: heading.level, title: heading.title, path });
  }
  return nodes;
}

interface MarkdownHeading {
  startOffset: number;
  level: number;
  title: string;
}

function markdownHeadingsOutsideFences(content: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  let offset = 0;
  let fence: '`' | '~' | undefined;
  for (const lineMatch of content.matchAll(/[^\n]*(?:\n|$)/gu)) {
    const rawLine = lineMatch[0] ?? '';
    if (!rawLine) break;
    const line = rawLine.replace(/(?:\r?\n)$/u, '');
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/u.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1]![0] as '`' | '~';
      fence = fence === marker ? undefined : (fence ?? marker);
    } else if (!fence) {
      const headingMatch = /^( {0,3})(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
      if (headingMatch) {
        headings.push({
          startOffset: offset,
          level: headingMatch[2]?.length ?? 1,
          title: cleanHeadingTitle(headingMatch[3] ?? ''),
        });
      }
    }
    offset += rawLine.length;
  }
  return headings;
}

function makeNode(
  kind: ProjectStructureKind,
  title: string,
  path: string[],
  level: number,
  ordinal: number,
  startOffset: number,
  endOffset: number,
  contentText: string,
): ProjectStructureNodeDraft {
  const normalized = contentText.trim();
  return {
    kind,
    title,
    path,
    level,
    ordinal,
    startOffset,
    endOffset: Math.max(startOffset, endOffset),
    contentText: normalized,
    contentHash: sha256(normalized),
  };
}

function cleanHeadingTitle(value: string): string {
  return value.replace(/\s+/gu, ' ').trim() || '未命名段落';
}

function classifyHeading(title: string, level: number): Exclude<ProjectStructureKind, 'document'> {
  const value = title.normalize('NFKC');
  if (
    /^(?:第\s*[零〇一二两三四五六七八九十百千万亿\d]+\s*)?卷(?:章|\s|：|:|$)|\bvolume\b/iu.test(
      value,
    )
  ) {
    return 'volume';
  }
  if (
    /^(?:第\s*[零〇一二两三四五六七八九十百千万亿\d]+\s*)?章(?:节|\s|：|:|$)|\bchapter\b/iu.test(
      value,
    )
  ) {
    return 'chapter';
  }
  if (
    /(?:场景|场次|scene)\s*(?:\d+|[一二三四五六七八九十]+)?(?:\s|$)|^场\s*[一二三四五六七八九十\d]+/iu.test(
      value,
    )
  ) {
    return 'scene';
  }
  if (
    /(?:镜头|分镜|shot|storyboard)\s*(?:\d+|[一二三四五六七八九十]+)?(?:\s|$)|^镜\s*[一二三四五六七八九十\d]+/iu.test(
      value,
    )
  ) {
    return 'shot';
  }
  return level <= 1 ? 'section' : 'section';
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
