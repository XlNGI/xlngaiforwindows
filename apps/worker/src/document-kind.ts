import type { DocumentKind } from '@ai-video/contracts';

/**
 * Infer the project-document page for an Agent draft when the model omits
 * documentKind. Workspace kinds appear under 大纲/计划/角色/场景 filters;
 * unmatched drafts stay `note` so novel chapters and private notes do not
 * flood the project-document list.
 */
export function inferDocumentKindFromDraft(title: string, contentMarkdown = ''): DocumentKind {
  const text = `${title}\n${contentMarkdown.slice(0, 800)}`.normalize('NFC');
  if (/(人物提示词|角色提示词|角色设定|人物设定|character bible|character prompt)/iu.test(text)) {
    return 'character';
  }
  if (/(场景提示词|场景设定|scene bible|scene prompt)/iu.test(text)) {
    return 'scene';
  }
  if (/(?:第\s*\d+\s*集|本集|整体把控|制作计划|项目计划|episode overview)/iu.test(text)) {
    return 'plan';
  }
  if (/(大纲|提纲|outline)/iu.test(text)) {
    return 'outline';
  }
  if (/(分镜|storyboard)/iu.test(text)) {
    return 'storyboard';
  }
  return 'note';
}

const CHARACTER_SECTION_HEADING = /^#{1,3}\s*(?:群体)?角色\s*[:：]\s*(.+?)\s*$/gmu;

export function listCharacterPromptSubjects(contentMarkdown: string): string[] {
  const names: string[] = [];
  for (const match of contentMarkdown.normalize('NFC').matchAll(CHARACTER_SECTION_HEADING)) {
    const name = match[1]!.replace(/[`*_]/g, '').trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export function assertSingleCharacterPromptDocument(
  kind: DocumentKind,
  _title: string,
  contentMarkdown: string,
): void {
  if (kind !== 'character') return;
  const names = listCharacterPromptSubjects(contentMarkdown);
  if (names.length <= 1) return;
  throw new Error(
    `CHARACTER_PROMPT_NOT_SINGLE: 角色提示词必须一人一份，请分别调用 document.create_draft。本文同时包含：${names.join('、')}。`,
  );
}
