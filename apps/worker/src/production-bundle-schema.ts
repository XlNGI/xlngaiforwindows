import {
  productionTimingSchema,
  PROMPT_PURPOSES,
  promptBindingSchemaFor,
  type ProductionBundlePart,
} from '@ai-video/contracts';

export const BUNDLE_PROMPT_READ_VIEW = 'ordinary-prompt-text-v1';
export const BUNDLE_SOURCE_READ_VIEW = 'ordinary-source-text-v1';
export const MAX_BUNDLE_PROMPTS_PER_SUBMISSION = 12;

/** The same explicit public shape is used for authoring and candidate readback. */
export function bundlePromptView(
  item:
    | ProductionBundlePart['documents'][number]
    | ProductionBundlePart['scenes'][number]
    | ProductionBundlePart['shots'][number],
  storageKind: 'document' | 'scene' | 'shot',
) {
  if (storageKind === 'document') {
    const { contentMarkdown, kind, ...fields } = item as ProductionBundlePart['documents'][number];
    return { ...fields, kind: kind === 'scene' ? 'location' : kind, prompt: contentMarkdown };
  }
  return { ...item, kind: storageKind };
}
/** Navigation contains identity metadata only, never unread prompt text. */
export function bundlePromptIdentity(
  item: Parameters<typeof bundlePromptView>[0],
  storageKind: Parameters<typeof bundlePromptView>[1],
) {
  const view = bundlePromptView(item, storageKind);
  return {
    localKey: view.localKey,
    kind: view.kind,
    title: view.title,
    ...('sceneKey' in view ? { sceneKey: view.sceneKey } : {}),
  };
}
/** Display metadata separately so prompt quotes/newlines are not JSON encoded twice. */
export function bundlePromptReadText(
  item: Parameters<typeof bundlePromptView>[0],
  storageKind: Parameters<typeof bundlePromptView>[1],
) {
  const view = bundlePromptView(item, storageKind);
  const metadata = Object.fromEntries(Object.entries(view).filter(([key]) => key !== 'prompt'));
  const prompt = 'prompt' in view ? view.prompt : undefined;
  return `${JSON.stringify(metadata, null, 2)}\n\nprompt:\n${prompt ?? ''}`;
}
const text = (maxLength = 200) => ({ type: 'string', minLength: 1, maxLength });
const array = (items: unknown, maxItems = 1000) => ({ type: 'array', maxItems, items });
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});
const ref = { oneOf: [object({ localKey: text() }), object({ existingId: text() })] };
const existing = {
  ...object({ id: text(), rowVersion: { type: 'integer', minimum: 0 }, versionId: text() }, [
    'id',
    'rowVersion',
  ]),
  description:
    'Only for editing an actual saved business record with its read ID/CAS. Omit for new objects and candidate repairs. Replace a candidate using its original localKey and the bundle expectedRevision; candidate IDs and hashes are never business IDs or row versions.',
};
const bindings = promptBindingSchemaFor(ref);
const document = object(
  {
    localKey: text(),
    kind: { enum: ['character', 'scene', 'prop', 'voice', 'plan'] },
    title: text(),
    contentMarkdown: text(1000000),
    sampleText: text(10000),
    bindings,
    existing,
  },
  ['localKey', 'kind', 'title', 'contentMarkdown'],
);
const scene = object(
  {
    localKey: text(),
    title: text(),
    prompt: text(20000),
    timing: productionTimingSchema,
    bindings,
    existing,
  },
  ['localKey', 'title'],
);
const shot = object(
  {
    localKey: text(),
    sceneKey: text(),
    title: text(),
    prompt: text(20000),
    timing: productionTimingSchema,
    bindings: {
      ...bindings,
      required: ['schemaVersion', 'characterDocumentIds', 'sceneDocumentIds', 'propDocumentIds'],
    },
    existing,
  },
  ['localKey', 'sceneKey', 'title', 'prompt', 'bindings'],
);
export const PRODUCTION_BUNDLE_SUBMIT_SCHEMA = object(
  {
    partKey: text(),
    expectedRevision: { type: 'integer', minimum: 0 },
    prompts: {
      ...array(
        {
          ...object(
            {
              localKey: text(),
              kind: {
                enum: [
                  'character',
                  'location',
                  'prop',
                  'voice',
                  'plan',
                  'scene',
                  'shot',
                  'shot-image',
                ],
              },
              title: text(),
              prompt: text(1000000),
              imagePurpose: {
                enum: ['composition', 'first-frame', 'last-frame'],
                description:
                  'Only kind=shot-image. Uses the existing video shot localKey; adds independent static text after the video stage.',
              },
              intent: { type: 'string', maxLength: 4000 },
              imageRowVersion: { type: 'integer', minimum: 0 },
              sourceToken: text(64),
              sampleText: text(10000),
              sceneKey: {
                ...text(),
                description:
                  'Required only for kind=shot; points to the scene localKey. Omit for every other kind.',
              },
              timing: productionTimingSchema,
              bindings: {
                ...bindings,
                description:
                  'Mandatory for every shot: schemaVersion=1 and explicit characterDocumentIds, sceneDocumentIds and propDocumentIds arrays. sceneDocumentIds references location image documents, never story scenes; sceneKey separately establishes story-scene membership. Bind actual references with {localKey} or {existingId}; use [] only for a category absent from this shot. voiceBindings pairs a voice with its own speaker; offscreen voices omit characterDocumentId. Prompt prose does not create bindings.',
              },
              existing,
            },
            ['localKey', 'kind', 'title', 'prompt'],
          ),
          allOf: [
            {
              if: { properties: { kind: { const: 'shot-image' } } },
              then: {
                required: ['imagePurpose', 'intent', 'bindings'],
                properties: { timing: false, existing: false },
              },
              else: {
                properties: {
                  imagePurpose: false,
                  intent: false,
                  imageRowVersion: false,
                  sourceToken: false,
                },
              },
            },
            {
              if: { properties: { kind: { const: 'shot' } } },
              then: {
                required: ['sceneKey', 'bindings'],
                properties: {
                  bindings: {
                    required: [
                      'schemaVersion',
                      'characterDocumentIds',
                      'sceneDocumentIds',
                      'propDocumentIds',
                    ],
                  },
                },
              },
              else: { properties: { sceneKey: false } },
            },
            {
              if: { properties: { kind: { enum: ['scene', 'shot', 'shot-image'] } } },
              then: { properties: { prompt: text(20000) } },
              else: { properties: { timing: false } },
            },
            {
              if: { properties: { kind: { const: 'voice' } } },
              else: { properties: { sampleText: false } },
            },
          ],
        },
        MAX_BUNDLE_PROMPTS_PER_SUBMISSION,
      ),
      description:
        'At most 12 prompt objects per model call. Submit larger packages in ordered chunks with distinct partKey values and the current expectedRevision; omit complete on non-final chunks; set complete=true only after all requested purposes, including optional shot-image, have been submitted.',
    },
    complete: {
      type: 'boolean',
      const: true,
      description:
        'Seal and atomically save the entire candidate set after every requested prompt object, including independent shot-image text when requested, has been submitted. If shot-image is required, omit complete during the video stage and set it only on the final image submission. Omit instead of passing false.',
    },
  },
  ['partKey', 'expectedRevision'],
);
const properties = {
  operation: {
    description:
      'check reads bounded status lists with offset only; expectedRevision is a write CAS and is not accepted by check. Follow nextOffset until all lists are read.',
    enum: [
      'begin',
      'purpose',
      'rebase',
      'put',
      'seal',
      'source',
      'read',
      'read_many',
      'state',
      'check',
      'commit',
      'readback',
      'saved',
    ],
  },
  purpose: {
    enum: PROMPT_PURPOSES,
    description:
      'Declare the authoring purpose before writing; only its frozen template is supplied next turn.',
  },
  expectedStageVersion: { type: 'integer', minimum: 0 },
  stageKey: text(),
  estimatedOutputTokens: { type: 'integer', minimum: 1 },
  reused: array(object({ documentId: text(), versionId: text() }), 50),
  expectedRevision: { type: 'integer', minimum: 0 },
  partKey: text(),
  part: object({ documents: array(document), scenes: array(scene), shots: array(shot) }),
  manifest: object({
    documentKeys: array(text()),
    sceneKeys: array(text()),
    shotKeys: array(text()),
  }),
  documentId: text(),
  localKey: text(),
  expectedHash: text(64),
  items: {
    ...array(
      object({ localKey: text(), offset: { type: 'integer', minimum: 0 } }, ['localKey']),
      20,
    ),
    minItems: 1,
  },
  offset: { type: 'integer', minimum: 0 },
  limit: { type: 'integer', minimum: 1, maximum: 10000 },
};
export const BUNDLE_OPERATION_FIELDS: Record<
  string,
  {
    required: string[];
    optional: string[];
  }
