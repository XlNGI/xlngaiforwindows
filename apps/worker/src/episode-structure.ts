import type Database from 'better-sqlite3';
import {
  validateProductionAuthoringIR,
  type ProductionSceneAuthoringIR,
  type ProductionShotAuthoringIR,
} from '@ai-video/contracts';
import { requireProductionSceneDocument } from './scene-document-binding.js';
import { requireProductionCharacters } from './scene-cast-binding.js';

export interface EpisodeStructure {
  episodeTitle: string;
  scenes: Array<{
    title: string;
    sceneDocumentId?: string | null;
    sceneId?: string;
    expectedRowVersion?: number;
    /** Prompt projection populated from authoringIR or an existing scene during a binding edit. */
    videoPrompt?: string;
    characterDocumentIds?: string[];
    authoringIR?: ProductionSceneAuthoringIR;
    shots: Array<{
      title: string;
      prompt: string;
      authoringIR: ProductionShotAuthoringIR;
    }>;
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
          'characterDocumentIds',
          'authoringIR',
        ].includes(key),
    );
    if (sceneUnknown)
      throw new Error(`Episode scene ${sceneIndex} has unsupported field: ${sceneUnknown}.`);
    const sceneTitle = normalizeTitle(typeof scene.title === 'string' ? scene.title : '');
    const sceneAuthoringIR =
      scene.authoringIR === undefined
        ? undefined
        : (validateProductionAuthoringIR(scene.authoringIR, 'scene') as ProductionSceneAuthoringIR);
    if (scene.sceneId === undefined && !sceneAuthoringIR)
      throw new Error(`scenes[${sceneIndex}] requires authoringIR when creating a scene.`);

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
      throw new Error(
        scene.sceneId
          ? `Existing scene ${sceneIndex} must use shots: []; revise existing shots with scene.update_shot_prompts or scene.update_shot_timings.`
          : `Episode scene ${sceneIndex} shots must contain between one and 30 items.`,
      );
    }

    const shots: EpisodeStructure['scenes'][number]['shots'] = [];
    for (const [shotIndex, rawShot] of scene.shots.entries()) {
      if (!rawShot || typeof rawShot !== 'object' || Array.isArray(rawShot)) {
        throw new Error(`Episode shot ${sceneIndex}:${shotIndex} must be an object.`);
      }
      const shot = rawShot as Record<string, unknown>;
      const shotUnknown = Object.keys(shot).find((key) => !['title', 'authoringIR'].includes(key));
      if (shotUnknown)
        throw new Error(
          `Episode shot ${sceneIndex}:${shotIndex} has unsupported field: ${shotUnknown}.`,
        );
      const shotTitle = normalizeTitle(typeof shot.title === 'string' ? shot.title : '');
      const authoringIR = validateProductionAuthoringIR(
        shot.authoringIR,
        'shot',
      ) as ProductionShotAuthoringIR;
      shots.push({ title: shotTitle, prompt: authoringIR.prompt, authoringIR });
    }

    scenes.push({
      title: sceneTitle,
      shots,
      ...(sceneAuthoringIR
        ? { authoringIR: sceneAuthoringIR, videoPrompt: sceneAuthoringIR.prompt }
        : {}),
      ...(scene.sceneDocumentId !== undefined ? { sceneDocumentId: scene.sceneDocumentId } : {}),
      ...(scene.sceneId
        ? {
            sceneId: scene.sceneId,
            expectedRowVersion: scene.expectedRowVersion as number,
          }
        : {}),
      ...(scene.characterDocumentIds !== undefined
        ? { characterDocumentIds: scene.characterDocumentIds as string[] }
        : {}),
    });
  }
  if (scenes.reduce((total, scene) => total + 1 + scene.shots.length, 0) > 100)
    throw new Error(
      'scenes exceeds the proposal limit of 100 scene + shot items; split into multiple proposals.',
    );
  return { episodeTitle, scenes };
}

export function validateEpisodeReferences(
  database: Database.Database,
  projectId: string,
  structure: EpisodeStructure,
): void {
  for (const scene of structure.scenes) {
    if (scene.sceneId && !scene.authoringIR) {
      const current = database
        .prepare(
          'SELECT video_prompt,authoring_ir_json,row_version FROM scenes WHERE id=? AND project_id=?',
        )
        .get(scene.sceneId, projectId) as
        | { video_prompt: string | null; authoring_ir_json: string | null; row_version: number }
        | undefined;
      if (!current || current.row_version !== scene.expectedRowVersion)
        throw new Error('SCENE_ROW_VERSION_CONFLICT');
      if (current.authoring_ir_json) {
        scene.authoringIR = validateProductionAuthoringIR(
          JSON.parse(current.authoring_ir_json),
          'scene',
        ) as ProductionSceneAuthoringIR;
        scene.videoPrompt = scene.authoringIR.prompt;
      } else if (current.video_prompt !== null) {
        scene.videoPrompt = current.video_prompt;
      }
    }
    if (scene.sceneId === undefined && !scene.authoringIR)
      throw new Error('New scenes require authoringIR.');
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
