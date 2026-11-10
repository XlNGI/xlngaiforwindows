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
export interface CharacterVoiceReferenceGenerateParams {
  characterDocumentId: string;
  expectedVoiceVersionId: string;
  expectedRowVersion: number;
  text: string;
  costAcknowledged: boolean;
  voiceId?: string;
  speed?: number;
  pitch?: number;
  emotion?: string;
}
export interface CharacterVoiceReferencePrepareParams {
  characterDocumentId: string;
  expectedVoiceVersionId: string;
  adapterKey: string;
  providerProfileId: string;
  modelId: string;
  parameters: Record<string, unknown>;
}
export interface CharacterVoiceReferenceConfirmParams {
  confirmationToken: string;
  approved: boolean;
}
export interface CharacterVoiceDesignPrepareParams {
  characterDocumentId: string;
  voiceDocumentId: string;
  expectedVoiceDocumentVersionId: string;
  expectedCharacterRowVersion: number;
  providerProfileId: string;
  modelId: 'speech-2.8-hd' | 'speech-2.8-turbo';
}
export type CharacterVoiceDesignConfirmResult =
  | { approved: false }
  | {
      approved: true;
      audio: import('./dubbing.js').AudioFileInfo;
      voiceProfile: import('./dubbing.js').VoiceProfileInfo;
      reference: CharacterVoiceReferenceInfo;
    };
export interface NativeVoiceDesignParams {
  projectRoot: string;
  providerProfileId: string;
  prompt: string;
  previewText: string;
  outputRelativePath: string;
  operationId?: string;
}
export interface NativeVoiceDesignResult {
  relativePath: string;
  mime: string;
  sizeBytes: number;
  voiceId: string;
}
export interface VoiceReferenceWorkerMethodMap {
  'characterVoiceDesign.prepare': {
    params: CharacterVoiceDesignPrepareParams;
    result: { confirmation: import('./index.js').MediaSubmissionConfirmationRequest };
  };
  'characterVoiceDesign.confirm': {
    params: CharacterVoiceReferenceConfirmParams;
    result: CharacterVoiceDesignConfirmResult;
  };
  'characterVoiceReference.list': {
    params: Record<string, never>;
    result: CharacterVoiceReferenceInfo[];
  };
  'characterVoiceReference.save': {
    params: CharacterVoiceReferenceSaveParams;
    result: CharacterVoiceReferenceInfo;
  };
  'characterVoiceReference.generate': {
    params: CharacterVoiceReferenceGenerateParams;
    result: CharacterVoiceReferenceInfo;
  };
  'characterVoiceReference.prepare': {
    params: CharacterVoiceReferencePrepareParams;
    result: { confirmation: import('./index.js').MediaSubmissionConfirmationRequest };
  };
  'characterVoiceReference.confirm': {
    params: CharacterVoiceReferenceConfirmParams;
    result: { approved: false } | { approved: true; reference: CharacterVoiceReferenceInfo };
  };
}
