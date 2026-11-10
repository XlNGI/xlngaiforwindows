import type Database from 'better-sqlite3';
import {
  validatePromptBindings,
  validateProductionTiming,
  type PromptBindingIR,
  type ProductionTiming,
} from '@ai-video/contracts';
import { validatePromptBindingReferences } from './prompt-binding-validation.js';

export interface EpisodeStructure {
  episodeTitle: string;
  scenes: Array<{
    title: string;
    sceneId?: string;
    expectedRowVersion?: number;
    prompt?: string;
    bindings?: PromptBindingIR;
    timing?: ProductionTiming;
    shots: Array<{
      title: string;
      prompt: string;
      bindings?: PromptBindingIR;
      timing?: ProductionTiming;
    }>;
  }>;
}
function record(value: unknown, fields: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  const result = value as Record<string, unknown>;
  const extra = Object.keys(result).find((key) => !fields.includes(key));
  if (extra) throw new Error(`${label} has unsupported field: ${extra}.`);
  return result;
}
function title(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200)
    throw new Error('Agent document title is invalid.');
  return value.normalize('NFC').trim();
}
function content(value: unknown, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value.trim() || value.length > 20000)
    throw new Error('prompt requires 1–20000 characters.');
  return value;
}
export function parseEpisodeStructureArguments(value: string): EpisodeStructure {
  const input = record(JSON.parse(value), ['episodeTitle', 'scenes'], 'Episode structure');
  if (!Array.isArray(input.scenes) || !input.scenes.length || input.scenes.length > 20)
    throw new Error('Episode structure scenes must contain between one and 20 items.');
  const scenes: EpisodeStructure['scenes'] = input.scenes.map((raw, index) => {
    const scene = record(
      raw,
      ['title', 'sceneId', 'expectedRowVersion', 'prompt', 'bindings', 'timing', 'shots'],
      `Episode scene ${index}`,
    );
    if (
      scene.sceneId !== undefined &&
      (typeof scene.sceneId !== 'string' ||
        !scene.sceneId.trim() ||
        scene.sceneId.length > 200 ||
        !Number.isSafeInteger(scene.expectedRowVersion) ||
        Number(scene.expectedRowVersion) < 0)
    )
      throw new Error('Scene updates require sceneId and expectedRowVersion.');
    if (scene.sceneId === undefined && scene.expectedRowVersion !== undefined)
      throw new Error('New scenes cannot include expectedRowVersion.');
    if (
      !Array.isArray(scene.shots) ||
      scene.shots.length > 30 ||
      (scene.sceneId ? scene.shots.length !== 0 : scene.shots.length < 1)
    )
      throw new Error(
        scene.sceneId
          ? 'Existing scenes must use shots: []; update existing shots using their IDs and CAS.'
          : 'New scenes require between one and 30 shots.',
      );
    const prompt = content(scene.prompt, false);
    return {
      title: title(scene.title),
      ...(scene.sceneId
        ? { sceneId: scene.sceneId, expectedRowVersion: scene.expectedRowVersion as number }
        : {}),
      ...(prompt !== undefined ? { prompt } : {}),
      ...(scene.bindings !== undefined ? { bindings: validatePromptBindings(scene.bindings) } : {}),
      ...(scene.timing !== undefined ? { timing: validateProductionTiming(scene.timing) } : {}),
      shots: scene.shots.map((rawShot, shotIndex) => {
        const shot = record(
          rawShot,
          ['title', 'prompt', 'bindings', 'timing'],
          `Episode shot ${index}:${shotIndex}`,
        );
        return {
          title: title(shot.title),
          prompt: content(shot.prompt, true)!,
          ...(shot.bindings !== undefined
            ? { bindings: validatePromptBindings(shot.bindings) }
            : {}),
          ...(shot.timing !== undefined ? { timing: validateProductionTiming(shot.timing) } : {}),
        };
      }),
    };
  });
  if (scenes.reduce((sum, scene) => sum + 1 + scene.shots.length, 0) > 100)
    throw new Error('Split proposals exceeding 100 scene + shot items.');
  return { episodeTitle: title(input.episodeTitle), scenes };
}
export function validateEpisodeReferences(
  database: Database.Database,
  projectId: string,
  structure: EpisodeStructure,
): void {
  for (const scene of structure.scenes) {
    if (scene.sceneId) {
      const current = database
        .prepare(
          'SELECT row_version FROM scenes WHERE id=? AND project_id=? AND archived_at IS NULL',
        )
        .get(scene.sceneId, projectId) as { row_version: number } | undefined;
      if (!current || current.row_version !== scene.expectedRowVersion)
        throw new Error('SCENE_ROW_VERSION_CONFLICT');
    }
    if (scene.bindings) validatePromptBindingReferences(database, projectId, scene.bindings);
    for (const shot of scene.shots)
      if (shot.bindings) validatePromptBindingReferences(database, projectId, shot.bindings);
  }
}
