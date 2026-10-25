import type {
  AdapterParameters,
  ImageAssetKind,
  MediaModelSelectionDecision,
  MediaModelSelectionRequest,
  VideoAssetKind,
} from './index.js';
import type { DubbingCueSaveParams, VoiceProfileInfo } from './dubbing.js';

/** Ordered, explicit references. A dependency never pretends to be an existing asset. */
export type MediaReviewReference =
  { assetId: string } | { reviewFormId: string; resultIndex: number };
export interface MediaReviewDraft {
  key: string;
  label: string;
  kind: 'image' | 'video' | 'audio';
  prompt: string;
  parameters?: AdapterParameters;
  inputReferences?: MediaReviewReference[];
  shotId?: string;
  sceneId?: string;
  sourceDocumentId?: string;
  sourceVersionId?: string;
  assetKind?: ImageAssetKind | VideoAssetKind;
  audio?: DubbingCueSaveParams;
  expectedRowVersion?: number;
}
export interface MediaReviewForm {
  id: string;
  projectId: string;
  conversationId: string;
  taskId?: string;
  draft: MediaReviewDraft;
  status: 'pending' | 'submitting' | 'submitted' | 'cancelled';
  rowVersion: number;
  jobId?: string;
  blockers: string[];
  inputAssetIds: string[];
  selectionRequest?: MediaModelSelectionRequest;
  voices?: VoiceProfileInfo[];
  error?: string;
  reviewToken?: string;
  createdAt: string;
}
export interface MediaReviewSubmitParams {
  formId: string;
  expectedRowVersion: number;
  reviewToken: string;
  selection?: MediaModelSelectionDecision;
  audio?: DubbingCueSaveParams;
}
/** Queue navigation omits prompt bodies and model catalogs; get loads one editable form. */
export type MediaReviewSummary = Omit<
  MediaReviewForm,
  'draft' | 'selectionRequest' | 'voices' | 'reviewToken'
> & {
  draft: Pick<
    MediaReviewDraft,
    'key' | 'label' | 'kind' | 'shotId' | 'sceneId' | 'sourceDocumentId' | 'inputReferences'
  >;
};
export interface MediaReviewWorkerMethodMap {
  'media.review.list': { params: { conversationId?: string }; result: MediaReviewSummary[] };
  'media.review.get': { params: { formId: string }; result: MediaReviewForm };
  'media.review.submit': { params: MediaReviewSubmitParams; result: MediaReviewForm };
  'media.review.cancel': {
    params: { formId: string; expectedRowVersion: number };
    result: MediaReviewForm;
  };
}

export const MEDIA_REVIEW_DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'label', 'kind', 'prompt'],
  properties: {
    key: { type: 'string', minLength: 1, maxLength: 200 },
    label: { type: 'string', minLength: 1, maxLength: 200 },
    kind: { enum: ['image', 'video', 'audio'] },
    prompt: { type: 'string', minLength: 1, maxLength: 5000 },
    parameters: { type: 'object', maxProperties: 40, additionalProperties: true },
    inputReferences: {
      type: 'array',
      maxItems: 7,
      items: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['assetId'],
            properties: { assetId: { type: 'string', minLength: 1, maxLength: 200 } },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['reviewFormId', 'resultIndex'],
            properties: {
              reviewFormId: { type: 'string', minLength: 1, maxLength: 200 },
              resultIndex: { type: 'integer', minimum: 0, maximum: 19 },
            },
          },
        ],
      },
    },
    shotId: { type: 'string', minLength: 1, maxLength: 200 },
    sceneId: { type: 'string', minLength: 1, maxLength: 200 },
    sourceDocumentId: { type: 'string', minLength: 1, maxLength: 200 },
    sourceVersionId: { type: 'string', minLength: 1, maxLength: 200 },
    assetKind: {
      enum: [
        'character',
        'scene',
        'prop',
        'first-frame',
        'last-frame',
        'generated-image',
        'generated-video',
        'shot-video',
        'scene-video',
      ],
    },
    expectedRowVersion: { type: 'integer', minimum: 0 },
    audio: {
      type: 'object',
      additionalProperties: false,
      required: ['sceneId', 'speakerKind', 'text', 'position', 'startMs'],
      properties: {
        sceneId: { type: 'string', minLength: 1, maxLength: 200 },
        shotId: { type: 'string', minLength: 1, maxLength: 200 },
        speakerKind: { enum: ['character', 'narration'] },
        characterDocumentId: { type: 'string', minLength: 1, maxLength: 200 },
        voiceProfileId: { type: 'string', minLength: 1, maxLength: 200 },
        text: { type: 'string', minLength: 1, maxLength: 4000 },
        position: { type: 'integer', minimum: 0 },
        startMs: { type: 'integer', minimum: 0, maximum: 600000 },
        emotion: { enum: ['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm'] },
        trailingPauseMs: { type: 'integer', minimum: 0, maximum: 60000 },
      },
    },
  },
} as const;
