import type Database from 'better-sqlite3';
import { requireProductionSceneDocument } from './scene-document-binding.js';
import { requireProductionCharacters } from './scene-cast-binding.js';

export interface EpisodeStructure {
  episodeTitle: string;
  scenes: Array<{
    title: string;
    sceneDocumentId?: string | null;
    sceneId?: string;
    expectedRowVersion?: number;
    videoPrompt?: string;
    characterDocumentIds?: string[];
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
      (key) =>
        ![
          'title',
          'sceneDocumentId',
          'shots',
          'sceneId',
          'expectedRowVersion',
          'videoPrompt',
          'characterDocumentIds',
        ].includes(key),
    );
    if (sceneUnknown)
      throw new Error(`Episode scene ${sceneIndex} has unsupported field: ${sceneUnknown}.`);
    const sceneTitle = normalizeTitle(typeof scene.title === 'string' ? scene.title : '');
    if (
      scene.sceneDocumentId !== undefined &&
      scene.sceneDocumentId !== null &&
      (typeof scene.sceneDocumentId !== 'string' ||
        !scene.sceneDocumentId.trim() ||
        scene.sceneDocumentId.length > 200)
    )
      throw new Error('Invalid sceneDocumentId.');
    if (
      scene.sceneId !== undefined &&
      (typeof scene.sceneId !== 'string' ||
        !scene.sceneId.trim() ||
        scene.sceneId.length > 200 ||
        !Number.isSafeInteger(scene.expectedRowVersion) ||
        (scene.expectedRowVersion as number) < 0)
    )
      throw new Error('Scene updates require sceneId and expectedRowVersion.');
    if (scene.sceneId === undefined && scene.expectedRowVersion !== undefined)
      throw new Error('New scenes cannot include expectedRowVersion.');
    if (
      scene.videoPrompt !== undefined &&
      (typeof scene.videoPrompt !== 'string' ||
        !scene.videoPrompt.trim() ||
        scene.videoPrompt.length > 20000)
    )
      throw new Error('Invalid scene videoPrompt.');
    if (
      scene.characterDocumentIds !== undefined &&
      (!Array.isArray(scene.characterDocumentIds) ||
        scene.characterDocumentIds.length > 30 ||
        new Set(scene.characterDocumentIds).size !== scene.characterDocumentIds.length ||
        scene.characterDocumentIds.some(
          (id) => typeof id !== 'string' || !id.trim() || id.length > 200,
        ))
    )
      throw new Error('Invalid scene characterDocumentIds.');
    if (
      !Array.isArray(scene.shots) ||
      scene.shots.length < (scene.sceneId ? 0 : 1) ||
      scene.shots.length > 30 ||
      (scene.sceneId && scene.shots.length > 0)
    ) {
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
      ...(scene.sceneId
        ? {
            sceneId: scene.sceneId,
            expectedRowVersion: scene.expectedRowVersion as number,
          }
        : {}),
      ...(scene.videoPrompt !== undefined ? { videoPrompt: scene.videoPrompt } : {}),
      ...(scene.characterDocumentIds !== undefined
        ? { characterDocumentIds: scene.characterDocumentIds as string[] }
        : {}),
    });
  }
  return { episodeTitle, scenes };
}

export function validateEpisodeReferences(
  database: Database.Database,
  projectId: string,
  structure: EpisodeStructure,
): void {
  for (const scene of structure.scenes) {
    if (
      scene.sceneDocumentId === undefined ||
      (!scene.sceneId && !scene.sceneDocumentId) ||
      scene.videoPrompt === undefined ||
      scene.characterDocumentIds === undefined
    )
      throw new Error(
        'Scene submission requires explicit sceneDocumentId, videoPrompt and complete characterDocumentIds.',
      );
    if (scene.sceneDocumentId)
      requireProductionSceneDocument(database, projectId, scene.sceneDocumentId);
    if (scene.characterDocumentIds !== undefined)
      requireProductionCharacters(database, projectId, scene.characterDocumentIds);
  }
}

function normalizeTitle(value: string): string {
  const title = value.normalize('NFC').trim();
  if (!title || title.length > 200) throw new Error('Agent document title is invalid.');
  return title;
}
