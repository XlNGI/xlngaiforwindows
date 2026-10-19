import { useProjectViewState } from './use-project-view-state';
import type { AssetInfo, AssetSourceInfo, SceneInfo, ShotInfo } from '@ai-video/contracts';
import { projectWorker } from './worker-scope';

export interface UseAssetWorkspaceOptions {
  scenes: SceneInfo[];
  setScene: (scene: SceneInfo) => void;
  setShots: (shots: ShotInfo[]) => void;
  setShot: (shot?: ShotInfo) => void;
  setNavigationMode: (mode: 'project' | 'production') => void;
  setContentMessage: (message: string) => void;
}

export function useAssetWorkspace({
  scenes,
  setScene,
  setShots,
  setShot,
  setNavigationMode,
  setContentMessage,
}: UseAssetWorkspaceOptions) {
  const callWorker = projectWorker();
  const [assets, setAssets] = useProjectViewState<AssetInfo[]>([]);
  const [asset, setAsset] = useProjectViewState<AssetInfo>();
  const [assetLibrarySelectedId, setAssetLibrarySelectedId] = useProjectViewState<string>();
  const [focusedSource, setFocusedSource] = useProjectViewState<AssetSourceInfo>();

  const updateAssets = (nextAssets: AssetInfo[], selectedAssetId?: string) => {
    setAssets(nextAssets);
    const selected =
      (selectedAssetId ? nextAssets.find((item) => item.id === selectedAssetId) : undefined) ??
      nextAssets.find((item) => item.id === asset?.id) ??
      nextAssets[0];
    setAsset(selected);
    if (selectedAssetId) setAssetLibrarySelectedId(selectedAssetId);
  };

  const openAssetSource = async (source: AssetSourceInfo) => {
    setFocusedSource(source);
    setAssetLibrarySelectedId(source.assetId);
    setAsset(assets.find((item) => item.id === source.assetId));
    if (source.shotId) {
      for (const candidateScene of scenes) {
        const candidateShots = await callWorker('shot.list', { sceneId: candidateScene.id });
        const sourceShot = candidateShots.find((item) => item.id === source.shotId);
        if (sourceShot) {
          setScene(candidateScene);
          setShots(candidateShots);
          setShot(sourceShot);
          break;
        }
      }
    }
    setNavigationMode('production');
    setContentMessage(`已定位来源任务 ${source.jobId}`);
  };

  const reset = () => {
    setAssets([]);
    setAsset(undefined);
    setAssetLibrarySelectedId(undefined);
    setFocusedSource(undefined);
  };

  return {
    assets,
    setAssets,
    asset,
    setAsset,
    assetLibrarySelectedId,
    setAssetLibrarySelectedId,
    focusedSource,
    setFocusedSource,
    updateAssets,
    openAssetSource,
    reset,
  };
}
