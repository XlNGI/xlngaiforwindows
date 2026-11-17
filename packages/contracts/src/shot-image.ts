import type { AssetInfo, ProductionImageSelection, PromptBindingIR } from './index.js';

export type ShotImagePurpose = 'composition' | 'first-frame' | 'last-frame';
/** Static authoring is independent of the shot's video prompt and selected source frames. */
export interface ShotImageRecord {
  shotId: string;
  prompt: string;
  purpose: ShotImagePurpose;
  intent: string;
  bindings?: PromptBindingIR;
  sourceToken?: string;
  rowVersion: number;
  legacyPrompt?: string;
}
export interface ShotVideoImages {
  shotId: string;
  /** Undefined follows the shot's bound images (including an unconfirmed version-0 placeholder).
   * A confirmed empty array explicitly disables inputs. */
  selections?: ProductionImageSelection[];
  rowVersion: number;
  conflicts: string[];
}
export interface ShotImageContext extends ShotImageRecord {
  currentSourceToken: string;
  stale: boolean;
  sourceStale: boolean;
  inputImages: ProductionImageSelection[];
  assets: AssetInfo[];
  videoImages: ShotVideoImages;
}
export interface ShotImageSaveParams {
  shotId: string;
  expectedRowVersion: number;
  sourceToken: string;
  prompt: string;
  purpose: ShotImagePurpose;
  intent: string;
  /** Omitted preserves the existing explicit scope, never borrows video bindings. */
  bindings?: PromptBindingIR;
}
export interface ShotImageWorkerMethodMap {
  'shot.prompt.preview': {
    params: {
      shotId: string;
      kind: 'image' | 'video';
      prompt?: string;
      inputImages?: ProductionImageSelection[];
    };
    result: { prompt: string; inputImages: ProductionImageSelection[] };
  };
  'shot.image.get': { params: { shotId: string }; result: ShotImageContext };
  'shot.image.save': { params: ShotImageSaveParams; result: ShotImageContext };
  'shot.videoImages.save': {
    params: { shotId: string; expectedRowVersion: number; selections: ProductionImageSelection[] };
    result: ShotImageContext;
  };
}
