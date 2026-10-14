export interface CharacterVoiceReferenceInfo {
  id: string;
  projectId: string;
  characterDocumentId: string;
  characterName: string;
  versionId: string;
  revision: number;
  rowVersion: number;
  audioId: string;
  audioName: string;
  durationMs: number;
  sizeBytes: number;
  mime: string;
}
export interface CharacterVoiceReferenceSaveParams {
  characterDocumentId: string;
  audioId: string;
  expectedRowVersion?: number;
}
export interface VoiceReferenceWorkerMethodMap {
  'characterVoiceReference.list': {
    params: Record<string, never>;
    result: CharacterVoiceReferenceInfo[];
  };
  'characterVoiceReference.save': {
    params: CharacterVoiceReferenceSaveParams;
    result: CharacterVoiceReferenceInfo;
  };
}