> = {
  purpose: { required: ['purpose', 'expectedStageVersion', 'stageKey'], optional: [] },
  begin: { required: ['estimatedOutputTokens'], optional: ['reused'] },
  rebase: { required: ['expectedRevision'], optional: ['reused'] },
  put: { required: ['expectedRevision', 'partKey', 'part'], optional: [] },
  seal: { required: ['expectedRevision', 'manifest'], optional: [] },
  source: { required: ['documentId'], optional: ['offset', 'limit'] },
  read: { required: ['localKey'], optional: ['expectedHash', 'offset', 'limit'] },
  read_many: { required: ['expectedRevision', 'items'], optional: ['limit'] },
  state: { required: [], optional: ['offset'] },
  check: { required: [], optional: ['offset'] },
  commit: { required: ['expectedRevision'], optional: [] },
  readback: { required: [], optional: [] },
  saved: { required: [], optional: ['offset'] },
};
export const PRODUCTION_BUNDLE_SCHEMA = {
  ...object(properties, ['operation']),
  anyOf: Object.entries(BUNDLE_OPERATION_FIELDS).map(([operation, fields]) =>
    object(
      {
        operation: { const: operation },
        ...Object.fromEntries([...fields.required, ...fields.optional].map((k) => [k, {}])),
      },
      ['operation', ...fields.required],
    ),
  ),
};
export const PRODUCTION_BUNDLE_CONTROL_SCHEMA = {
  ...object(
    Object.fromEntries(
      Object.entries(properties).filter(([key]) => !['partKey', 'part', 'manifest'].includes(key)),
    ),
    ['operation'],
  ),
  properties: {
    ...Object.fromEntries(
      Object.entries(properties).filter(([key]) => !['partKey', 'part', 'manifest'].includes(key)),
    ),
    operation: { enum: properties.operation.enum.filter((op) => !['put', 'seal'].includes(op)) },
  },
  anyOf: PRODUCTION_BUNDLE_SCHEMA.anyOf.filter(
    (_branch, index) => !['put', 'seal'].includes(Object.keys(BUNDLE_OPERATION_FIELDS)[index]!),
  ),
};
export function validateBundleOperation(args: Record<string, unknown>) {
  const branch = BUNDLE_OPERATION_FIELDS[String(args.operation)];
  if (
    !branch ||
    Object.keys(args).some(
      (k) => k !== 'operation' && ![...branch.required, ...branch.optional].includes(k),
    ) ||
    branch.required.some((k) => args[k] === undefined)
  )
    throw new Error('BUNDLE_ARGUMENTS_INVALID: Use only fields for the selected operation.');
}
