import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import type { SampleProjectCreateParams } from '@ai-video/contracts';
import type { OpenProject } from '@ai-video/domain';
import { createRepositories } from '@ai-video/persistence';
import { ProjectService } from './project-service.js';

export type SampleProjectSeeder = (database: Database.Database, project: OpenProject) => void;

export class SampleProjectService {
  constructor(
    private readonly projects: ProjectService,
    private readonly seed: SampleProjectSeeder = seedSampleProject,
  ) {}

  create(params: SampleProjectCreateParams): OpenProject {
    if (!params.rootPath.trim() || !isAbsolute(params.rootPath)) {
      throw new Error('Sample project path must be absolute.');
    }
    const rootPath = resolve(params.rootPath);
    const existed = existsSync(rootPath);
    if (existed && (!statSync(rootPath).isDirectory() || readdirSync(rootPath).length > 0)) {
      throw new Error('Sample project destination must be an empty directory.');
    }

    let ownsProjectContainer = false;
    try {
      const project = this.projects.create(rootPath, params.name?.trim() || '示例项目：雾港来信');
      ownsProjectContainer = true;
      this.projects.access(true, (database, activeProject) => {
        database.transaction(() => this.seed(database, activeProject))();
      });
      return project;
    } catch (error) {
      if (ownsProjectContainer) {
        this.projects.close();
        rmSync(rootPath, { recursive: true, force: true });
        if (existed) mkdirSync(rootPath, { recursive: true });
      }
      throw error;
    }
  }
}

function seedSampleProject(database: Database.Database, project: OpenProject): void {
  const repositories = createRepositories(database);
  const now = new Date().toISOString();
  const documents = [
    {
      kind: 'outline',
      title: '故事大纲',
      content:
        '# 雾港来信\n\n台风封港前夜，年轻灯塔守望员收到一封来自十年前的求救信。她必须在潮水淹没旧码头前，找到失踪船长留下的真相。',
    },
    {
      kind: 'plan',
      title: '项目计划',
      content:
        '# 项目计划\n\n- 类型：悬疑短剧\n- 集数：3 集\n- 单集时长：90 秒\n- 视觉基调：冷色海雾、暖色灯塔\n- 当前目标：完成第一集码头段落',
    },
    {
      kind: 'character',
      title: '角色设定',
      content:
        '# 林澈\n\n24 岁，灯塔守望员。克制、敏锐，对父亲当年的失踪仍心存疑问。\n\n# 周叔\n\n58 岁，旧码头管理员。熟悉港口往事，但一直回避十年前的事故。',
    },
    {
      kind: 'scene',
      title: '场景设定',
      content:
        '# 旧码头\n\n生锈的系船柱、被风掀起的警戒带、能见度极低的海雾。\n\n# 灯塔值班室\n\n狭窄、整洁，旋转灯光每隔数秒扫过墙上的旧海图。',
    },
    {
      kind: 'storyboard',
      title: '第一集分镜',
      content:
        '# 第一集：来信\n\n1. 海雾中的旧码头全景。\n2. 林澈拾起被海水浸湿的信封。\n3. 信纸日期特写：十年前的今天。\n4. 远处灯塔突然熄灭。',
    },
  ] as const;

  for (const input of documents) {
    const documentId = randomUUID();
    const versionId = randomUUID();
    repositories.documents.saveVersion(
      {
        id: documentId,
        projectId: project.id,
        kind: input.kind,
        title: input.title,
        scopeType: 'project',
        currentVersionId: versionId,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: versionId,
        documentId,
        version: 1,
        contentMarkdown: input.content,
        createdAt: now,
      },
    );
  }

  const sceneInputs = [
    { title: '旧码头 · 台风前夜', shots: ['海雾中的码头', '潮水送来的信封'] },
    { title: '灯塔 · 值班室', shots: ['十年前的日期', '灯塔突然熄灭'] },
  ];
  for (const [scenePosition, input] of sceneInputs.entries()) {
    const sceneId = randomUUID();
    repositories.scenes.save({
      id: sceneId,
      projectId: project.id,
      title: input.title,
      position: scenePosition,
      rowVersion: 0,
      createdAt: now,
      updatedAt: now,
    });
    for (const [shotPosition, title] of input.shots.entries()) {
      repositories.shots.save({
        id: randomUUID(),
        sceneId,
        title,
        position: shotPosition,
        status: 'draft',
        rowVersion: 0,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  repositories.projects.touch(now);
  project.updatedAt = now;
}
