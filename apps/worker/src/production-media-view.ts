import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import type Database from 'better-sqlite3';
import type {
  ProductionCompileResult,
  ProductionImageSelection,
  ProductionTarget,
  SceneMaterialBindingInfo,
} from '@ai-video/contracts';
import { ProjectService, resolveProjectRelativePath } from './project-service.js';

type AssetRow = {
  id: string;
  kind: string;
  alias: string;
  relative_path: string;
  deleted_at: string | null;
  created_at: string;
};

export interface ProductionAssetDescription {
  assetId: string;
  kind?: string;
  alias?: string;
  createdAt?: string;
  availability: 'available' | 'not-found' | 'deleted' | 'file-unavailable';
}

export interface ProductionMediaBinding {
  role: 'character' | 'scene' | 'prop' | 'other';
  documentId?: string;
  label?: string;
  selectionSource: 'manual' | 'auto' | 'disabled' | 'none';
  selectedAsset?: ProductionAssetDescription;
  defaultAssetId?: string;
  candidateAssets: ProductionAssetDescription[];
  candidatesTruncated: boolean;
}

/** No paths, signed URLs, prompts, credentials or provider payloads leave this read model. */
export function describeProductionAsset(
  db: Database.Database,
  projectId: string,
  rootPath: string,
  assetId: string,
): ProductionAssetDescription {
  const row = db
    .prepare(
      'SELECT id,kind,alias,relative_path,deleted_at,created_at FROM assets WHERE id=? AND project_id=?',
    )
    .get(assetId, projectId) as AssetRow | undefined;
  let availability: 'available' | 'not-found' | 'deleted' | 'file-unavailable' = 'not-found';
  if (row?.deleted_at) availability = 'deleted';
  else if (row) {
    availability = 'file-unavailable';
    try {
      const path = resolveProjectRelativePath(rootPath, row.relative_path);
      // Enforce the project boundary after resolving symlinks too.
      resolveProjectRelativePath(rootPath, relative(realpathSync(rootPath), realpathSync(path)));
      if (statSync(path).isFile()) {
        accessSync(path, constants.R_OK);
        availability = 'available';
      }
    } catch {
      // Missing/unreadable/escaped files are reported, never silently replaced.
    }
  }
  return {
    assetId,
    ...(row ? { kind: row.kind, alias: row.alias ?? '', createdAt: row.created_at } : {}),
    availability,
  };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Read the existing generation provenance without exposing its raw snapshot. */
export function readAssetProvenance(db: Database.Database, projectId: string, assetId: string) {
  const rows = db
    .prepare(
      `SELECT DISTINCT j.id,j.task_snapshot_json,j.created_at
    FROM assets a JOIN generation_results r ON r.asset_id=a.id
    JOIN generation_jobs j ON j.id=r.job_id AND j.project_id=a.project_id
    WHERE a.id=? AND a.project_id=? ORDER BY j.created_at DESC,j.id DESC LIMIT 5`,
    )
    .all(assetId, projectId) as Array<{ id: string; task_snapshot_json: string | null }>;
  const sources = rows.slice(0, 4).map((row) => {
    let snapshot: Record<string, unknown> = {};
    try {
      snapshot = object(JSON.parse(row.task_snapshot_json ?? '{}'));
    } catch {
      /* Legacy incomplete snapshot. */
    }
    const sceneBindings = object(snapshot.sceneBindings);
    const sourceDocumentId =
      typeof snapshot.sourceDocumentId === 'string'
        ? snapshot.sourceDocumentId
        : typeof sceneBindings.sceneDocumentId === 'string'
          ? sceneBindings.sceneDocumentId
          : undefined;
    const document =
      typeof sourceDocumentId === 'string'
        ? (db
            .prepare(
              'SELECT id,title,kind,lifecycle_status AS lifecycleStatus FROM documents WHERE id=? AND project_id=?',
            )
            .get(sourceDocumentId, projectId) as
            { id: string; title: string; kind: string; lifecycleStatus: string } | undefined)
        : undefined;
    const inputs: unknown[] = Array.isArray(snapshot.inputs) ? snapshot.inputs : [];
    const production = object(snapshot.productionSource);
    const formImages: unknown[] = Array.isArray(production.inputImages)
      ? production.inputImages
      : [];
    const recordedIds = new Set<string>();
    for (const input of [...inputs, ...formImages]) {
      const entry = object(input);
      if (
        typeof entry.assetId === 'string' &&
        (entry.type === 'asset' || formImages.includes(input))
      )
        recordedIds.add(entry.assetId);
    }
    // Older form snapshots can retain project references directly in parameters.
    let visited = 0;
    const collect = (value: unknown, depth = 0) => {
      if (++visited > 2048 || depth > 8) return;
      if (typeof value === 'string') {
        const match = /^(?:asset|project-asset):\/\/([^/?#]+)$/u.exec(value);
        if (match) recordedIds.add(match[1]!);
      } else if (Array.isArray(value)) {
        for (const item of value) collect(item, depth + 1);
      } else {
        for (const [key, item] of Object.entries(object(value)))
          if (!['prompt', 'text', 'originalPrompt'].includes(key)) collect(item, depth + 1);
      }
    };
    collect(snapshot.parameters);
    const inputAssetIds = [...recordedIds].filter((id) =>
      Boolean(db.prepare('SELECT 1 FROM assets WHERE id=? AND project_id=?').get(id, projectId)),
    );
    return {
      generationJobId: row.id,
      ...(document ? { sourceDocumentId: document.id, sourceDocument: document } : {}),
      sourceDocumentStatus: document
        ? 'recorded'
        : sourceDocumentId
          ? 'unavailable'
          : 'not-recorded',
      inputAssetIds: inputAssetIds.slice(0, 64),
      inputsRecorded:
        Array.isArray(snapshot.inputs) ||
        Array.isArray(production.inputImages) ||
        recordedIds.size > 0,
      inputsTruncated: inputAssetIds.length > 64 || visited > 2048,
    };
  });
  return { status: rows.length ? 'recorded' : 'not-recorded', sources, truncated: rows.length > 4 };
}

export function productionMediaView(
  projects: ProjectService,
  target: ProductionTarget,
  sceneInputs: ProductionCompileResult['sceneInputs'],
  imageBindings: SceneMaterialBindingInfo[],
  materialReferences: Array<{ documentId: string; role: 'scene' | 'prop' }>,
  overrides: {
    imageGeneration: ProductionImageSelection[];
    videoGeneration: ProductionImageSelection[];
  },
) {
  return projects.access(false, (db, project) => {
    const describe = (assetId: string) =>
      describeProductionAsset(db, project.id, project.rootPath, assetId);
    const candidateAssets = (documentId: string) => {
      const rows = db
        .prepare(
          `SELECT DISTINCT a.id,a.created_at FROM assets a
        JOIN generation_results r ON r.asset_id=a.id
        JOIN generation_jobs j ON j.id=r.job_id AND j.project_id=a.project_id
        WHERE a.project_id=? AND a.deleted_at IS NULL AND lower(a.kind) NOT LIKE '%video%'
          AND json_extract(j.task_snapshot_json,'$.sourceDocumentId')=?
        ORDER BY a.created_at DESC,a.id DESC LIMIT 9`,
        )
        .all(project.id, documentId) as Array<{ id: string }>;
      return {
        candidateAssets: rows.slice(0, 8).map(({ id }) => describe(id)),
        candidatesTruncated: rows.length > 8,
      };
    };
    const bindings: ProductionMediaBinding[] = [];
    for (const binding of sceneInputs?.scene.characterBindings ?? []) {
      const character = sceneInputs?.media.characters.find(
        (item) => item.characterDocumentId === binding.characterDocumentId,
      );
      const selectedId = binding.imageDisabled
        ? undefined
        : (binding.imageAssetId ?? character?.defaultImage?.id);
      bindings.push({
        role: 'character',
        documentId: binding.characterDocumentId,
        label: sceneInputs?.characterNames[binding.characterDocumentId],
        selectionSource: binding.imageDisabled
          ? 'disabled'
          : binding.imageAssetId
            ? 'manual'
            : selectedId
              ? 'auto'
              : 'none',
        ...(selectedId ? { selectedAsset: describe(selectedId) } : {}),
        ...(character?.defaultImage ? { defaultAssetId: character.defaultImage.id } : {}),
        ...candidateAssets(binding.characterDocumentId),
      });
    }
    for (const binding of imageBindings.filter((item) => item.role !== 'character')) {
      bindings.push({
        role: binding.role,
        ...(binding.sourceDocumentId ? { documentId: binding.sourceDocumentId } : {}),
        label: binding.label,
        selectionSource: binding.source,
        selectedAsset: describe(binding.assetId),
        ...(binding.sourceDocumentId
          ? candidateAssets(binding.sourceDocumentId)
          : { candidateAssets: [], candidatesTruncated: false }),
      });
    }
    for (const reference of materialReferences) {
      if (
        bindings.some(
          (binding) =>
            binding.documentId === reference.documentId && binding.role === reference.role,
        )
      )
        continue;
      const document = db
        .prepare('SELECT title FROM documents WHERE id=? AND project_id=?')
        .get(reference.documentId, project.id) as { title: string } | undefined;
      bindings.push({
        ...reference,
        label: document?.title,
        selectionSource: 'none',
        ...candidateAssets(reference.documentId),
      });
    }
    const referenceImages = bindings.flatMap((binding) =>
      binding.selectedAsset
        ? [
            {
              role:
                binding.role === 'prop' || binding.role === 'other'
                  ? ('reference' as const)
                  : binding.role,
              label: binding.label,
              ...binding.selectedAsset,
            },
          ]
        : [],
    );
    const inputs = (selected: ProductionImageSelection[]) =>
      selected.length
        ? selected.map(({ assetId, ...item }) => ({ ...item, ...describe(assetId) }))
        : referenceImages;
    return {
      scope: 'saved-production-bindings',
      modelAdapted: false,
      includesUnsavedFormEdits: false,
      note: '当前保存绑定和默认解析；候选不是选用。输入顺序尚未经过模型适配或未保存表单覆盖；最终以用户审核表单快照为准。未读取图片像素，不能据此描述外观。',
      target,
      bindings,
      inputs: {
        referenceImages,
        imageGeneration: inputs(overrides.imageGeneration),
        videoGeneration: inputs(overrides.videoGeneration),
      },
    };
  });
}
