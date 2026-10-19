import type Database from 'better-sqlite3';
import { renderProductionInstruction, type ProductionInstruction } from '@ai-video/contracts';
import { inspectProductionTargetInstruction } from '@ai-video/generation-adapters';
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
    instruction?: ProductionInstruction;
    shots: Array<{ title: string; prompt: string; instruction?: ProductionInstruction }>;
  }>;
}

export function parseEpisodeStructureArguments(
  value: string,
  requireDetailed = false,
): EpisodeStructure {
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
          'instruction',
        ].includes(key),
    );
    if (sceneUnknown)
      throw new Error(`Episode scene ${sceneIndex} has unsupported field: ${sceneUnknown}.`);
    const sceneTitle = normalizeTitle(typeof scene.title === 'string' ? scene.title : '');
    const sceneInstruction = parseInstruction(scene.instruction, 'scene');
    if (requireDetailed && sceneInstruction?.version !== 2)
      throw new Error(
        '新场次制作方案必须提供v2结构化指令：故事时间、地点、风格、叙事目的及每镜剧情预计时长。',
      );
    if (scene.videoPrompt === undefined && sceneInstruction)
      scene.videoPrompt = renderProductionInstruction(sceneInstruction);
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
      const shotUnknown = Object.keys(shot).find(
        (key) => !['title', 'prompt', 'instruction'].includes(key),
      );
      if (shotUnknown)
        throw new Error(
          `Episode shot ${sceneIndex}:${shotIndex} has unsupported field: ${shotUnknown}.`,
        );
      const shotTitle = normalizeTitle(typeof shot.title === 'string' ? shot.title : '');
      const shotInstruction = parseInstruction(shot.instruction, 'shot');
      if (requireDetailed && shotInstruction?.version !== 2)
        throw new Error('每个新分镜必须提供v2结构化指令和依据剧情推导的预计时长。');
      if (sceneInstruction?.version === 2 && !shotInstruction)
        throw new Error('详细场次的每个分镜都必须提供结构化指令和剧情预计时长。');
      if (shot.prompt === undefined && shotInstruction)
        shot.prompt = renderProductionInstruction(shotInstruction);
      if (typeof shot.prompt !== 'string' || !shot.prompt.trim() || shot.prompt.length > 20000) {
        throw new Error(
          `Episode shot ${sceneIndex}:${shotIndex} prompt must be between 1 and 20000 characters.`,
        );
      }
      shots.push({
        title: shotTitle,
        prompt: shot.prompt.trim(),
        ...(shotInstruction ? { instruction: shotInstruction } : {}),
      });
    }
    scenes.push({
      title: sceneTitle,
      shots,
      ...(sceneInstruction ? { instruction: sceneInstruction } : {}),
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

function parseInstruction(value: unknown, kind: string): ProductionInstruction | undefined {
  if (value === undefined) return undefined;
  const instruction = value as ProductionInstruction;
  const issues = inspectProductionTargetInstruction(instruction, kind);
  if (issues.length) throw new Error(issues.map((issue) => issue.message).join('\n'));
  return instruction;
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
