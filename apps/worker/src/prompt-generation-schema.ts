import {
  PROMPT_PURPOSES,
  PRODUCTION_BUNDLE_LIMITS,
  promptPurposeForKind,
  type PromptPurpose,
} from '@ai-video/contracts';
import { PRODUCTION_BUNDLE_SUBMIT_SCHEMA } from './production-bundle-schema.js';

const sources = {
  type: 'array',
  minItems: 1,
  maxItems: 50,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['documentId', 'versionId'],
    properties: {
      documentId: { type: 'string', minLength: 1, maxLength: 200 },
      versionId: { type: 'string', minLength: 1, maxLength: 200 },
    },
  },
};
export const PROMPT_GENERATION_REQUEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sources', 'purposes'],
  properties: {
    sources,
    reused: sources,
    purposes: {
      description:
        'Requested prompt purposes. New shot-image prompts require video-prompt in the same request to create their parent scenes/shots; use the existing shot.image.save CAS tool for an image-only edit of a saved shot.',
      type: 'array',
      minItems: 1,
      maxItems: PROMPT_PURPOSES.length,
      uniqueItems: true,
      items: { type: 'string', enum: PROMPT_PURPOSES },
    },
    requirements: { type: 'string', maxLength: 20000 },
  },
};
const legacyPrompts = PRODUCTION_BUNDLE_SUBMIT_SCHEMA.properties.prompts as Record<
  string,
  unknown
> & { items: Record<string, unknown> };
export const PROMPT_GENERATION_SUBMIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['requestHash', 'prompts'],
  properties: {
    requestHash: { type: 'string', minLength: 64, maxLength: 64 },
    prompts: {
      ...legacyPrompts,
      minItems: 1,
      maxItems: PRODUCTION_BUNDLE_LIMITS.objects,
      items: {
        ...legacyPrompts.items,
        required: ['localKey', 'kind', 'title', 'prompt', 'bindings'],
      },
      description:
        'All requested complete ordinary prompt strings and explicit relationship IR in one response. The Worker partitions and saves them. Never return partKey, revision, complete or a content IR. location is a location document; scene is a story scene; shot.sceneKey names its parent scene. Optional shot-image uses its video shot localKey and title, with independent imagePurpose, intent and bindings.',
    },
  },
};

/** The provider sees only kinds authorized by this frozen request. */
export function promptGenerationSubmitSchema(purposes: PromptPurpose[], requestHash: string) {
  const schema = structuredClone(PROMPT_GENERATION_SUBMIT_SCHEMA);
  Object.assign(schema.properties.requestHash, { const: requestHash });
  const properties = (schema.properties.prompts.items as Record<string, unknown>)
    .properties as Record<string, Record<string, unknown>>;
  const kinds = properties.kind!.enum as string[];
  properties.kind!.enum = kinds.filter((kind) => {
    const purpose = promptPurposeForKind(kind);
    return purpose !== undefined && purposes.includes(purpose);
  });
  return schema;
}
