import { useEffect, useState } from 'react';
import type { AssetInfo, DocumentSummary } from '@ai-video/contracts';
import { projectWorker } from './worker-scope';
import { ReferenceCard, referenceAssetName } from './ReferenceCard';

export function useSceneSettingImages(
  projectId: string | undefined,
  documentId: string | undefined,
  documents: DocumentSummary[],
  revision?: unknown,
) {
  const available = documents.some(
    (d) =>
      d.id === documentId &&
      d.projectId === projectId &&
      d.kind === 'scene' &&
      d.domainScope !== 'novel' &&
      d.lifecycleStatus === 'active',
  );
  const key = `${projectId}:${documentId}:${available}`;
  const [state, setState] = useState<{ key: string; assets: AssetInfo[]; error?: string }>();
  useEffect(() => {
    let active = true;
    if (!projectId || !documentId || !available) return;
    const callWorker = projectWorker();
    void callWorker('asset.list', {
      sourceDocumentId: documentId,
      sort: 'created-desc',
      limit: 200,
    })
      .then((assets) => {
        if (active)
          setState({
            key,
            assets: assets.filter(
              (a) =>
                a.projectId === projectId &&
                !a.deletedAt &&
                !a.kind.toLowerCase().includes('video'),
            ),
          });
      })
      .catch(() => {
        if (active) setState({ key, assets: [], error: '场景参考图读取失败，请重新打开或重试。' });
      });
    return () => {
      active = false;
    };
  }, [key, revision]);
  return {
    assets: state?.key === key ? state.assets : [],
    error: state?.key === key ? state.error : undefined,
    available,
    loading: Boolean(projectId && documentId && available && state?.key !== key),
  };
}

export function SceneSettingCard({
  projectId,
  documentId,
  documents,
  asset,
  images,
  candidates,
  writable,
  busy,
  message,
  onBind,
  onOpen,
  onSelectImage,
  onDropAsset,
  onRestore,
  imageDisabled,
  canClear = true,
}: {
  projectId?: string;
  documentId?: string;
  documents: DocumentSummary[];
  asset?: AssetInfo;
  images: AssetInfo[];
  candidates: AssetInfo[];
  writable: boolean;
  busy?: boolean;
  message?: string;
  onBind?: (id: string) => void;
  onOpen?: (id: string) => void;
  onSelectImage: (id?: string) => void;
  onDropAsset: (asset: AssetInfo) => void;
  onRestore?: () => void;
  imageDisabled?: boolean;
  canClear?: boolean;
}) {
  const choices = [
    ...new Map(
      [...(asset ? [asset] : []), ...images, ...candidates]
        .filter(
          (a) =>
            a.projectId === projectId && !a.deletedAt && !a.kind.toLowerCase().includes('video'),
        )
        .map((a) => [a.id, a]),
    ).values(),
  ];
  const locations = documents.filter(
    (d) =>
      d.projectId === projectId &&
      d.kind === 'scene' &&
      d.domainScope !== 'novel' &&
      d.lifecycleStatus === 'active',
  );
  return (
    <ReferenceCard
      label="场景参考"
      projectId={projectId}
      asset={asset}
      writable={writable && !busy}
      onDropAsset={onDropAsset}
      emptyText={imageDisabled ? '本镜头不使用场景参考图' : '拖入或下拉选择'}
      selector={
        <select
          aria-label="场景参考"
          value={asset?.id ?? ''}
          disabled={!writable || busy}
          onChange={(event) => onSelectImage(event.target.value || undefined)}
        >
          <option value="">{documentId && !canClear ? '使用场景默认参考图' : '未选择'}</option>
          {choices.map((a) => (
            <option key={a.id} value={a.id}>
              {referenceAssetName(a)}
            </option>
          ))}
        </select>
      }
    >
      {onBind && (
        <label>
          关联场景
          <select
            aria-label="场次绑定场景"
            value={documentId ?? ''}
            disabled={!writable || busy}
            onChange={(event) => onBind(event.target.value)}
          >
            <option value="">未绑定场景</option>
            {documentId && !locations.some((d) => d.id === documentId) && (
              <option value={documentId}>已绑定的场景资料不可用</option>
            )}
            {locations.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
              </option>
            ))}
          </select>
        </label>
      )}
      {asset && canClear && (
        <button
          type="button"
          className="text-button"
          disabled={!writable || busy}
          onClick={() => onSelectImage(undefined)}
        >
          清除
        </button>
      )}
      {onRestore && (
        <button
          type="button"
          className="text-button"
          disabled={!writable || busy}
          onClick={onRestore}
        >
          恢复场次场景图
        </button>
      )}
      {documentId && onOpen && (
        <button type="button" className="text-button" onClick={() => onOpen(documentId)}>
          打开场景资料
        </button>
      )}
      {message && <small role="status">{message}</small>}
    </ReferenceCard>
  );
}
