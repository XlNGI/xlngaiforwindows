import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories } from '@ai-video/persistence';
import { ProjectService } from './project-service.js';
import { SampleProjectService } from './sample-project-service.js';

const temporaryDirectories: string[] = [];
const projectServices: ProjectService[] = [];

afterEach(async () => {
  for (const projectService of projectServices.splice(0)) projectService.close();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function temporaryRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `ai-video-sample-${name}-`));
  temporaryDirectories.push(root);
  return root;
}

function createProjectService(recentProjectsPath: string): ProjectService {
  const projectService = new ProjectService({ recentProjectsPath });
  projectServices.push(projectService);
  return projectService;
}

describe('SampleProjectService', () => {
  it('creates a usable sample with documents, scenes, and shots in one project', async () => {
    const base = await temporaryRoot('create');
    const projects = createProjectService(join(base, 'recent.json'));
    const samples = new SampleProjectService(projects);
    const result = samples.create({ rootPath: join(base, 'sample'), name: '入门短剧' });

    expect(result).toMatchObject({ name: '入门短剧', mode: 'read-write' });
    projects.access(false, (database, project) => {
      const repositories = createRepositories(database);
      const documents = repositories.documents.listByProject(project.id);
      const scenes = repositories.scenes.listByProject(project.id);
      const shots = scenes.flatMap((scene) => repositories.shots.listByScene(scene.id));
      // Document IDs are UUIDs and all seed rows share one timestamp; ordering
      // by the generated identifier is intentionally not a product contract.
      expect(documents.map((document) => document.kind).sort()).toEqual(
        ['outline', 'plan', 'character', 'scene', 'storyboard'].sort(),
      );
      expect(scenes).toHaveLength(2);
      expect(shots).toHaveLength(4);
      expect(documents.every((document) => document.currentVersionId)).toBe(true);
    });
  });

  it('rejects a non-empty target without changing its content', async () => {
    const base = await temporaryRoot('non-empty');
    const target = join(base, 'existing');
    await mkdir(target);
    await writeFile(join(target, 'marker.txt'), 'do-not-delete');
    const projects = createProjectService(join(base, 'recent.json'));
    const samples = new SampleProjectService(projects);

    expect(() => samples.create({ rootPath: target })).toThrow('empty directory');
    expect(await readFile(join(target, 'marker.txt'), 'utf8')).toBe('do-not-delete');
  });

  it('removes a newly created container when the seed transaction fails', async () => {
    const base = await temporaryRoot('rollback');
    const target = join(base, 'failed-sample');
    const projects = createProjectService(join(base, 'recent.json'));
    const samples = new SampleProjectService(projects, () => {
      throw new Error('Injected seed failure');
    });

    expect(() => samples.create({ rootPath: target })).toThrow('Injected seed failure');
    expect(existsSync(target)).toBe(false);
    expect(projects.current()).toBeUndefined();
  });

  it('does not delete files created before project ownership is established', async () => {
    const base = await temporaryRoot('ownership');
    const target = join(base, 'contended-sample');
    const projects = createProjectService(join(base, 'recent.json'));
    const samples = new SampleProjectService(projects);
    vi.spyOn(projects, 'create').mockImplementation((rootPath) => {
      mkdirSync(rootPath, { recursive: true });
      writeFileSync(join(rootPath, 'external-marker.txt'), 'preserve');
      throw new Error('Injected create failure');
    });

    expect(() => samples.create({ rootPath: target })).toThrow('Injected create failure');
    expect(await readFile(join(target, 'external-marker.txt'), 'utf8')).toBe('preserve');
  });
});
