/** Non-destructive local editing. A sequence groups scenes; it is not an episode entity. */
export interface RoughCutClip {
  id: string;
  assetId: string;
  contentHash: string;
  name: string;
  durationMs: number;
  width: number;
  height: number;
  hasAudio: boolean;
  fps?: number;
  audioChannels?: number;
  inMs: number;
  outMs: number;
  muted: boolean;
  fit: 'contain' | 'cover';
  sceneId?: string;
  shotId?: string;
}

export interface RoughCutSequence {
  id: string;
  projectId: string;
  name: string;
  sceneIds: string[];
  clips: RoughCutClip[];
  rowVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface RoughCutState {
  sequence: RoughCutSequence;
  unavailableClipIds: string[];
}

export interface RoughCutPrepareParams {
  assetIds?: string[];
  /** Explicit selection of this episode's scenes. Scene video wins over shot fallbacks. */
  sceneIds?: string[];
}

export interface RoughCutPrepared {
  clips: RoughCutClip[];
  missingSceneIds: string[];
}

/** A view of existing saved scene groups, not a new episode entity. */
export interface RoughCutEpisode {
  number: number;
  title: string;
  sceneIds: string[];
  source: 'structure' | 'sequence';
}

export interface RoughCutSaveParams {
  id?: string;
  expectedRowVersion: number;
  name: string;
  sceneIds: string[];
  clips: RoughCutClip[];
}

export type RoughCutExportFormat = 'xml' | 'mp4';
export interface RoughCutExportJob {
  id: string;
  format: RoughCutExportFormat;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  completedClips: number;
  totalClips: number;
  sequenceVersion: number;
  path?: string;
  error?: string;
}

export interface RoughCutWorkerMethodMap {
  'roughCut.episodes': { params: Record<string, never>; result: RoughCutEpisode[] };
  'roughCut.list': { params: Record<string, never>; result: RoughCutSequence[] };
  'roughCut.get': { params: { id: string }; result: RoughCutState };
  'roughCut.save': { params: RoughCutSaveParams; result: RoughCutState };
  'roughCut.delete': {
    params: { id: string; expectedRowVersion: number };
    result: { deleted: true };
  };
  'roughCut.prepare': { params: RoughCutPrepareParams; result: RoughCutPrepared };
  'roughCut.export.start': {
    params: { sequenceId: string; expectedRowVersion: number; format: RoughCutExportFormat };
    result: RoughCutExportJob;
  };
  'roughCut.export.get': { params: { id: string }; result: RoughCutExportJob };
  'roughCut.export.assets': { params: { assetIds: string[] }; result: RoughCutExportJob };
  'roughCut.export.cancel': { params: { id: string }; result: RoughCutExportJob };
  'roughCut.export.reveal': { params: { id: string }; result: { path: string } };
}
