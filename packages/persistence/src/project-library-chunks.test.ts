import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  listProjectLibraryCatalog,
  migrateDatabase,
  openProjectDatabase,
  rebuildLibraryChunksForDocument,
  rebuildLibraryChunksForRecord,
  searchProjectLibraryChunks,
} from './index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function temporaryDatabase() {
  const directory = await mkdtemp(join(tmpdir(), 'ai-video-library-chunks-'));
  temporaryDirectories.push(directory);
  const database = openProjectDatabase(join(directory, 'project.sqlite'));
  migrateDatabase(database);
  const now = new Date().toISOString();
  database
    .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run('project', 'Library', now, now);
  return { database, now };
}

function insertDocument(
  database: ReturnType<typeof openProjectDatabase>,
  now: string,
  params: { id: string; kind: string; title: string; content: string; versionId: string },
) {
  database
    .prepare(
      `INSERT INTO documents
       (id, project_id, kind, title, scope_type, lifecycle_status, row_version, created_at, updated_at)
       VALUES (?, 'project', ?, ?, 'project', 'active', 0, ?, ?)`,
    )
    .run(params.id, params.kind, params.title, now, now);
  database
    .prepare(
      `INSERT INTO document_versions
       (id, document_id, version, content_markdown, state, title_snapshot, scope_type_snapshot,
        author_type, content_hash, state_updated_at, created_at)
       VALUES (?, ?, 1, ?, 'draft', ?, 'project', 'user', ?, ?, ?)`,
    )
    .run(
      params.versionId,
      params.id,
      params.content,
      params.title,
      createHash('sha256').update(params.content).digest('hex'),
      now,
      now,
    );
  database
    .prepare('UPDATE documents SET current_version_id = ? WHERE id = ?')
    .run(params.versionId, params.id);
}

