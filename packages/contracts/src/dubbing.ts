/** Frozen, local-first contracts for fixed character voices and scene dubbing. */
export const DUBBING_CONTRACT_REVISION = 'fixed-voice-v1' as const;
export const DUBBING_LIMITS = {
  audioMaxBytes: 20 * 1024 * 1024,
  cueTextMaxCharacters: 4_000,
  sceneMaxCues: 60,
  clipMaxDurationMs: 60_000,
  sceneMaxDurationMs: 600_000,
  jobMaxSteps: 180,
  structuralToleranceFrames: 1,
} as const;

export type DubbingSpeakerKind = 'character' | 'narration';
export type AudioFileKind =
  'reference' | 'imported-dialogue' | 'generated-dialogue' | 'scene-master';
export type DubbingJobKind = 'speech' | 'lipsync' | 'compose';
export type DubbingJobStatus =
  | 'pending'
  | 'running'
  | 'submission_unknown'
  | 'interrupted'
  | 'cancelling'
  | 'cancelled'
  | 'failed'
  | 'complete';
export type DubbingStepKind =
  'speech' | 'prepare' | 'upload' | 'lipsync' | 'download' | 'validate' | 'compose' | 'commit';

export interface VoiceSettings {
  speed: number;
  pitch: number;
  languageBoost?: string;
}

