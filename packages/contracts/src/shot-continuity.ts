import type { AssetInfo, LlmGenerationPrepareResult, ShotInfo } from './index.js';
/** continue/reframe are retained for existing project bindings. */
export type ShotContinuityMode = 'reference' | 'continue' | 'reframe';
export type ShotContinuityPromptKind = 'image' | 'video';
export interface ShotContinuityFrame {
  assetId: string;
  timeMs: number;
  sourceVideoAssetId?: string;
}
export interface ShotContinuitySource {
  assetId: string;
  contentHash: string;
}
export interface ShotContinuityBinding {
  /** Missing on legacy bindings, whose source follows the previous shot. */
  selectionVersion?: 2;
  sourceShotId?: string;
  sourceVideoAssetId?: string;
  sourceVideoHash?: string;
  sourceVideos?: ShotContinuitySource[];
  sourceImages?: ShotContinuitySource[];
  targetRowVersion: number;
  mode: ShotContinuityMode;
  notes: string;
  frames: ShotContinuityFrame[];
  anchorAssetId: string;
  firstFrameAssetId?: string;
  referenceAssetId?: string;
  referenceAssetIds?: string[];
  referenceRole?: 'reference' | 'first-frame';
  imagePrompt?: string;
  /** Read projection of the current shot authoring IR, never a second stored video prompt. */
  prompt?: string;
}
/** Stable, ordered projections shared by the UI, Agent and production compiler. */
export function continuitySourceImageIds(binding: ShotContinuityBinding): string[] {
  return [
    ...new Set([
      ...binding.frames.map((frame) => frame.assetId),
      ...(binding.sourceImages ?? []).map((image) => image.assetId),
    ]),
  ];
}
export function continuityReferenceImageIds(binding: ShotContinuityBinding): string[] {
  return (
    binding.referenceAssetIds ??
    (binding.referenceAssetId && binding.referenceRole !== 'first-frame'
      ? [binding.referenceAssetId]
      : [])
  );
}
export interface ShotContinuityState {
  shotId: string;
  rowVersion: number;
  binding?: ShotContinuityBinding;
}
export interface ShotContinuityContext extends ShotContinuityState {
  currentShotRowVersion?: number;
  previousShot?: ShotInfo;
  videos: AssetInfo[];
  images: AssetInfo[];
  stale: boolean;
  /** Only the target shot changed; the saved selection can be explicitly accepted again. */
  reconfirmable?: boolean;
}
export interface ShotContinuityPreviewParams {
  shotId: string;
  videoAssetId: string;
  timeMs: number;
}
export interface ShotContinuityPreview {
  dataUrl: string;
  sourceToken: string;
  timeMs: number;
  durationMs: number;
  fps: number;
}
export interface ShotContinuityConfirmParams {
  shotId: string;
  videoAssetId: string;
  sourceToken: string;
  timesMs: number[];
  anchorTimeMs: number;
  mode: ShotContinuityMode;
  notes: string;
  expectedRowVersion: number;
}
export interface ShotContinuitySelectionParams {
  shotId: string;
  expectedRowVersion: number;
  frames: Array<{
    videoAssetId: string;
    sourceToken: string;
    timeMs: number;
  }>;
  imageAssetIds: string[];
  anchor:
    | {
        videoAssetId: string;
        timeMs: number;
      }
    | {
        assetId: string;
      };
  notes: string;
}
export interface ShotContinuityReferencesParams {
  shotId: string;
  expectedRowVersion: number;
  assetIds: string[];
  firstFrameAssetId?: string;
}
export interface ShotContinuityPromptPrepareParams {
  shotId: string;
  expectedRowVersion: number;
  kind: ShotContinuityPromptKind;
  providerProfileId: string;
  modelId: string;
}
export interface ShotContinuityWorkerMethodMap {
  'shot.continuity.assets': {
    params: {
      shotId: string;
      assetIds: string[];
    };
    result: AssetInfo[];
  };
  'shot.continuity.import': {
    params: {
      shotId: string;
      sourcePaths: string[];
    };
    result: AssetInfo[];
  };
  'shot.continuity.probe': {
    params: {
      shotId: string;
      videoAssetId: string;
    };
    result: {
      durationMs: number;
      fps: number;
      sourceToken: string;
    };
  };
  'shot.continuity.selection.confirm': {
    params: ShotContinuitySelectionParams;
    result: ShotContinuityContext;
  };
  'shot.continuity.references': {
    params: ShotContinuityReferencesParams;
    result: ShotContinuityContext;
  };
  'shot.continuity.get': {
    params: {
      shotId: string;
    };
    result: ShotContinuityContext;
  };
  'shot.continuity.preview': {
    params: ShotContinuityPreviewParams;
    result: ShotContinuityPreview;
  };
  'shot.continuity.confirm': {
    params: ShotContinuityConfirmParams;
    result: ShotContinuityContext;
  };
  'shot.continuity.reconfirm': {
    params: {
      shotId: string;
      expectedRowVersion: number;
      expectedTargetRowVersion: number;
    };
    result: ShotContinuityContext;
  };
  'shot.continuity.clear': {
    params: {
      shotId: string;
      expectedRowVersion: number;
    };
    result: ShotContinuityContext;
  };
  'shot.continuity.firstFrame': {
    params: {
      shotId: string;
      expectedRowVersion: number;
      assetId: string;
    };
    result: ShotContinuityContext;
  };
  'shot.continuity.reference': {
    params: {
      shotId: string;
      expectedRowVersion: number;
      assetId?: string;
      role: 'reference' | 'first-frame';
    };
    result: ShotContinuityContext;
  };
  'shot.continuity.intent.save': {
    params: {
      shotId: string;
      expectedRowVersion: number;
      notes: string;
    };
    result: ShotContinuityContext;
  };
  'shot.continuity.prompt.prepare': {
    params: ShotContinuityPromptPrepareParams;
    result: LlmGenerationPrepareResult;
  };
  'shot.continuity.prompt.save': {
    params: {
      shotId: string;
      expectedRowVersion: number;
      kind: ShotContinuityPromptKind;
      prompt: string;
    };
    result: ShotContinuityContext;
  };
}
