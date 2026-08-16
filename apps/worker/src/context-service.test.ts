import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRepositories } from '@ai-video/persistence';
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

function publishDocument(
  workflow: DocumentWorkflowService,
  documentId: string,
  rowVersion: number,
) {
  workflow.submitReview({
    documentId,
    expectedDocumentRowVersion: rowVersion,
  });
  const reviewed = workflow.getDocument(documentId);
  workflow.publish({
    documentId,
    expectedDocumentRowVersion: reviewed.rowVersion,
    expectedPublishedVersionId: reviewed.publishedVersionId,
  });
}

describe('ContextService', () => {
  it('tracks document versions and excludes unrelated scene content', async () => {
    const { content, contexts, workflow } = await setup();
    const sceneOne = content.saveScene({ title: '场次一' });
    const sceneTwo = content.saveScene({ title: '场次二' });
    const shot = content.saveShot({ sceneId: sceneOne.id, title: '镜头一' });
    const outline = content.saveDocument({
      kind: 'outline',
      title: '项目大纲',
      contentMarkdown: '全局大纲',
    });
    const sceneDocument = content.saveDocument({
      kind: 'scene',
      title: '场次一文档',
      contentMarkdown: '当前场次',
      scopeType: 'scene',
      scopeId: sceneOne.id,
    });
    publishDocument(workflow, sceneDocument.id, sceneDocument.rowVersion);
    const unrelatedDocument = content.saveDocument({
      kind: 'scene',
      title: '场次二文档',
      contentMarkdown: '不应泄漏',
      scopeType: 'scene',
      scopeId: sceneTwo.id,
    });
    publishDocument(workflow, unrelatedDocument.id, unrelatedDocument.rowVersion);
    publishDocument(workflow, outline.id, outline.rowVersion);
    const conversation = content.createConversation({ scopeType: 'shot', scopeId: shot.id });

    const context = contexts.compile(conversation.id);
    expect(context.rendered).toContain('当前场次');
    expect(context.rendered).not.toContain('不应泄漏');
    expect(context.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: outline.id,
          version: 1,
          versionId: outline.currentVersion?.id,
        }),
      ]),
    );
  });

  it('reuses the deterministic summary cache for long documents', async () => {
    const { projects, content, contexts, workflow } = await setup();
    const document = content.saveDocument({
      kind: 'outline',
      title: '长篇大纲',
      contentMarkdown: '开场'.repeat(5_000),
    });
    publishDocument(workflow, document.id, document.rowVersion);
    const conversation = content.createConversation({ scopeType: 'project' });

    const first = contexts.compile(conversation.id);
    const second = contexts.compile(conversation.id);
    const snapshots = projects.access(false, (database, project) =>
      createRepositories(database).contextSnapshots.listByProject(project.id, 10),
    );

    expect(first.sources[0]?.summaryCacheKey).toBe(second.sources[0]?.summaryCacheKey);
    expect(snapshots.filter((snapshot) => snapshot.purpose === 'summary-cache')).toHaveLength(1);
  });
});