/** Versions are immutable. A profile points to its current version through CAS. */
export interface VoiceProfileInfo extends VoiceSettings {
  id: string;
  projectId: string;
  characterDocumentId?: string;
  versionId: string;
  revision: number;
  providerProfileId: string;
  model: string;
  voiceId: string;
  contractRevision: string;
  region?: string;
  referenceAudioId?: string;
  rowVersion: number;
  archivedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CharacterVoiceListParams {
  includeArchived?: boolean;
}
export interface CharacterVoiceSaveParams extends VoiceSettings {
  id?: string;
  characterDocumentId?: string;
  providerProfileId: string;
  model: string;
  voiceId: string;
  region?: string;
  referenceAudioId?: string;
  expectedRowVersion?: number;
}

export interface AudioFileInfo {
  id: string;
  projectId: string;
  kind: AudioFileKind;
  name: string;
  relativePath: string;
  mime: 'audio/wav' | 'audio/mpeg';
  sizeBytes: number;
  contentHash: string;
  durationMs: number;
  sampleRate: number;
  channels: number;
  sourceJobId?: string;
  deletedAt?: string;
  trashRelativePath?: string;
  createdAt: string;
}
export interface AudioImportParams {
  sourcePath: string;
  name?: string;
  kind?: 'reference' | 'imported-dialogue';
  sceneId?: string;
  cueId?: string;
  expectedRowVersion?: number;
}
export interface AudioImportResult {
  audio: AudioFileInfo;
  take?: DubbingTakeInfo;
}
export interface AudioListParams {
  deleted?: 'active' | 'trash';
  kind?: AudioFileKind;
}
export interface AudioIdParams {
  audioId: string;
}
export interface AudioPurgeParams extends AudioIdParams {
  confirm: boolean;
}
export interface AudioMediaSourceInfo {
  assetId: string;
  path: string;
  contentType: string;
}

export interface DubbingCueInfo {
  id: string;
  projectId: string;
  sceneId: string;
  shotId?: string;
  speakerKind: DubbingSpeakerKind;
  characterDocumentId?: string;
  voiceProfileId?: string;
  text: string;
  position: number;
  startMs: number;
  emotion?: string;
  visibleSpeaker?: string;
  lipSync: boolean;
  speakerCoordinates?: [number, number];
  trailingPauseMs?: number;
  rowVersion: number;
  selectedTakeId?: string;
  deletedAt?: string;
  takes?: DubbingTakeInfo[];
  createdAt: string;
  updatedAt: string;
}
export interface DubbingCueSaveParams {
  id?: string;
  sceneId: string;
  shotId?: string;
  speakerKind: DubbingSpeakerKind;
  characterDocumentId?: string;
  voiceProfileId?: string;
  text: string;
  position: number;
  startMs: number;
  emotion?: string;
  visibleSpeaker?: string;
  lipSync?: boolean;
  speakerCoordinates?: [number, number];
  trailingPauseMs?: number;
  expectedRowVersion?: number;
}
export interface DubbingCueDeleteParams {
  cueId: string;
  expectedRowVersion: number;
}

/** A take retains the exact cue revision, text hash and voice version that produced it. */
export interface DubbingTakeInfo {
  id: string;
  projectId: string;
  cueId: string;
  cueRowVersion: number;
  textHash: string;
  voiceVersionId?: string;
  voiceSnapshot?: VoiceProfileInfo;
  audioId: string;
  sourceJobId?: string;
  parameters: Record<string, unknown>;
  createdAt: string;
}
export interface DubbingTakeGenerateParams {
  cueId: string;
  expectedRowVersion?: number;
  providerProfileId?: string;
  costAcknowledged: boolean;
  forceNewTake?: boolean;
  budget?: { currency: string; unitPrice?: number; maxAmount?: number; maxAttempts?: number };
}
export interface DubbingTakeAdoptParams {
  cueId: string;
  takeId: string;
  expectedRowVersion: number;
}

/** Unknown prices are represented as unknown, never as zero. No actual charge is inferred. */
export interface DubbingBudgetSnapshot {
  state: 'unknown' | 'estimated';
  currency?: string;
  unit?: string;
  unitPrice?: number;
  priceRevision?: string;
  estimatedTotal?: number;
  acknowledgedAt?: string;
  maxAmount?: number;
  maxAttempts?: number;
  reservedAmount?: number;
}
export interface DubbingJobInfo {
  id: string;
  projectId: string;
  sceneId: string;
  shotId?: string;
  kind: DubbingJobKind;
  status: DubbingJobStatus;
  planVersion: number;
  inputHash: string;
  inputSnapshot: Record<string, unknown>;
  budget: DubbingBudgetSnapshot;
  idempotencyKey: string;
  sourceVideoAssetId?: string;
  providerTaskId?: string;
  outputAudioId?: string;
  outputAssetId?: string;
  adoptedAt?: string;
  error?: string;
  errorKind?: string;
  deadline?: string;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
  steps?: DubbingJobStepInfo[];
}
export interface DubbingJobStepInfo {
  id: string;
  jobId: string;
  stepKey: string;
  kind: DubbingStepKind;
  dependencies: string[];
  status: DubbingJobStatus;
  attempt: number;
  inputHash: string;
  idempotencyKey: string;
  providerTaskId?: string;
  providerAssetId?: string;
  providerAssetExpiresAt?: string;
  region?: string;
  resultAudioId?: string;
  resultAssetId?: string;
  resultRelativePath?: string;
  resultContentHash?: string;
  deadline?: string;
  error?: string;
  errorKind?: string;
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}
export interface DubbingSceneParams {
  sceneId: string;
}
export interface DubbingSceneSnapshot {
  sceneId: string;
  voices: VoiceProfileInfo[];
  cues: DubbingCueInfo[];
  audioFiles: AudioFileInfo[];
  jobs: DubbingJobInfo[];
}
export type DubbingSceneInfo = DubbingSceneSnapshot;
export interface DubbingJobSubmitParams {
  sceneId: string;
  sourceVideoAssetId: string;
  mode: 'lipsync' | 'compose';
  providerProfileId?: string;
  model?: string;
  budget?: { currency: string; unitPrice?: number; maxAmount?: number; maxAttempts?: number };
  costAcknowledged: boolean;
  removeSourceAudioAcknowledged?: boolean;
}
export interface DubbingJobIdParams {
  jobId: string;
}
export interface DubbingJobRetryParams extends DubbingJobIdParams {
  stepKey?: string;
  costAcknowledged?: boolean;
}
export interface DubbingOutputAdoptParams extends DubbingJobIdParams {
  expectedRowVersion: number;
}

export interface DubbingWorkerMethodMap {
  'dubbing.runtime.get': {
    params: Record<string, never>;
    result: { available: boolean; version?: string; error?: string; nativeAvailable: boolean };
  };
  'characterVoice.list': { params: CharacterVoiceListParams; result: VoiceProfileInfo[] };
  'characterVoice.save': { params: CharacterVoiceSaveParams; result: VoiceProfileInfo };
  'audio.import': { params: AudioImportParams; result: AudioImportResult };
  'audio.list': { params: AudioListParams; result: AudioFileInfo[] };
  'audio.get': { params: AudioIdParams; result: AudioFileInfo | null };
  'audio.mediaSource': { params: AudioIdParams; result: AudioMediaSourceInfo };
  'audio.trash': { params: AudioIdParams; result: AudioFileInfo };
  'audio.restore': { params: AudioIdParams; result: AudioFileInfo };
  'audio.purge': { params: AudioPurgeParams; result: { purged: true } };
  'dubbing.scene.get': { params: DubbingSceneParams; result: DubbingSceneInfo };
  'dubbing.cue.save': { params: DubbingCueSaveParams; result: DubbingCueInfo };
  'dubbing.cue.delete': { params: DubbingCueDeleteParams; result: { deleted: true } };
  'dubbing.take.generate': { params: DubbingTakeGenerateParams; result: DubbingJobInfo };
  'dubbing.take.adopt': { params: DubbingTakeAdoptParams; result: DubbingCueInfo };
  'dubbing.job.submit': { params: DubbingJobSubmitParams; result: DubbingJobInfo };
  'dubbing.job.cancel': { params: DubbingJobIdParams; result: DubbingJobInfo };
  'dubbing.job.retry': { params: DubbingJobRetryParams; result: DubbingJobInfo };
  'dubbing.job.get': { params: DubbingJobIdParams; result: DubbingJobInfo | null };
  'dubbing.job.list': { params: Partial<DubbingSceneParams>; result: DubbingJobInfo[] };
  'dubbing.output.adopt': { params: DubbingOutputAdoptParams; result: DubbingJobInfo };
}

/** Credentials, remote URLs and headers never cross these fixed-route host contracts. */
export interface NativeDubbingSpeechParams {
  projectRoot: string;
  providerProfileId: string;
  model: 'speech-2.8-hd' | 'speech-2.8-turbo';
  voiceId: string;
  text: string;
  speed: number;
  pitch: number;
  emotion?: string;
  outputRelativePath: string;
  operationId?: string;
}
export interface NativeDubbingSpeechResult {
  relativePath: string;
  mime: string;
  sizeBytes: number;
}
export interface NativeDubbingSubmitParams {
  projectRoot: string;
  providerProfileId: string;
  videoRelativePath: string;
  audioRelativePath: string;
  idempotencyKey: string;
  speakerCoordinates?: [number, number];
  operationId?: string;
}
export interface NativeDubbingSubmitResult {
  providerTaskId: string;
}
export interface NativeDubbingPollParams {
  projectRoot: string;
  providerProfileId: string;
  providerTaskId: string;
  outputRelativePath: string;
  operationId?: string;
}
export interface NativeDubbingPollResult {
  status: 'pending' | 'running' | 'complete' | 'failed';
  relativePath?: string;
  errorCode?: string;
}
export interface NativeDubbingCancelParams {
  providerProfileId?: string;
  providerTaskId?: string;
  operationId?: string;
}
export interface NativeDubbingCancelResult {
  cancelled: boolean;
  remoteSupported: false;
}
