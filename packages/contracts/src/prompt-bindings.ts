/** The only IR: explicit relationships between prompts in one project. */
export interface PromptBindingIR<Reference = string> {
  schemaVersion: 1;
  characterDocumentIds?: Reference[];
  sceneDocumentIds?: Reference[];
  propDocumentIds?: Reference[];
  voiceDocumentId?: Reference;
  voiceBindings?: Array<{ characterDocumentId?: Reference; voiceDocumentId: Reference }>;
}

/** Ordinary production metadata, independent of text and bindings. */
export interface ProductionTiming {
  estimatedDurationSeconds: number;
  locked?: boolean;
}

/** A write/read payload; prompt text is never serialized into an IR. */
export interface PromptRecord {
  prompt: string;
  bindings?: PromptBindingIR;
  timing?: ProductionTiming;
}

const id = { type: 'string', minLength: 1, maxLength: 200 };
export const promptBindingSchemaFor = (reference: unknown = id) => ({
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion'],
  properties: {
    schemaVersion: { const: 1 },
    ...Object.fromEntries(
      ['characterDocumentIds', 'sceneDocumentIds', 'propDocumentIds'].map((key) => [
        key,
        { type: 'array', maxItems: 100, uniqueItems: true, items: reference },
      ]),
    ),
    voiceDocumentId: reference,
    voiceBindings: {
      type: 'array',
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['voiceDocumentId'],
        properties: { characterDocumentId: reference, voiceDocumentId: reference },
      },
    },
  },
});
export const promptBindingSchema = promptBindingSchemaFor();

export const productionTimingSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['estimatedDurationSeconds'],
  properties: {
    estimatedDurationSeconds: { type: 'number', exclusiveMinimum: 0, maximum: 3600 },
    locked: { type: 'boolean' },
  },
};

function object(value: unknown, keys: string[], label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error(`${label} must be an object.`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key)))
    throw new Error(`${label} contains unsupported fields.`);
  return result;
}

function requireId(value: unknown): void {
  if (typeof value !== 'string' || !value.trim() || value.length > 200)
    throw new Error('Bindings require explicit project IDs.');
}

export function validatePromptBindings<Reference = string>(
  value: unknown,
  validateReference: (value: unknown) => void = requireId,
): PromptBindingIR<Reference> {
  const result = object(value, Object.keys(promptBindingSchema.properties), 'bindings');
  if (result.schemaVersion !== 1) throw new Error('bindings.schemaVersion must be 1.');
  for (const key of ['characterDocumentIds', 'sceneDocumentIds', 'propDocumentIds']) {
    const values = result[key];
    if (values === undefined) continue;
    if (
      !Array.isArray(values) ||
      values.length > 100 ||
      new Set(values.map((v: unknown) => JSON.stringify(v))).size !== values.length
    )
      throw new Error(`bindings.${key} must contain at most 100 unique IDs.`);
    values.forEach(validateReference);
  }
  if (result.voiceDocumentId !== undefined) validateReference(result.voiceDocumentId);
  if (result.voiceBindings !== undefined) {
    if (!Array.isArray(result.voiceBindings) || result.voiceBindings.length > 100)
      throw new Error('bindings.voiceBindings must contain at most 100 relations.');
    const pairs = new Set<string>();
    for (const raw of result.voiceBindings) {
      const pair = object(raw, ['characterDocumentId', 'voiceDocumentId'], 'voice binding');
      validateReference(pair.voiceDocumentId);
      if (pair.characterDocumentId !== undefined) validateReference(pair.characterDocumentId);
      const key = JSON.stringify([pair.characterDocumentId ?? null, pair.voiceDocumentId]);
      if (pairs.has(key)) throw new Error('Duplicate voice binding.');
      pairs.add(key);
    }
  }
  return structuredClone(value) as PromptBindingIR<Reference>;
}

export function validateProductionTiming(value: unknown): ProductionTiming {
  const result = object(value, ['estimatedDurationSeconds', 'locked'], 'timing');
  if (
    typeof result.estimatedDurationSeconds !== 'number' ||
    !Number.isFinite(result.estimatedDurationSeconds) ||
    result.estimatedDurationSeconds <= 0 ||
    result.estimatedDurationSeconds > 3600 ||
    (result.locked !== undefined && typeof result.locked !== 'boolean')
  )
    throw new Error('Duration must be greater than 0 and at most 3600 seconds.');
  return structuredClone(value) as ProductionTiming;
}

export function validatePromptRecord(value: unknown): PromptRecord {
  const result = object(value, ['prompt', 'bindings', 'timing'], 'prompt record');
  if (typeof result.prompt !== 'string' || !result.prompt.trim() || result.prompt.length > 20000)
    throw new Error('prompt must contain between 1 and 20000 characters.');
  if (result.bindings !== undefined) validatePromptBindings(result.bindings);
  if (result.timing !== undefined) validateProductionTiming(result.timing);
  return structuredClone(value) as PromptRecord;
}
