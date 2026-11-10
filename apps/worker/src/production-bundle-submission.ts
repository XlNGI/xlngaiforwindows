import type Database from 'better-sqlite3';
import { AgentContextStore, contextContentHash } from '@ai-video/persistence';
import { PRODUCTION_BUNDLE_LIMITS, validateProductionBundlePart } from '@ai-video/contracts';
import {
  bundleSummary,
  bundleObjects,
  loadBundle,
  stageBundle,
} from './production-bundle-state.js';
import { MAX_BUNDLE_PROMPTS_PER_SUBMISSION } from './production-bundle-schema.js';
/** Explicit kinds select storage; prompt bytes and binding references are never inferred. */
export function projectBundleSubmission(args: Record<string, unknown>) {
  if (
    Object.keys(args).some(
      (k) => !['partKey', 'expectedRevision', 'prompts', 'complete'].includes(k),
    )
  )
    throw new Error('BUNDLE_SUBMIT_INVALID: unsupported field.');
  if (
    typeof args.partKey !== 'string' ||
    !args.partKey.trim() ||
    args.partKey.length > 200 ||
    !Number.isSafeInteger(args.expectedRevision) ||
    Number(args.expectedRevision) < 0
  )
    throw new Error(
      'BUNDLE_SUBMIT_INVALID: stable partKey and nonnegative expectedRevision required.',
    );
  if (Buffer.byteLength(JSON.stringify(args)) > PRODUCTION_BUNDLE_LIMITS.partBytes)
    throw new Error('BUNDLE_PART_TOO_LARGE');
  const prompts = args.prompts === undefined ? [] : args.prompts;
  if (!Array.isArray(prompts) || prompts.length > MAX_BUNDLE_PROMPTS_PER_SUBMISSION)
    throw new Error(
      `BUNDLE_SUBMIT_INVALID: prompts must contain at most ${MAX_BUNDLE_PROMPTS_PER_SUBMISSION} objects per submission; split larger packages into ordered parts.`,
    );
  const collections: Record<'documents' | 'scenes' | 'shots', unknown[]> = {
    documents: [],
    scenes: [],
    shots: [],
  };
  const locations: Record<keyof typeof collections, number[]> = {
    documents: [],
    scenes: [],
    shots: [],
  };
  for (const [index, raw] of prompts.entries()) {
    const fail = () => {
      throw new Error(
        `BUNDLE_SUBMIT_INVALID: prompts[${index}] requires explicit kind and ordinary prompt text; use location for a location image document, scene for a story scene, shot with sceneKey for a shot. sampleText belongs only to voice; timing only to scene/shot.`,
      );
    };
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail();
    const { kind, prompt, ...fields } = raw as Record<string, unknown>;
    const document = ['character', 'location', 'prop', 'voice', 'plan'].includes(String(kind));
    const allowed = [
      'localKey',
      'kind',
      'title',
      'prompt',
      'bindings',
      'existing',
      ...(kind === 'voice' ? ['sampleText'] : []),
      ...(!document ? ['timing'] : []),
      ...(kind === 'shot' ? ['sceneKey'] : []),
    ];
    if (
      (!document && kind !== 'scene' && kind !== 'shot') ||
      typeof prompt !== 'string' ||
      !prompt.trim() ||
      Object.keys(raw as Record<string, unknown>).some((key) => !allowed.includes(key))
    )
      fail();
    const collection = document ? 'documents' : kind === 'scene' ? 'scenes' : 'shots';
    locations[collection].push(index);
    collections[collection].push(
      document
        ? { ...fields, kind: kind === 'location' ? 'scene' : kind, contentMarkdown: prompt }
        : { ...fields, prompt },
    );
  }
  const part = (() => {
    try {
      return validateProductionBundlePart(collections);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      throw new Error(
        error.message.replace(
          /part\.(documents|scenes|shots)\[(\d+)\]/gu,
          (_match, collection: keyof typeof collections, index: string) =>
            `prompts[${locations[collection][Number(index)]}]`,
        ),
      );
    }
  })();
  if (
    !part.documents.length &&
    !part.scenes.length &&
    !part.shots.length &&
    args.complete === undefined
  )
    throw new Error('BUNDLE_SUBMIT_INVALID: submit prompt objects or complete=true.');
  if (args.complete !== undefined && args.complete !== true)
    throw new Error('BUNDLE_SUBMIT_INVALID: complete must be true.');
  const complete = args.complete === true;
  return { part, complete };
}
/** Called inside the existing bundle transaction; a failed seal rolls back the entire part. */
export function submitBundle(
  db: Database.Database,
  projectId: string,
  taskId: string,
  args: Record<string, unknown>,
  providerStepId?: string,
) {
  const { part, complete } = projectBundleSubmission(args);
  const store = new AgentContextStore(db),
    callId = `bundle-submit:${String(args.partKey)}`;
  const requestHash = contextContentHash(
    JSON.stringify(args, (_key, value: unknown) =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
        : value,
    ),
  );
  const prior = store.resultForCall(projectId, taskId, callId);
  if (prior) {
    const saved = JSON.parse(prior.content) as {
      requestHash: string;
      result: Record<string, unknown>;
    };
    if (saved.requestHash !== requestHash)
      throw new Error('BUNDLE_PART_CONFLICT: use a new partKey for changed arguments.');
    const state = loadBundle(db, projectId, taskId)!;
    return {
      ...bundleSummary(state, bundleObjects(db, projectId, taskId, state)),
      submittedRevision: saved.result.revision,
      replayed: true,
      currentRevision: loadBundle(db, projectId, taskId)?.revision,
    };
  }
  const previous = loadBundle(db, projectId, taskId);
  let result = stageBundle(
    db,
    projectId,
    taskId,
    { operation: 'put', partKey: args.partKey, expectedRevision: args.expectedRevision, part },
    providerStepId,
  );
  if (complete || (previous !== undefined && previous.sealedRevision === previous.revision)) {
    const state = loadBundle(db, projectId, taskId)!;
    const keys = (kind: string) => state.entries.filter((e) => e.kind === kind).map((e) => e.key);
    result = stageBundle(
      db,
      projectId,
      taskId,
      {
        operation: 'seal',
        expectedRevision: state.revision,
        manifest: {
          documentKeys: keys('document'),
          sceneKeys: keys('scene'),
          shotKeys: keys('shot'),
        },
      },
      providerStepId,
    );
  }
  store.putResult(
    projectId,
    taskId,
    callId,
    'production.bundle.submission',
    JSON.stringify({ requestHash, result }),
  );
  return result;
}