describe('project library chunks', () => {
  it('matches Chinese two-character names and scene titles', async () => {
    const { database, now } = await temporaryDatabase();
    insertDocument(database, now, {
      id: 'character',
      kind: 'character',
      title: '林澈',
      content: '林澈是灯塔守望员。',
      versionId: 'character-version',
    });
    insertDocument(database, now, {
      id: 'scene',
      kind: 'scene',
      title: '旧码头',
      content: '夜晚的旧码头只有潮声。',
      versionId: 'scene-version',
    });
    rebuildLibraryChunksForDocument(database, 'project', 'character', now);
    rebuildLibraryChunksForDocument(database, 'project', 'scene', now);

    const character = searchProjectLibraryChunks(database, { projectId: 'project', query: '林澈' });
    const scene = searchProjectLibraryChunks(database, { projectId: 'project', query: '旧码头' });
    expect(character[0]?.chunk.title).toBe('林澈');
    expect(character[0]?.chunk.status).toBe('draft');
    expect(scene[0]?.chunk.title).toBe('旧码头');
    database.close();
  });

  it('keeps draft and published versions searchable side by side', async () => {
    const { database, now } = await temporaryDatabase();
    insertDocument(database, now, {
      id: 'outline',
      kind: 'outline',
      title: '项目大纲',
      content: '第一版雾港提纲',
      versionId: 'published-version',
    });
    database
      .prepare(
        `INSERT INTO document_versions
         (id, document_id, version, content_markdown, state, title_snapshot, scope_type_snapshot,
          author_type, content_hash, state_updated_at, created_at)
         VALUES (?, ?, 2, ?, 'draft', ?, 'project', 'user', ?, ?, ?)`,
      )
      .run(
        'draft-version',
        'outline',
        '第二版灯塔提纲',
        '项目大纲',
        createHash('sha256').update('第二版灯塔提纲').digest('hex'),
        now,
        now,
      );
    database
      .prepare('UPDATE documents SET current_version_id = ?, published_version_id = ? WHERE id = ?')
      .run('draft-version', 'published-version', 'outline');
    rebuildLibraryChunksForDocument(database, 'project', 'outline', now);

    const draft = searchProjectLibraryChunks(database, {
      projectId: 'project',
      query: '灯塔提纲',
      status: 'draft',
    });
    const published = searchProjectLibraryChunks(database, {
      projectId: 'project',
      query: '雾港提纲',
      status: 'published',
    });
    expect(draft[0]?.chunk.status).toBe('draft');
    expect(published[0]?.chunk.status).toBe('published');
    database.close();
  });

  it('indexes memories, constraints, conversations, and asset aliases', async () => {
    const { database, now } = await temporaryDatabase();
    rebuildLibraryChunksForRecord(
      database,
      'project',
      {
        sourceType: 'memory',
        sourceId: 'memory-1',
        status: 'memory',
        title: '项目记忆',
        content: '记住林澈怕海雾',
      },
      now,
    );
    rebuildLibraryChunksForRecord(
      database,
      'project',
      {
        sourceType: 'constraint',
        sourceId: 'constraint-1',
        status: 'constraint',
        kind: 'production',
        title: '生产约束：production',
        content: '所有镜头保持冷色调',
      },
      now,
    );
    rebuildLibraryChunksForRecord(
      database,
      'project',
      {
        sourceType: 'conversation',
        sourceId: 'message-1',
        status: 'conversation',
        title: '会话记录',
        content: 'user: 旧码头今晚有潮声',
      },
      now,
    );
    rebuildLibraryChunksForRecord(
      database,
      'project',
      {
        sourceType: 'asset',
        sourceId: 'asset-1',
        status: 'active',
        title: '雾港角色图',
        content: '雾港角色图\nhero.png\nimage',
      },
      now,
    );

    expect(
      searchProjectLibraryChunks(database, { projectId: 'project', query: '怕海雾' })[0]?.chunk
        .sourceType,
    ).toBe('memory');
    expect(
      searchProjectLibraryChunks(database, { projectId: 'project', query: '冷色调' })[0]?.chunk
        .sourceType,
    ).toBe('constraint');
    expect(
      searchProjectLibraryChunks(database, {
        projectId: 'project',
        query: '潮声',
        sourceTypes: ['conversation'],
      })[0]?.chunk.sourceType,
    ).toBe('conversation');
    expect(
      searchProjectLibraryChunks(database, { projectId: 'project', query: '雾港角色图' })[0]?.chunk
        .title,
    ).toBe('雾港角色图');
    database.close();
  });

  it('keeps named conversations first and caps untitled chats in the catalog', async () => {
    const { database, now } = await temporaryDatabase();
    const insert = database.prepare(
      `INSERT INTO conversations (id, project_id, scope_type, title, created_at, updated_at, archived_at)
       VALUES (?, 'project', 'project', ?, ?, ?, ?)`,
    );
    insert.run('named', '角色讨论', now, '2026-09-19T10:00:00.000Z', null);
    for (let index = 0; index < 7; index += 1) {
      insert.run(`untitled-${index}`, '新会话', now, `2026-09-19T09:0${index}:00.000Z`, null);
    }
    insert.run('archived', '新会话', now, '2026-09-19T11:00:00.000Z', '2026-09-19T11:00:00.000Z');

    const conversations = listProjectLibraryCatalog(database, 'project').filter(
      (item) => item.sourceType === 'conversation',
    );
    expect(conversations).toHaveLength(5);
    expect(conversations[0]).toMatchObject({ sourceId: 'named', title: '角色讨论' });
    expect(conversations.slice(1).map((item) => item.sourceId)).toEqual([
      'untitled-6',
      'untitled-5',
      'untitled-4',
      'untitled-3',
    ]);
    database.close();
  });

  it('ranks a character title above a body that repeats the whole request', async () => {
    const { database, now } = await temporaryDatabase();
    insertDocument(database, now, {
      id: 'character',
      kind: 'character',
      title: '林澈',
      content: '林澈是灯塔守望员。',
      versionId: 'character-version',
    });
    insertDocument(database, now, {
      id: 'outline',
      kind: 'outline',
      title: '项目大纲',
      content: '根据林澈的角色设定生成剧本。'.repeat(20),
      versionId: 'outline-version',
    });
    rebuildLibraryChunksForDocument(database, 'project', 'character', now);
    rebuildLibraryChunksForDocument(database, 'project', 'outline', now);

    const hits = searchProjectLibraryChunks(database, {
      projectId: 'project',
      query: '林澈的角色设定',
    });
    expect(hits[0]?.chunk.title).toBe('林澈');
    expect(hits[0]?.chunk.kind).toBe('character');
    expect(hits[0]?.matchKind).toBe('title');
    expect(hits[0]?.kindLabel).toBe('角色设定');
    database.close();
  });

  it('ranks the named chapter above documents that only mention it', async () => {
    const { database, now } = await temporaryDatabase();
    rebuildLibraryChunksForRecord(
      database,
      'project',
      {
        sourceType: 'novel-chapter',
        sourceId: 'chapter-1',
        status: 'draft',
        title: '第一章',
        content: '雾港的雨落在石阶上，林澈提着马灯走向旧码头。',
      },
      now,
    );
    rebuildLibraryChunksForRecord(
      database,
      'project',
      {
        sourceType: 'novel-chapter',
        sourceId: 'chapter-11',
        status: 'draft',
        title: '第十一章',
        content: '第一章的余波还在旧码头回响。',
      },
      now,
    );
    insertDocument(database, now, {
      id: 'plan',
      kind: 'plan',
      title: '本集计划',
      content: '根据第一章生成剧本，把第一章改成短剧场次。'.repeat(12),
      versionId: 'plan-version',
    });
    rebuildLibraryChunksForDocument(database, 'project', 'plan', now);

    const hits = searchProjectLibraryChunks(database, {
      projectId: 'project',
      query: '根据第一章生成剧本',
    });
    expect(hits[0]?.chunk.title).toBe('第一章');
    expect(hits[0]?.chunk.sourceType).toBe('novel-chapter');
    expect(hits[0]?.matchKind).toBe('title');
    expect(hits[0]?.sourceTypeLabel).toBe('小说章节');
    expect(hits.find((item) => item.chunk.title === '第十一章')?.score ?? 0).toBeLessThan(
      hits[0]!.score,
    );
    database.close();
  });

  it('ranks a book-title mark against the document title', async () => {
    const { database, now } = await temporaryDatabase();
    insertDocument(database, now, {
      id: 'named',
      kind: 'note',
      title: '雾港',
      content: '这是书名笔记。',
      versionId: 'named-version',
    });
    insertDocument(database, now, {
      id: 'outline',
      kind: 'outline',
      title: '项目大纲',
      content: '雾港的雨落在石阶上。'.repeat(8),
      versionId: 'outline-version',
    });
    rebuildLibraryChunksForDocument(database, 'project', 'named', now);
    rebuildLibraryChunksForDocument(database, 'project', 'outline', now);

    const hits = searchProjectLibraryChunks(database, {
      projectId: 'project',
      query: '《雾港》',
    });
    expect(hits[0]?.chunk.title).toBe('雾港');
    expect(hits[0]?.matchKind).toBe('title');
    database.close();
  });
});
