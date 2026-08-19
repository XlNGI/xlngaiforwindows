import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChangeSetService } from './change-set-service.js';
import { ContentService } from './content-service.js';
import { ProjectService } from './project-service.js';

const directories: string[] = [];
const services: ProjectService[] = [];

afterEach(async () => {
  for (const service of services.splice(0)) service.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function setup(name = 'change-set') {
  const directory = await mkdtemp(join(tmpdir(), `ai-video-${name}-`));
  directories.push(directory);
  const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  services.push(projects);
  projects.create(join(directory, 'project'), 'Change Set Project');
  return {
    projects,
    content: new ContentService(projects),
    changeSets: new ChangeSetService(projects),
  };
}

describe('ChangeSetService', () => {
  it('creates and applies a scene plus dependent shot proposal', async () => {
    const { changeSets } = await setup();
    const proposed = changeSets.create({
      title: 'Opening sequence',
      items: [
        { entityType: 'scene', action: 'create', title: 'Scene 01' },
        {
          entityType: 'shot',
          action: 'create',
          parentItemOrdinal: 0,
          title: 'Wide establishing shot',
          shotStatus: 'planned',
        },
      ],
    });
    expect(proposed.status).toBe('proposed');
    const applied = changeSets.apply({
      changeSetId: proposed.id,
      expectedRowVersion: proposed.rowVersion,
    });
    expect(applied.status).toBe('applied');
    expect(applied.items).toMatchObject([
      { entityType: 'scene', status: 'applied' },
      { entityType: 'shot', status: 'applied' },
    ]);
    expect(applied.items[1]!.appliedEntityId).toBeTruthy();
  });

  it('supports selected partial apply and reject', async () => {
    const { changeSets } = await setup();
    const proposed = changeSets.create({
      title: 'Two scenes',
      items: [
        { entityType: 'scene', action: 'create', title: 'Scene A' },
        { entityType: 'scene', action: 'create', title: 'Scene B' },
      ],
    });
    const first = changeSets.apply({
      changeSetId: proposed.id,
      expectedRowVersion: proposed.rowVersion,
      itemIds: [proposed.items[0]!.id],
    });
    expect(first.status).toBe('partially_applied');
    const rejected = changeSets.reject({
      changeSetId: first.id,
      expectedRowVersion: first.rowVersion,
      itemIds: [first.items[1]!.id],
    });
    expect(rejected.status).toBe('partially_applied');
    expect(rejected.items.map((item) => item.status)).toEqual(['applied', 'rejected']);
  });

  it('marks all selected items conflicted and rolls back when CAS fails', async () => {
    const { changeSets, content } = await setup();
    const scene = content.saveScene({ title: 'Existing' });
    const proposed = changeSets.create({
      title: 'Rename existing scene',
      items: [
        {
          entityType: 'scene',
          action: 'update',
          targetId: scene.id,
          expectedRowVersion: scene.rowVersion,
          title: 'Proposed name',
        },
        { entityType: 'scene', action: 'create', title: 'New scene' },
      ],
    });
    content.saveScene({ sceneId: scene.id, title: 'Concurrent name', expectedRowVersion: 0 });
    const conflicted = changeSets.apply({
      changeSetId: proposed.id,
      expectedRowVersion: proposed.rowVersion,
    });
    expect(conflicted.status).toBe('conflicted');
    expect(conflicted.items.every((item) => item.status === 'conflicted')).toBe(true);
    expect(content.listScenes()).toMatchObject([{ id: scene.id, title: 'Concurrent name' }]);
  });

  it('applies a document and scene together in one transaction', async () => {
    const { changeSets, content } = await setup();
    const proposed = changeSets.create({
      title: 'Scene package with notes',
      items: [
        {
          entityType: 'document',
          action: 'create',
          title: 'Scene notes',
          documentKind: 'scene',
          contentMarkdown: '# Scene notes\n\nBlocking action.',
        },
        { entityType: 'scene', action: 'create', title: 'Scene 01' },
      ],
    });
    const applied = changeSets.apply({
      changeSetId: proposed.id,
      expectedRowVersion: proposed.rowVersion,
    });
    expect(applied.status).toBe('applied');
    const document = content.getDocument(applied.items[0]!.appliedEntityId!);
    expect(document.title).toBe('Scene notes');
    expect(document.currentVersion?.contentMarkdown).toContain('Blocking action.');
    expect(content.listScenes()).toHaveLength(1);
  });

  it('rolls back scene changes when an associated document CAS conflicts', async () => {
    const { changeSets, content } = await setup();
    const document = content.saveDocument({
      kind: 'scene',
      title: 'Existing notes',
      contentMarkdown: '# Before',
    });
    const proposed = changeSets.create({
      title: 'Update notes and add scene',
      items: [
        {
          entityType: 'document',
          action: 'update',
          targetId: document.id,
          expectedRowVersion: document.rowVersion,
          expectedCurrentVersionId: document.currentVersion!.id,
          title: 'Proposed notes',
          documentKind: 'scene',
          contentMarkdown: '# Proposed',
        },
        { entityType: 'scene', action: 'create', title: 'Must roll back' },
      ],
    });
    content.saveDocument({
      documentId: document.id,
      kind: 'scene',
      title: 'Concurrent notes',
      contentMarkdown: '# Concurrent',
      expectedDocumentRowVersion: document.rowVersion,
    });
    const conflicted = changeSets.apply({
      changeSetId: proposed.id,
      expectedRowVersion: proposed.rowVersion,
    });
    expect(conflicted.status).toBe('conflicted');
    expect(content.listScenes()).toHaveLength(0);
    expect(content.getDocument(document.id).title).toBe('Concurrent notes');
  });

  it('rejects cross-project access', async () => {
    const first = await setup('first');
    const proposed = first.changeSets.create({
      title: 'Private proposal',
      items: [{ entityType: 'scene', action: 'create', title: 'Private scene' }],
    });
    const second = await setup('second');
    expect(() =>
      second.changeSets.apply({ changeSetId: proposed.id, expectedRowVersion: 0 }),
    ).toThrow('Change set is not available for review.');
    expect(second.changeSets.list()).toEqual([]);
  });

  it('rejects stale repeated application', async () => {
    const { changeSets } = await setup();
    const proposed = changeSets.create({
      title: 'Single scene',
      items: [{ entityType: 'scene', action: 'create', title: 'Scene' }],
    });
    const applied = changeSets.apply({
      changeSetId: proposed.id,
      expectedRowVersion: proposed.rowVersion,
    });
    expect(() =>
      changeSets.apply({ changeSetId: applied.id, expectedRowVersion: proposed.rowVersion }),
    ).toThrow('Change set is not available for review.');
  });
});
