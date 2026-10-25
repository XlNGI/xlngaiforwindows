/** JSON payload used by versioned project content and Agent-authored production IR. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type ProjectContentIRKind = 'character' | 'scene' | 'prop';

/** Open-ended on purpose: the Agent chooses useful fields from the source. */
export interface ProjectContentIR {
  schemaVersion: 1;
  kind: ProjectContentIRKind;
  data: JsonObject;
}

export type CharacterContentIR = ProjectContentIR & { kind: 'character' };
export type SceneContentIR = ProjectContentIR & { kind: 'scene' };
export type PropContentIR = ProjectContentIR & { kind: 'prop' };

export interface ProductionIRReferences {
  /** Actual cast in this scope, including brief/background appearances; [] explicitly clears it. */
  characterDocumentIds?: string[];
  /** Reusable location/environment documents, distinct from story scenes and props. */
  sceneDocumentIds?: string[];
  /** Independent object documents only; [] is valid when no props are needed. */
  propDocumentIds?: string[];
}

export interface ProductionTiming {
  estimatedDurationSeconds: number;
  rationale: string;
}

export const productionTimingSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['estimatedDurationSeconds', 'rationale'],
  properties: {
    estimatedDurationSeconds: { type: 'number', exclusiveMinimum: 0, maximum: 3600 },
    rationale: { type: 'string', minLength: 1, maxLength: 2000 },
  },
};

export function validateProductionTiming(value: unknown): ProductionTiming {
  const timing = record(value, 'timing');
  exactKeys(timing, ['estimatedDurationSeconds', 'rationale'], 'timing');
  if (
    typeof timing.estimatedDurationSeconds !== 'number' ||
    !Number.isFinite(timing.estimatedDurationSeconds) ||
    timing.estimatedDurationSeconds <= 0 ||
    timing.estimatedDurationSeconds > 3600
  )
    throw new Error('timing.estimatedDurationSeconds must be greater than 0 and at most 3600.');
  if (
    typeof timing.rationale !== 'string' ||
    !timing.rationale.trim() ||
    timing.rationale.length > 2000
  )
    throw new Error('timing.rationale must contain between 1 and 2000 characters.');
  return { estimatedDurationSeconds: timing.estimatedDurationSeconds, rationale: timing.rationale };
}

/** Agent-authored prompt and optional descriptive fields, stored with the target. */
export interface ProductionAuthoringIR {
  schemaVersion: 1;
  kind: 'scene' | 'shot';
  prompt: string;
  references?: ProductionIRReferences;
  timing?: ProductionTiming;
  data?: JsonObject;
}

export type ProductionSceneAuthoringIR = ProductionAuthoringIR & { kind: 'scene' };
export type ProductionShotAuthoringIR = ProductionAuthoringIR & { kind: 'shot' };

const MAX_IR_BYTES = 32 * 1024;
const MAX_IR_DEPTH = 24;
const MAX_IR_NODES = 8_000;
const MAX_REFERENCE_IDS = 100;

export function validateProjectContentIR(
  value: unknown,
  expectedKind?: ProjectContentIRKind,
): ProjectContentIR {
  const object = record(value, 'contentIR');
  exactKeys(object, ['schemaVersion', 'kind', 'data'], 'contentIR');
  if (object.schemaVersion !== 1) throw new Error('contentIR.schemaVersion must be 1.');
  if (!['character', 'scene', 'prop'].includes(String(object.kind)))
    throw new Error('contentIR.kind must be character, scene or prop.');
  if (expectedKind && object.kind !== expectedKind)
    throw new Error(`contentIR.kind must match document kind "${expectedKind}".`);
  const data = record(object.data, 'contentIR.data') as JsonObject;
  assertJson(data, 'contentIR.data');
  assertSize(value, 'contentIR');
  return structuredClone(value) as ProjectContentIR;
}

export function validateProductionAuthoringIR(
  value: unknown,
  expectedKind?: ProductionAuthoringIR['kind'],
): ProductionAuthoringIR {
  const object = record(value, 'authoringIR');
  exactKeys(
    object,
    ['schemaVersion', 'kind', 'prompt', 'references', 'timing', 'data'],
    'authoringIR',
  );
  if (object.schemaVersion !== 1) throw new Error('authoringIR.schemaVersion must be 1.');
  if (object.kind !== 'scene' && object.kind !== 'shot')
    throw new Error('authoringIR.kind must be scene or shot.');
  if (expectedKind && object.kind !== expectedKind)
    throw new Error(`authoringIR.kind must be "${expectedKind}".`);
  if (typeof object.prompt !== 'string' || !object.prompt.trim() || object.prompt.length > 20_000)
    throw new Error('authoringIR.prompt must contain between 1 and 20000 characters.');
  if (object.references !== undefined) {
    const references = record(object.references, 'authoringIR.references');
    exactKeys(
      references,
      ['characterDocumentIds', 'sceneDocumentIds', 'propDocumentIds'],
      'authoringIR.references',
    );
    for (const key of ['characterDocumentIds', 'sceneDocumentIds', 'propDocumentIds'] as const) {
      const ids = references[key];
      if (ids === undefined) continue;
      if (
        !Array.isArray(ids) ||
        ids.length > MAX_REFERENCE_IDS ||
        ids.some((id) => typeof id !== 'string' || !id.trim() || id.length > 200) ||
        new Set(ids).size !== ids.length
      )
        throw new Error(`authoringIR.references.${key} must contain unique project IDs.`);
    }
  }
  if (object.data !== undefined) {
    const data = record(object.data, 'authoringIR.data');
    assertJson(data, 'authoringIR.data');
  }
  if (object.timing !== undefined) validateProductionTiming(object.timing);
  assertSize(value, 'authoringIR');
  return structuredClone(value) as ProductionAuthoringIR;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactKeys(object: Record<string, unknown>, keys: string[], label: string): void {
  const allowed = new Set(keys);
  const extra = Object.keys(object).find((key) => !allowed.has(key));
  if (extra) throw new Error(`${label} contains unsupported field "${extra}".`);
}

function assertJson(value: unknown, label: string): asserts value is JsonValue {
  let nodes = 0;
  const visit = (entry: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > MAX_IR_NODES || depth > MAX_IR_DEPTH)
      throw new Error(`${label} exceeds JSON complexity limits.`);
    if (
      entry === null ||
      typeof entry === 'string' ||
      typeof entry === 'boolean' ||
      (typeof entry === 'number' && Number.isFinite(entry))
    )
      return;
    if (Array.isArray(entry)) {
      for (const child of entry) visit(child, depth + 1);
      return;
    }
    if (!entry || typeof entry !== 'object' || Object.getPrototypeOf(entry) !== Object.prototype)
      throw new Error(`${label} must contain only JSON values.`);
    for (const [key, child] of Object.entries(entry)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key))
        throw new Error(`${label} contains a reserved JSON key.`);
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
}

function assertSize(value: unknown, label: string): void {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_IR_BYTES)
    throw new Error(`${label} exceeds ${MAX_IR_BYTES} bytes.`);
}
