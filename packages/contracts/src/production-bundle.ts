import {
  validatePromptBindings,
  validateProductionTiming,
  type PromptBindingIR,
  type ProductionTiming,
} from './prompt-bindings.js';

export const PRODUCTION_WORKFLOW_VERSION = 2 as const;
export const PRODUCTION_BUNDLE_LIMITS = {
  partBytes: 256 * 1024,
  bundleBytes: 8 * 1024 * 1024,
  objects: 1000,
  parts: 128,
  repeatedErrors: 3,
  taskTurns: 128,
  taskElapsedMs: 60 * 60 * 1000,
  taskOutputTokens: 256000,
} as const;
export type ProductionBundleRef = { localKey: string } | { existingId: string };
export interface ProductionBundleSource {
  documentId: string;
  versionId: string;
}
export interface ProductionBundleTarget {
  id: string;
  rowVersion: number;
  versionId?: string;
}
export interface ProductionBundleDocument {
  localKey: string;
  kind: 'character' | 'scene' | 'prop' | 'voice' | 'plan';
  title: string;
  contentMarkdown: string;
  sampleText?: string;
  bindings?: PromptBindingIR<ProductionBundleRef>;
  existing?: ProductionBundleTarget;
}
export interface ProductionBundleScene {
  localKey: string;
  title: string;
  prompt?: string;
  timing?: ProductionTiming;
  bindings?: PromptBindingIR<ProductionBundleRef>;
  existing?: ProductionBundleTarget;
}
export interface ProductionBundleShot {
  localKey: string;
  sceneKey: string;
  title: string;
  prompt: string;
  timing?: ProductionTiming;
  bindings: PromptBindingIR<ProductionBundleRef>;
  existing?: ProductionBundleTarget;
}
export interface ProductionBundlePart {
  documents: ProductionBundleDocument[];
  scenes: ProductionBundleScene[];
  shots: ProductionBundleShot[];
}
export interface ProductionBundleManifest {
  documentKeys: string[];
  sceneKeys: string[];
  shotKeys: string[];
}

