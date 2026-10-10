#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('../apps/worker/node_modules/better-sqlite3');
const input = process.argv[2];

if (!input) {
  console.error('Usage: node scripts/inspect-agent-project.mjs <project.sqlite>');
  process.exitCode = 2;
} else {
  const path = resolve(input);
  if (!existsSync(path)) {
    console.error(`Project database does not exist: ${path}`);
    process.exitCode = 2;
  } else {
    const database = new Database(path, { readonly: true });
    const one = (sql, params = []) => database.prepare(sql).get(...params) ?? null;
    const many = (sql, params = []) => database.prepare(sql).all(...params);
    const report = {
      databasePath: path,
      generatedAt: new Date().toISOString(),
      integrity: one('PRAGMA integrity_check'),
      projects: many(
        'SELECT id, name, updated_at AS updatedAt FROM projects ORDER BY updated_at DESC',
      ),
      documents: many(
        `SELECT id, kind, title, lifecycle_status AS lifecycleStatus,
                current_version_id AS currentVersionId, published_version_id AS publishedVersionId,
                updated_at AS updatedAt
         FROM documents ORDER BY updated_at DESC`,
      ),
      novelChapters: many(
        `SELECT chapters.id, chapters.display_label AS displayLabel, documents.title,
                chapters.lifecycle_status AS lifecycleStatus,
                chapters.document_id AS documentId,
                documents.current_version_id AS currentVersionId
         FROM novel_chapters chapters
         INNER JOIN documents ON documents.id = chapters.document_id
         ORDER BY chapters.position, chapters.id`,
      ),
      orphanReservedChapters: many(
        `SELECT chapters.id, chapters.display_label AS displayLabel, chapters.document_id AS documentId
         FROM novel_chapters chapters
         INNER JOIN documents ON documents.id = chapters.document_id
         WHERE chapters.lifecycle_status = 'reserved' AND documents.current_version_id IS NULL`,
      ),
      suspectChapterDocuments: many(
        `SELECT id, kind, title, lifecycle_status AS lifecycleStatus,
                current_version_id AS currentVersionId
         FROM documents
         WHERE kind IN ('outline', 'note', 'scene')
           AND (title GLOB '第*章*' OR title GLOB '*第一章*')
         ORDER BY updated_at DESC`,
      ),
      agentTasks: many(
        `SELECT id, status, phase, title, error_code AS errorCode,
                error_message AS errorMessage, request_snapshot_json AS requestSnapshotJson,
                created_at AS createdAt, updated_at AS updatedAt
         FROM agent_tasks ORDER BY created_at DESC LIMIT 100`,
      ).map((task) => ({
        ...task,
        requestSnapshot: parseJson(task.requestSnapshotJson),
        requestSnapshotJson: undefined,
      })),
      recentToolCalls: many(
        `SELECT task_id AS taskId, tool_name AS toolName, status,
                error_code AS errorCode, error_message AS errorMessage, created_at AS createdAt
         FROM agent_tool_calls ORDER BY created_at DESC LIMIT 200`,
      ),
      duplicateLibrarySources: many(
        `SELECT project_id AS projectId, source_type AS sourceType,
                source_id AS sourceId, version_id AS versionId,
                COUNT(*) AS chunkCount
         FROM project_library_chunks
         GROUP BY project_id, source_type, source_id, version_id
         HAVING COUNT(*) > 1
         ORDER BY chunkCount DESC`,
      ),
    };
    console.log(JSON.stringify(report, null, 2));
    database.close();
  }
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return { parseError: true };
  }
}
