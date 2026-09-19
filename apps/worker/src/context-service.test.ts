import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContentService } from './content-service.js';
import { ContextService } from './context-service.js';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { ProjectService } from './project-service.js';

const directories: string[] = [];
const services: ProjectService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'ai-video-context-service-'));
  directories.push(directory);
  const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  services.push(projects);
  projects.create(join(directory, 'project'), 'Context Project');
  return {
    projects,
    content: new ContentService(projects),
    contexts: new ContextService(projects),
    workflow: new DocumentWorkflowService(projects),
  };
}

describe('ContextService', () => {
  it('injects a catalog without document bodies', async () => {
    const { content, contexts } = await setup();
    content.saveDocument({
      kind: 'character',
      title: '林澈',
      contentMarkdown: '林澈是灯塔守望员，这段正文不应进入普通会话。',
    });
    const conversation = content.createConversation({ scopeType: 'project' });
    const context = contexts.compile(conversation.id);
    const preview = contexts.preview(conversation.id);

    expect(context.systemInstruction).toContain('工作助理');
    expect(context.rendered).toContain('林澈');
    expect(context.rendered).toContain('draft');
    expect(context.rendered).not.toContain('这段正文不应进入普通会话');
    expect(preview.catalog?.some((item) => item.title === '林澈' && item.status === 'draft')).toBe(
      true,
    );
  });

  it('lists published and draft catalog entries without injecting memories or constraints', async () => {
    const { content, contexts, workflow } = await setup();
    const outline = content.saveDocument({
      kind: 'outline',
      title: '项目大纲',
      contentMarkdown: '全局大纲正文',
    });
    workflow.submitReview({
      documentId: outline.id,
      expectedDocumentRowVersion: outline.rowVersion,
    });
    const reviewed = workflow.getDocument(outline.id);
    workflow.publish({
      documentId: outline.id,
      expectedDocumentRowVersion: reviewed.rowVersion,
      expectedPublishedVersionId: reviewed.publishedVersionId,
    });
    content.messageToMemory(
      content.saveMessage({
        conversationId: content.createConversation({ scopeType: 'project' }).id,
        role: 'user',
        content: '记住林澈怕海雾',
      }).id,
    );
    const conversation = content.createConversation({ scopeType: 'project' });
    const context = contexts.compile(conversation.id);
    expect(context.rendered).toContain('项目大纲');
    expect(context.rendered).not.toContain('全局大纲正文');
    expect(context.rendered).not.toContain('林澈怕海雾');
  });

  it('compacts untitled conversations in the rendered catalog', async () => {
    const { content, contexts } = await setup();
    content.saveDocument({
      kind: 'character',
      title: '林澈',
      contentMarkdown: '守灯人',
    });
    content.createConversation({ scopeType: 'project', title: '角色讨论' });
    content.createConversation({ scopeType: 'project' });
    content.createConversation({ scopeType: 'project' });
    const conversation = content.createConversation({ scopeType: 'project' });
    const context = contexts.compile(conversation.id);
    expect(context.rendered).toContain('林澈');
    expect(context.rendered).toContain('角色讨论');
    expect(context.rendered).toMatch(/会话记录 3 条 · conversation/);
    expect(context.rendered).not.toContain('新会话 · conversation');
  });
});
