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
  searchProjectLibraryChunksPage,
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

function insertChapter(
  database: ReturnType<typeof openProjectDatabase>,
  now: string,
  number: number,
  content = '雨落在石阶上。',
) {
  const documentId = `chapter-${number}-doc`;
  insertDocument(database, now, {
    id: documentId,
    kind: 'note',
    title: '雾港',
    content,
    versionId: `chapter-${number}-version`,
  });
  database
    .prepare(
      `INSERT INTO novel_chapters
       (id, project_id, document_id, position, display_label, lifecycle_status,
        row_version, created_at, updated_at)
       VALUES (?, 'project', ?, ?, ?, 'active', 0, ?, ?)`,
    )
    .run(`chapter-${number}`, documentId, number - 1, `第 ${number} 章`, now, now);
  rebuildLibraryChunksForDocument(database, 'project', documentId, now);
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

  it('indexes chapter location names that are not repeated in the body', async () => {
    const { database, now } = await temporaryDatabase();
    insertDocument(database, now, {
      id: 'chapter-doc',
      kind: 'note',
      title: '雾港',
      content: '雨落在石阶上，只有潮声。',
      versionId: 'chapter-version',
    });
    database
      .prepare(
        `INSERT INTO novel_chapters
         (id, project_id, document_id, position, display_label, lifecycle_status,
          row_version, created_at, updated_at)
         VALUES (?, 'project', ?, 0, ?, 'active', 0, ?, ?)`,
      )
      .run('chapter-1', 'chapter-doc', '第 1 章', now, now);
    rebuildLibraryChunksForDocument(database, 'project', 'chapter-doc', now);

    expect(
      searchProjectLibraryChunks(database, { projectId: 'project', query: '雾港' })[0]?.chunk,
    ).toMatchObject({
      sourceType: 'novel-chapter',
      sourceId: 'chapter-1',
      title: '第 1 章 雾港',
    });
    expect(
      searchProjectLibraryChunks(database, { projectId: 'project', query: '第1章' })[0]?.chunk
        .title,
    ).toBe('第 1 章 雾港');
    expect(
      listProjectLibraryCatalog(database, 'project').find(
        (item) => item.sourceType === 'novel-chapter',
      )?.title,
    ).toBe('第 1 章 雾港');
    database.close();
  });

  it('normalizes Chinese and Arabic chapter references against default chapter labels', async () => {
    const { database, now } = await temporaryDatabase();
    insertDocument(database, now, {
      id: 'chapter-one-doc',
      kind: 'note',
      title: '雾港',
      content: '雨落在石阶上。',
      versionId: 'chapter-one-version',
    });
    database
      .prepare(
        `INSERT INTO novel_chapters
         (id, project_id, document_id, position, display_label, lifecycle_status,
          row_version, created_at, updated_at)
         VALUES (?, 'project', ?, 0, '第 1 章', 'active', 0, ?, ?)`,
      )
      .run('chapter-one', 'chapter-one-doc', now, now);
    rebuildLibraryChunksForDocument(database, 'project', 'chapter-one-doc', now);

    for (const query of ['第一章', '第1章', '第 1 章']) {
      const hits = searchProjectLibraryChunks(database, { projectId: 'project', query });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.chunk).toMatchObject({
        sourceType: 'novel-chapter',
        sourceId: 'chapter-one',
        title: '第 1 章 雾港',
      });
    }
    database.close();
  });

  it('does not return unrelated documents or chapters for a query with no textual match', async () => {
    const { database, now } = await temporaryDatabase();
    insertDocument(database, now, {
      id: 'chapter-doc',
      kind: 'note',
      title: '雾港',
      content: '雨落在石阶上。',
      versionId: 'chapter-version',
    });
    database
      .prepare(
        `INSERT INTO novel_chapters
         (id, project_id, document_id, position, display_label, lifecycle_status,
          row_version, created_at, updated_at)
         VALUES (?, 'project', ?, 0, '第 1 章', 'active', 0, ?, ?)`,
      )
      .run('chapter-1', 'chapter-doc', now, now);
    insertDocument(database, now, {
      id: 'outline-doc',
      kind: 'outline',
      title: '项目大纲',
      content: '灯塔与海雾的故事。',
      versionId: 'outline-version',
    });
    rebuildLibraryChunksForDocument(database, 'project', 'chapter-doc', now);
    rebuildLibraryChunksForDocument(database, 'project', 'outline-doc', now);

    expect(
      searchProjectLibraryChunks(database, { projectId: 'project', query: '月球空间站' }),
    ).toEqual([]);
    database.close();
  });

  it('orders equally matching novel chapters by chapter number', async () => {
    const { database, now } = await temporaryDatabase();
    for (const [position, number] of [1, 2, 3].entries()) {
      const documentId = `chapter-${number}-doc`;
      insertDocument(database, now, {
        id: documentId,
        kind: 'note',
        title: `章节 ${number}`,
        content: '本章记录了故事的发展。',
        versionId: `chapter-${number}-version`,
      });
      database
        .prepare(
          `INSERT INTO novel_chapters
           (id, project_id, document_id, position, display_label, lifecycle_status,
            row_version, created_at, updated_at)
           VALUES (?, 'project', ?, ?, ?, 'active', 0, ?, ?)`,
        )
        .run(`chapter-${number}`, documentId, position, `第 ${number} 章`, now, now);
      rebuildLibraryChunksForDocument(database, 'project', documentId, now);
    }

    expect(
      searchProjectLibraryChunks(database, { projectId: 'project', query: '章' }).map(
        (hit) => hit.chunk.sourceId,
      ),
    ).toEqual(['chapter-1', 'chapter-2', 'chapter-3']);
    expect(
      searchProjectLibraryChunks(database, { projectId: 'project', query: '第一章' }).map(
        (hit) => hit.chunk.sourceId,
      ),
    ).toEqual(['chapter-1']);
    database.close();
  });

  it('finds every explicitly requested chapter without treating chapter numbers as prefixes', async () => {
    const { database, now } = await temporaryDatabase();
    for (const number of [1, 2, 3, 11, 21]) insertChapter(database, now, number);

    for (const query of ['第一章和第二章', '第１章、第 2 章', '第一章与第二章及第一章']) {
      const page = searchProjectLibraryChunksPage(database, { projectId: 'project', query });
      expect(page.hits.map((hit) => hit.chunk.sourceId).sort()).toEqual(['chapter-1', 'chapter-2']);
      expect(page.truncated).toBe(false);
    }
    database.close();
  });

  it('normalizes digit-by-digit Chinese numbers and Chinese place values', async () => {
    const { database, now } = await temporaryDatabase();
    for (const number of [1, 11, 101, 125, 1001, 10000, 100000000]) {
      insertChapter(database, now, number);
    }
    for (const [query, number] of [
      ['第一〇一章', 101],
      ['第一零一章', 101],
      ['第１０１章', 101],
      ['第十一章', 11],
      ['第一百二十五章', 125],
      ['第一千零一章', 1001],
      ['第一万章', 10000],
      ['第一亿章', 100000000],
    ] as const) {
      expect(
        searchProjectLibraryChunks(database, { projectId: 'project', query }).map(
          (hit) => hit.chunk.sourceId,
        ),
      ).toEqual([`chapter-${number}`]);
    }
    database.close();
  });

  it('does not extract a chapter number from a malformed numeric suffix', async () => {
    const { database, now } = await temporaryDatabase();
    insertChapter(database, now, 1);
    for (const [index, title] of [
      '第2.1章',
      '第-1章',
      'abc1章',
      '第1二章',
      '第1,001章',
      '第9007199254740993章',
    ].entries()) {
      rebuildLibraryChunksForRecord(database, 'project', {
        sourceType: 'novel-chapter',
        sourceId: `malformed-${index}`,
        status: 'draft',
        title,
        content: '雨落在石阶上。',
      });
    }
    expect(
      searchProjectLibraryChunks(database, { projectId: 'project', query: '第一章' }).map(
        (hit) => hit.chunk.sourceId,
      ),
    ).toEqual(['chapter-1']);
    database.close();
  });

  it('finds an old first chapter beyond 5000 newer chunks and counts distinct source results', async () => {
    const { database, now } = await temporaryDatabase();
    insertChapter(database, '2020-01-01T00:00:00.000Z', 1, '古老灯塔位于旧码头。');
    insertChapter(database, now, 2, '古老灯塔映出石阶上的雨。');
    const duplicate = database.prepare(
      `INSERT INTO project_library_chunks
       (id, project_id, source_type, source_id, document_id, version_id, status, kind,
        scope_type, scope_id, title, ordinal, start_offset, end_offset, content_text,
        content_hash, character_count, created_at, updated_at)
       SELECT ?, project_id, source_type, source_id, document_id, version_id, status, kind,
              scope_type, scope_id, title, ?, start_offset, end_offset, content_text,
              content_hash, character_count, created_at, updated_at
       FROM project_library_chunks WHERE source_id = 'chapter-2' AND ordinal = 0`,
    );
    database.transaction(() => {
      for (let ordinal = 1; ordinal <= 5001; ordinal += 1) {
        duplicate.run(`newer-chunk-${ordinal}`, ordinal);
      }
    })();

    const first = searchProjectLibraryChunksPage(database, {
      projectId: 'project',
      query: '第一章',
      limit: 1,
    });
    expect(first.hits.map((hit) => [hit.chunk.sourceId, hit.chunk.ordinal])).toEqual([
      ['chapter-1', 0],
    ]);
    expect(first.truncated).toBe(false);
    const second = searchProjectLibraryChunksPage(database, {
      projectId: 'project',
      query: '第二章',
      limit: 1,
    });
    expect(second.hits[0]?.chunk.ordinal).toBe(0);
    expect(second.truncated).toBe(false);
    const both = searchProjectLibraryChunksPage(database, {
      projectId: 'project',
      query: '章',
      limit: 1,
    });
    expect(both.hits[0]?.chunk.sourceId).toBe('chapter-1');
    expect(both.truncated).toBe(true);
    expect(
      searchProjectLibraryChunksPage(database, { projectId: 'project', query: '章', limit: 2 })
        .truncated,
    ).toBe(false);
    expect(
      searchProjectLibraryChunks(database, { projectId: 'project', query: '码头' })[0]?.chunk
        .sourceId,
    ).toBe('chapter-1');
    const fts = searchProjectLibraryChunksPage(database, {
      projectId: 'project',
      query: '古老灯塔',
      limit: 2,
    });
    expect(fts.hits.map((hit) => hit.chunk.sourceId)).toEqual(['chapter-1', 'chapter-2']);
    expect(fts.truncated).toBe(false);
    database.close();
  });
});
