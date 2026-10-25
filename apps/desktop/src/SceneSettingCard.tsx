import { useEffect, useState } from 'react';
import type { AssetInfo, DocumentSummary } from '@ai-video/contracts';
import { projectWorker } from './worker-scope';
import { ReferenceCard, referenceAssetName } from './ReferenceCard';

export function useSceneSettingImages(
  projectId: string | undefined,
  documentId: string | string[] | undefined,
  documents: DocumentSummary[],
  revision?: unknown,
) {
  const documentIds: string[] = Array.from(
    new Set(
      (Array.isArray(documentId) ? documentId : documentId ? [documentId] : []).filter(
        (id): id is string => Boolean(id),
      ),
    ),
  );
  const availableIds = documentIds.filter((id) =>
    documents.some(
      (d) =>
        d.id === id &&
        d.projectId === projectId &&
        d.kind === 'scene' &&
        d.domainScope !== 'novel' &&
        d.lifecycleStatus === 'active',
    ),
  );
  const available = availableIds.length > 0;
  const key = `${projectId}:${documentIds.join(',')}:${availableIds.join(',')}`;
  const [state, setState] = useState<{
    key: string;
    assets: AssetInfo[];
    assetsByDocument: Record<string, AssetInfo[]>;
    error?: string;
  }>();
  useEffect(() => {
    let active = true;
    if (!projectId || !availableIds.length) return;
    const callWorker = projectWorker();
    void Promise.all(
      availableIds.map((sourceDocumentId) =>
        callWorker('asset.list', {
          sourceDocumentId,
          sort: 'created-desc',
          limit: 200,
        }),
      ),
    )
      .then((groups) => {
        if (active) {
          const assetsByDocument = Object.fromEntries(
            availableIds.map((sourceDocumentId, index) => [
              sourceDocumentId,
              groups[index]!.filter(
                (asset) =>
                  asset.projectId === projectId &&
                  !asset.deletedAt &&
                  !asset.kind.toLowerCase().includes('video'),
              ),
            ]),
          );
          setState({
            key,
            assetsByDocument,
            assets: Array.from(
              new Map(
                Object.values(assetsByDocument)
                  .flat()
                  .map((asset) => [asset.id, asset]),
              ).values(),
            ),
          });
        }
      })
      .catch(() => {
        if (active)
          setState({
            key,
            assets: [],
            assetsByDocument: {},
            error: '场景参考图读取失败，请重新打开或重试。',
          });
      });
    return () => {
      active = false;
    };
  }, [key, revision, availableIds.join(',')]);
  return {
    assets: state?.key === key ? state.assets : [],
    assetsByDocument: state?.key === key ? state.assetsByDocument : {},
    error: state?.key === key ? state.error : undefined,
    available,
    loading: Boolean(projectId && documentId && available && state?.key !== key),
    documentIds,
  };
}

export function SceneSettingCard({
  projectId,
  documentId,
  documentIds,
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
  documentIds?: string[];
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
  const boundDocumentIds: string[] = Array.from(
    new Set(
      (documentIds?.length ? documentIds : documentId ? [documentId] : []).filter(
        (id): id is string => Boolean(id),
      ),
    ),
  );
  const boundDocuments = boundDocumentIds
    .map((id) => documents.find((document) => document.id === id))
    .filter((document): document is DocumentSummary => Boolean(document));
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
          <option value="">{documentId && !canClear ? '场景默认图' : '未选择'}</option>
          {choices.map((a) => (
            <option key={a.id} value={a.id}>
              {referenceAssetName(a)}
            </option>
          ))}
        </select>
      }
    >
      {onBind &&
        (boundDocumentIds.length > 1 ? (
          <div className="reference-binding-summary" aria-label="已绑定场景资料">
            <span>已绑定场景资料</span>
            {boundDocuments.length ? (
              <ul>
                {boundDocuments.map((document) => (
                  <li key={document.id}>
                    {onOpen ? (
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => onOpen(document.id)}
                      >
                        {document.title}
                      </button>
                    ) : (
                      document.title
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <small>绑定的场景资料不可用</small>
            )}
          </div>
        ) : (
          <label>
            绑定场景
            <select
              aria-label="场次绑定场景"
              value={documentId ?? boundDocumentIds[0] ?? ''}
              disabled={!writable || busy}
              onChange={(event) => onBind(event.target.value)}
            >
              <option value="">未绑定场景</option>
              {(documentId ?? boundDocumentIds[0]) &&
                !locations.some((d) => d.id === (documentId ?? boundDocumentIds[0])) && (
                  <option value={documentId ?? boundDocumentIds[0]}>已绑定的场景资料不可用</option>
                )}
              {locations.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
          </label>
        ))}
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
      {boundDocumentIds.length <= 1 && documentId && onOpen && (
        <button type="button" className="text-button" onClick={() => onOpen(documentId)}>
          打开场景资料
        </button>
      )}
      {message && <small role="status">{message}</small>}
    </ReferenceCard>
  );
}
