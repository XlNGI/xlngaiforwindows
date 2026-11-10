import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ProjectService } from './project-service.js';
import { ContentService } from './content-service.js';
const paths: string[] = [],
  projects: ProjectService[] = [];
afterEach(async () => {
  for (const p of projects.splice(0)) p.close();
  for (const p of paths.splice(0)) await rm(p, { recursive: true, force: true });
});
it('stores voice description, audition and character reference in existing version storage across reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'production-voice-'));
  paths.push(root);
  const p = new ProjectService({ recentProjectsPath: join(root, 'recent.json') });
  projects.push(p);
  p.create(join(root, 'project'), 'Voice');
  let content = new ContentService(p);
  const voice = content.saveDocument({
    kind: 'voice',
    title: '客服声音',
    contentMarkdown: '清晰、克制、自然中音。',
    sampleText: '您好，订单正在处理。',
    bindings: { schemaVersion: 1 as const },
  });
  const hero = content.saveDocument({
    kind: 'character',
    title: '客服',
    contentMarkdown: '客服视觉资料。',
    bindings: { schemaVersion: 1 as const, voiceDocumentId: voice.id },
  });
  expect(() =>
    content.saveDocument({
      kind: 'character',
      title: '无效声音',
      contentMarkdown: '内容',
      bindings: { schemaVersion: 1 as const, voiceDocumentId: 'missing' },
    }),
  ).toThrow('voiceDocumentId');
  content.saveDocument({
    documentId: voice.id,
    title: voice.title,
    contentMarkdown: '人工修改音色描述',
    expectedDocumentRowVersion: voice.rowVersion,
  });
  content.saveDocument({
    documentId: hero.id,
    title: hero.title,
    contentMarkdown: '人工修改视觉正文',
    expectedDocumentRowVersion: hero.rowVersion,
  });
  p.close();
  p.open(join(root, 'project'));
  content = new ContentService(p);
  expect(content.getDocument(voice.id).kind).toBe('voice');
  expect(content.getDocument(voice.id).currentVersion?.sampleText).toBe('您好，订单正在处理。');
  expect(content.getDocument(hero.id).currentVersion?.bindings?.voiceDocumentId).toBe(voice.id);
  p.access(false, (db) => {
    expect(db.prepare('SELECT COUNT(*) n FROM audio_files').get()).toEqual({ n: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});
import { DocumentWorkflowService } from './document-workflow-service.js';
it('protects published audition text and preserves it when the user returns to a draft', async () => {
  const root = await mkdtemp(join(tmpdir(), 'published-voice-'));
  paths.push(root);
  const p = new ProjectService({ recentProjectsPath: join(root, 'recent.json') });
  projects.push(p);
  p.create(join(root, 'project'), '声音');
  const workflow = new DocumentWorkflowService(p);
  const draft = workflow.saveDraft({
    kind: 'voice',
    title: '声音',
    contentMarkdown: '普通音色描述',
    sampleText: '  原试音文本。  ',
    bindings: { schemaVersion: 1 },
  });
  const published = workflow.selfPublish({
    documentId: draft.id,
    expectedDocumentRowVersion: draft.rowVersion,
  });
  expect(() =>
    p.access(true, (db) =>
      db
        .prepare('UPDATE document_versions SET sample_text=? WHERE id=?')
        .run('伪造试音', published.document.currentVersionId),
    ),
  ).toThrow('published document is read-only');
  const restored = workflow.unpublish({
    documentId: draft.id,
    expectedDocumentRowVersion: published.document.rowVersion,
  });
  expect(restored.currentVersion?.sampleText).toBe('  原试音文本。  ');
  expect(restored.currentVersion?.bindings).toEqual({ schemaVersion: 1 });
});
