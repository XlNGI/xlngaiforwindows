import type Database from 'better-sqlite3';
import { requireProductionSceneDocument } from './scene-document-binding.js';

export interface EpisodeStructure {
  episodeTitle: string;
  scenes: Array<{
    title: string;
    sceneDocumentId?: string;
    shots: Array<{ title: string; prompt: string }>;
  }>;
}

export function parseEpisodeStructureArguments(value: string): EpisodeStructure {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Episode structure arguments are not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Episode structure arguments must be an object.');
  }
  const record = parsed as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !['episodeTitle', 'scenes'].includes(key));
  if (unknown) throw new Error(`Episode structure has unsupported field: ${unknown}.`);
  const episodeTitle = normalizeTitle(
    typeof record.episodeTitle === 'string' ? record.episodeTitle : '',
  );
  if (!Array.isArray(record.scenes) || record.scenes.length < 1 || record.scenes.length > 20) {
    throw new Error('Episode structure scenes must contain between one and 20 items.');
  }
  const scenes: EpisodeStructure['scenes'] = [];
  for (const [sceneIndex, rawScene] of record.scenes.entries()) {
    if (!rawScene || typeof rawScene !== 'object' || Array.isArray(rawScene)) {
      throw new Error(`Episode scene ${sceneIndex} must be an object.`);
    }
    const scene = rawScene as Record<string, unknown>;
    const sceneUnknown = Object.keys(scene).find(
      (key) => !['title', 'sceneDocumentId', 'shots'].includes(key),
    );
    if (sceneUnknown)
      throw new Error(`Episode scene ${sceneIndex} has unsupported field: ${sceneUnknown}.`);
    const sceneTitle = normalizeTitle(typeof scene.title === 'string' ? scene.title : '');
    if (
      scene.sceneDocumentId !== undefined &&
      (typeof scene.sceneDocumentId !== 'string' ||
        !scene.sceneDocumentId.trim() ||
        scene.sceneDocumentId.length > 200)
    )
      throw new Error('Invalid sceneDocumentId.');
    if (!Array.isArray(scene.shots) || scene.shots.length < 1 || scene.shots.length > 30) {
      throw new Error(`Episode scene ${sceneIndex} shots must contain between one and 30 items.`);
    }
    const shots: EpisodeStructure['scenes'][number]['shots'] = [];
    for (const [shotIndex, rawShot] of scene.shots.entries()) {
      if (!rawShot || typeof rawShot !== 'object' || Array.isArray(rawShot)) {
        throw new Error(`Episode shot ${sceneIndex}:${shotIndex} must be an object.`);
      }
      const shot = rawShot as Record<string, unknown>;
      const shotUnknown = Object.keys(shot).find((key) => !['title', 'prompt'].includes(key));
      if (shotUnknown)
        throw new Error(
          `Episode shot ${sceneIndex}:${shotIndex} has unsupported field: ${shotUnknown}.`,
        );
      const shotTitle = normalizeTitle(typeof shot.title === 'string' ? shot.title : '');
      if (typeof shot.prompt !== 'string' || !shot.prompt.trim() || shot.prompt.length > 2000) {
        throw new Error(
          `Episode shot ${sceneIndex}:${shotIndex} prompt must be between 1 and 2000 characters.`,
        );
      }
      shots.push({ title: shotTitle, prompt: shot.prompt.trim() });
    }
    scenes.push({
      title: sceneTitle,
      shots,
      ...(scene.sceneDocumentId !== undefined ? { sceneDocumentId: scene.sceneDocumentId } : {}),
    });
  }
  return { episodeTitle, scenes };
}

export function validateEpisodeReferences(
  database: Database.Database,
  projectId: string,
  structure: EpisodeStructure,
): void {
  const rows = database
    .prepare(
      `SELECT documents.kind AS kind, versions.content_markdown AS content_markdown
       FROM documents
       INNER JOIN document_versions versions ON versions.id = documents.published_version_id
       WHERE documents.project_id = ? AND documents.lifecycle_status = 'active'
         AND documents.kind IN ('character', 'scene')`,
    )
    .all(projectId) as Array<{ kind: string; content_markdown: string }>;
  const names = new Set<string>();
  for (const row of rows) {
    for (const line of row.content_markdown.split(/\r?\n/)) {
      const match = /^#\s+(.+)$/.exec(line.trim());
      if (match?.[1]?.trim()) names.add(match[1].trim());
    }
  }
  const referencePattern = /\[(角色|场景):([^\]]+)\]/g;
  for (const scene of structure.scenes) {
    if (scene.sceneDocumentId)
      requireProductionSceneDocument(database, projectId, scene.sceneDocumentId);
    for (const shot of scene.shots) {
      for (const match of shot.prompt.matchAll(referencePattern)) {
        const label = match[1] === '角色' ? 'character' : 'scene';
        const name = (match[2] ?? '').trim();
        if (!name || !names.has(name)) {
          throw new Error(
            `Episode structure references unknown ${label} "${name}". Publish the character/scene prompt first or fix the placeholder.`,
          );
        }
      }
    }
  }
}

function normalizeTitle(value: string): string {
  const title = value.normalize('NFC').trim();
  if (!title || title.length > 200) throw new Error('Agent document title is invalid.');
  return title;
}
