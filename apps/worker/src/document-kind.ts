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