export function validateProductionRequestedAt(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new Error('BUNDLE_INVALID: productionRequestedAt must be a canonical UTC timestamp.');
  return value;
}
export function productionWorkflowVersion(snapshot: {
  productionSkillId?: unknown;
  productionWorkflowVersion?: unknown;
}): 1 | 2 {
  return snapshot.productionSkillId === 'script-to-media' ? 2 : 1;
}
const object = (value: unknown, keys: string[], label: string): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error(`BUNDLE_INVALID: ${label} must be an object.`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key)))
    throw new Error(`BUNDLE_INVALID: ${label} has unsupported fields.`);
  return result;
};
const text = (value: unknown, label: string, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`BUNDLE_INVALID: ${label} requires 1–${max} characters.`);
};
export function validateProductionBundleRef(value: unknown): ProductionBundleRef {
  const result = object(value, ['localKey', 'existingId'], 'reference');
  if (Object.keys(result).length !== 1)
    throw new Error('BUNDLE_INVALID: reference requires exactly one of localKey/existingId.');
  text(result.localKey ?? result.existingId, 'reference');
  return structuredClone(value) as ProductionBundleRef;
}
export function validateProductionBundleSources(value: unknown): ProductionBundleSource[] {
  if (!Array.isArray(value) || !value.length || value.length > 50)
    throw new Error('BUNDLE_INVALID: select 1–50 sources.');
  for (const raw of value) {
    const source = object(raw, ['documentId', 'versionId'], 'source');
    text(source.documentId, 'source.documentId');
    text(source.versionId, 'source.versionId');
  }
  if (new Set((value as ProductionBundleSource[]).map((s) => s.documentId)).size !== value.length)
    throw new Error('BUNDLE_INVALID: duplicate sources.');
  return structuredClone(value) as ProductionBundleSource[];
}
export function validateProductionBundlePart(value: unknown): ProductionBundlePart {
  const part = object(value, ['documents', 'scenes', 'shots'], 'part');
  const keys = new Set<string>();
  for (const collection of ['documents', 'scenes', 'shots'] as const) {
    const items = part[collection];
    if (!Array.isArray(items) || items.length > PRODUCTION_BUNDLE_LIMITS.objects)
      throw new Error(`BUNDLE_INVALID: ${collection} must be a bounded array.`);
    for (const [index, raw] of items.entries()) {
      const location = `part.${collection}[${index}]`;
      try {
        const item = object(
          raw,
          collection === 'documents'
            ? ['localKey', 'kind', 'title', 'contentMarkdown', 'sampleText', 'bindings', 'existing']
            : [
                'localKey',
                'title',
                'prompt',
                'timing',
                'bindings',
                'existing',
                ...(collection === 'shots' ? ['sceneKey'] : []),
              ],
          location,
        );
        text(item.localKey, 'localKey');
        text(item.title, 'title');
        if (item.title !== String(item.title).trim())
          throw new Error('BUNDLE_INVALID: title must not have surrounding whitespace.');
        if (keys.has(String(item.localKey)))
          throw new Error(`BUNDLE_DUPLICATE_KEY: ${String(item.localKey)}`);
        keys.add(String(item.localKey));
        if (item.existing !== undefined) {
          const target = object(item.existing, ['id', 'rowVersion', 'versionId'], 'existing');
          text(target.id, 'existing.id');
          if (String(target.id).startsWith('candidate:'))
            throw new Error(
              'BUNDLE_INVALID: existing.id must identify an actual saved business record. Omit existing when replacing a candidate; use its original localKey and bundle expectedRevision.',
            );
          if (!Number.isSafeInteger(target.rowVersion) || Number(target.rowVersion) < 0)
            throw new Error('BUNDLE_INVALID: existing.rowVersion required.');
          if (target.versionId !== undefined) text(target.versionId, 'existing.versionId');
        }
        if (collection === 'documents') {
          if (!['character', 'scene', 'prop', 'voice', 'plan'].includes(String(item.kind)))
            throw new Error('BUNDLE_INVALID: document kind.');
          text(item.contentMarkdown, 'contentMarkdown', 1000000);
          if (item.sampleText !== undefined) {
            if (item.kind !== 'voice')
              throw new Error('BUNDLE_INVALID: sampleText belongs to voice documents.');
            text(item.sampleText, 'sampleText', 10000);
          }
        } else {
          if (collection === 'shots' || item.prompt !== undefined)
            text(item.prompt, 'prompt', 20000);
          if (item.timing !== undefined) validateProductionTiming(item.timing);
          if (collection === 'shots') text(item.sceneKey, 'sceneKey');
        }
        if (item.bindings !== undefined)
          validatePromptBindings(item.bindings, validateProductionBundleRef);
        if (collection === 'shots') {
          const bindings = item.bindings as PromptBindingIR<ProductionBundleRef> | undefined;
          for (const field of [
            'characterDocumentIds',
            'sceneDocumentIds',
            'propDocumentIds',
          ] as const)
            if (!Array.isArray(bindings?.[field]))
              throw new Error(`BUNDLE_INVALID: bindings.${field} required; use [] when empty.`);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const code = /\bBUNDLE_[A-Z_]+/.exec(reason)?.[0] ?? 'BUNDLE_INVALID';
        throw new Error(`${code}: ${location}: ${reason}`);
      }
    }
  }
  if (keys.size > PRODUCTION_BUNDLE_LIMITS.objects)
    throw new Error('BUNDLE_INVALID: too many objects.');
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength > PRODUCTION_BUNDLE_LIMITS.partBytes
  )
    throw new Error('BUNDLE_PART_TOO_LARGE: split by complete objects.');
  return structuredClone(value) as ProductionBundlePart;
}
export function validateProductionBundleManifest(value: unknown): ProductionBundleManifest {
  const manifest = object(value, ['documentKeys', 'sceneKeys', 'shotKeys'], 'manifest');
  const all: string[] = [];
  for (const key of ['documentKeys', 'sceneKeys', 'shotKeys']) {
    if (!Array.isArray(manifest[key]) || manifest[key].length > PRODUCTION_BUNDLE_LIMITS.objects)
      throw new Error(`BUNDLE_INVALID: ${key} must be an array.`);
    for (const entry of manifest[key]) text(entry, key);
    all.push(...(manifest[key] as string[]));
  }
  if (
    !(manifest.sceneKeys as string[]).length ||
    !(manifest.shotKeys as string[]).length ||
    all.length > PRODUCTION_BUNDLE_LIMITS.objects ||
    new Set(all).size !== all.length
  )
    throw new Error('BUNDLE_INVALID: manifest requires scenes, shots and unique bounded keys.');
  return structuredClone(value) as ProductionBundleManifest;
}
