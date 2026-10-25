import type { AssetInfo, LlmGenerationPrepareResult, ShotInfo } from './index.js';

export type ShotContinuityMode = 'continue' | 'reframe';
export type ShotContinuityPromptKind = 'image' | 'video';
export interface ShotContinuityFrame {
  assetId: string;
  timeMs: number;
}
export interface ShotContinuityBinding {
  sourceShotId: string;
  sourceVideoAssetId: string;
  sourceVideoHash: string;
  targetRowVersion: number;
  mode: ShotContinuityMode;
  notes: string;
  frames: ShotContinuityFrame[];
  anchorAssetId: string;
  firstFrameAssetId?: string;
  imagePrompt?: string;
  /** Read projection of the current shot authoring IR, never a second stored video prompt. */
  videoPrompt?: string;
}
export interface ShotContinuityState {
  shotId: string;
  rowVersion: number;
  binding?: ShotContinuityBinding;
}
export interface ShotContinuityContext extends ShotContinuityState {
  previousShot?: ShotInfo;
  videos: AssetInfo[];
  images: AssetInfo[];
  stale: boolean;
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
export interface ShotContinuityPromptPrepareParams {
  shotId: string;
  expectedRowVersion: number;
  kind: ShotContinuityPromptKind;
  providerProfileId: string;
  modelId: string;
}
export interface ShotContinuityWorkerMethodMap {
  'shot.continuity.get': { params: { shotId: string }; result: ShotContinuityContext };
  'shot.continuity.preview': {
    params: ShotContinuityPreviewParams;
    result: ShotContinuityPreview;
  };
  'shot.continuity.confirm': {
    params: ShotContinuityConfirmParams;
    result: ShotContinuityContext;
  };
  'shot.continuity.clear': {
    params: { shotId: string; expectedRowVersion: number };
    result: ShotContinuityContext;
  };
  'shot.continuity.firstFrame': {
    params: { shotId: string; expectedRowVersion: number; assetId: string };
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
