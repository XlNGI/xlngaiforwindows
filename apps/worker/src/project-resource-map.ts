import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  DocumentKind,
  ProjectStructureResource,
  ProjectStructureResult,
} from '@ai-video/contracts';
import type { OpenProject } from '@ai-video/domain';

type Workspace = ProjectStructureResource['locator']['workspace'];
export interface ResourceMapPageOptions {
  workspace?: string;
  kind?: string;
  parentId?: string;
  query?: string;
  offset?: number;
  limit?: number;
  expectedRevision?: string;
}
interface ResourceMapResult extends ProjectStructureResult {
  offset?: number;
  limit?: number;
  totalResources?: number;
  nextOffset?: number;
  counts?: Record<string, number>;
}
const WORKSPACES: Array<[Workspace, string]> = [
  ['novel', '小说（章节、小说大纲与设定资料）'],
  ['documents', '剧本（短剧大纲、计划、约束与笔记）'],
  ['characters', '角色、场景与道具（制作资料）'],
  ['shots', '场次与镜头'],
  ['assets', '素材库'],
  ['tasks', '任务日志'],
  ['settings', '设置'],
];

export function workspaceResource(workspace: Workspace): ProjectStructureResource {
  const id = `workspace:${workspace}`;
  return {
    id,
    kind: 'workspace',
    title: WORKSPACES.find(([key]) => key === workspace)![1],
    ...(workspace === 'shots'
      ? {
          writeTool: 'scene.submit_structure',
          contentModel:
            'Agent 按任务需要选择资料与工具，并自行组织场次、镜头提示词和开放 authoringIR.data；references 只使用真实角色、场景资料、道具文档 ID。系统校验 IR、项目范围和引用类型，不选择语义字段或重写提示词。成功提交后自动保存为可编辑草稿，无需用户确认。已有场次和镜头可按需读取，场次修改需 sceneId 与 expectedRowVersion；已有镜头正文使用 scene.update_shot_prompts（shotId 与 expectedRowVersion），仅时长修改使用 scene.update_shot_timings。用户要求必须写入最终 prompt，data 只作补充。',
        }
      : {}),
    locator: { workspace, resourceId: id },
  };
}

type DocumentRow = {
  id: string;
  title: string;
  kind: DocumentKind;
  lifecycle_status: 'active' | 'archived';
  row_version: number;
  current_version_id: string | null;
  chapter_id: string | null;
  chapter_status: string | null;
  domain_scope: string | null;
  binding_status: string | null;
  binding_role: string | null;
};

const DOCUMENT_QUERY = `SELECT d.id, d.title, d.kind, d.lifecycle_status, d.row_version, d.current_version_id,
  c.id AS chapter_id, c.lifecycle_status AS chapter_status, b.domain_scope, b.status AS binding_status, b.role AS binding_role
  FROM documents d LEFT JOIN novel_chapters c ON c.document_id = d.id
  LEFT JOIN document_bindings b ON b.document_id = d.id WHERE d.project_id = ?`;

export function documentWorkspace(
  row: Pick<DocumentRow, 'chapter_id' | 'domain_scope' | 'kind'>,
): Workspace {
  if (row.chapter_id || row.domain_scope === 'novel') return 'novel';
  if (row.kind === 'character' || row.kind === 'scene' || row.kind === 'prop') return 'characters';
  if (row.kind === 'storyboard') return 'shots';
  return 'documents';
}

function documentResource(row: DocumentRow): ProjectStructureResource {
  const workspace = documentWorkspace(row);
  const id = `document:${row.id}`;
  return {
    id,
    kind: 'document',
    title: row.title,
    parentId: `workspace:${workspace}`,
    documentId: row.id,
    documentKind: row.kind,
    rowVersion: row.row_version,
    lifecycleStatus: row.lifecycle_status,
    sourceType: row.chapter_id
      ? 'novel-chapter'
      : row.domain_scope === 'novel'
        ? 'novel-reference'
        : 'document',
    ...(row.current_version_id ? { versionId: row.current_version_id } : {}),
    locator: {
      workspace,
      resourceId: id,
      documentId: row.id,
      ...(row.current_version_id ? { versionId: row.current_version_id } : {}),
    },
  };
}

type NodeRow = {
  id: string;
  document_id: string;
  version_id: string;
  node_kind: ProjectStructureResource['structureKind'];
  title: string;
  path_json: string;
};

function nodeResource(node: NodeRow, document: ProjectStructureResource): ProjectStructureResource {
  const id = `structure-node:${node.id}`;
  return {
    ...document,
    id,
    kind: 'structure-node',
    title: node.title,
    parentId: document.id,
    structureKind: node.node_kind,
    versionId: node.version_id,
    locator: {
      ...document.locator,
      resourceId: id,
      versionId: node.version_id,
      structureNodeId: node.id,
      structurePath: JSON.parse(node.path_json) as string[],
    },
  };
}

/** Metadata only. Empty pages remain valid creation destinations. */
export function compileProjectResourceMap(
  database: Database.Database,
  project: OpenProject,
  includeArchived = false,
  page?: ResourceMapPageOptions,
): ResourceMapResult {
  const readDocumentIds = (value: string | null | undefined): string[] | undefined => {
    if (!value) return undefined;
    try {
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed)) return undefined;
      const ids = parsed.filter(
        (item): item is string => typeof item === 'string' && Boolean(item.trim()),
      );
      return ids.length === parsed.length ? [...new Set(ids)] : undefined;
    } catch {
      return undefined;
    }
  };
  const resources = WORKSPACES.map(([workspace]) => workspaceResource(workspace));
  const rows = database
    .prepare(
      `${DOCUMENT_QUERY} ${includeArchived ? '' : "AND d.lifecycle_status = 'active' AND (b.status IS NULL OR b.status != 'archived') AND (c.lifecycle_status IS NULL OR c.lifecycle_status != 'archived') AND NOT EXISTS (SELECT 1 FROM shots JOIN scenes ON scenes.id=shots.scene_id WHERE shots.document_id=d.id AND (shots.archived_at IS NOT NULL OR scenes.archived_at IS NOT NULL))"} ORDER BY d.updated_at DESC, d.id ${page ? '' : 'LIMIT 101'}`,
    )
    .all(project.id) as DocumentRow[];
  let truncated = rows.length > 100;
  const documents = (page ? rows : rows.slice(0, 100)).map(documentResource);
  resources.push(...documents);
  const entityQueries: Array<[ProjectStructureResource['kind'], Workspace, string]> = [
    [
      'novel-volume',
      'novel',
      `SELECT id, title, row_version AS rowVersion FROM novel_volumes WHERE project_id = ? ${includeArchived ? '' : "AND status != 'archived'"} ORDER BY position, id`,
    ],
    [
      'scene',
      'shots',
      `SELECT id, title, scene_document_id AS sceneDocumentId, row_version AS rowVersion,
        CASE WHEN archived_at IS NULL THEN 'active' ELSE 'archived' END AS lifecycleStatus,
        json_extract(authoring_ir_json,'$.references.sceneDocumentIds') AS sceneDocumentIdsJson
       FROM scenes WHERE project_id = ? ${includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY position, id`,
    ],
    [
      'shot',
      'shots',
      `SELECT shots.id, shots.title, shots.scene_id AS sceneId,
        CASE WHEN shots.archived_at IS NULL AND scenes.archived_at IS NULL THEN 'active' ELSE 'archived' END AS lifecycleStatus,
        scenes.scene_document_id AS sceneDocumentId, shots.row_version AS rowVersion,
        json_extract(scenes.authoring_ir_json,'$.references.sceneDocumentIds') AS sceneDocumentIdsJson
       FROM shots JOIN scenes ON scenes.id = shots.scene_id
       WHERE scenes.project_id = ? ${includeArchived ? '' : 'AND scenes.archived_at IS NULL AND shots.archived_at IS NULL'} ORDER BY scenes.position, shots.position, shots.id`,
    ],
    [
      'asset',
      'assets',
      `SELECT id, CASE WHEN alias = '' THEN kind ELSE alias END AS title FROM assets WHERE project_id = ? ${includeArchived ? '' : 'AND deleted_at IS NULL'} ORDER BY created_at DESC, id`,
    ],
    [
      'conversation',
      'tasks',
      `SELECT id, title FROM conversations WHERE project_id = ? ${includeArchived ? '' : 'AND archived_at IS NULL'} ORDER BY updated_at DESC, id`,
    ],
  ];
  for (const [kind, workspace, query] of entityQueries) {
    const entries = database
      .prepare(`${query} ${page ? '' : 'LIMIT 21'}`)
      .all(project.id) as Array<{
      id: string;
      title: string;
      rowVersion?: number;
      sceneId?: string;
      sceneDocumentId?: string;
      sceneDocumentIdsJson?: string | null;
      lifecycleStatus?: 'active' | 'archived';
    }>;
    truncated ||= entries.length > 20;
    resources.push(
      ...(page ? entries : entries.slice(0, 20)).map((entry): ProjectStructureResource => {
        const id = `${kind}:${entry.id}`;
        return {
          id,
          kind,
          title: entry.title,
          ...(entry.lifecycleStatus ? { lifecycleStatus: entry.lifecycleStatus } : {}),
          parentId: entry.sceneId ? `scene:${entry.sceneId}` : `workspace:${workspace}`,
          ...(entry.rowVersion !== undefined ? { rowVersion: entry.rowVersion } : {}),
          ...(readDocumentIds(entry.sceneDocumentIdsJson)
            ? { sceneDocumentIds: readDocumentIds(entry.sceneDocumentIdsJson) }
            : {}),
          locator: {
            workspace,
            resourceId: id,
            ...(kind === 'scene' ? { sceneId: entry.id } : {}),
            ...(kind === 'shot' ? { shotId: entry.id, sceneId: entry.sceneId } : {}),
            ...(entry.sceneDocumentId ? { sceneDocumentId: entry.sceneDocumentId } : {}),
            ...(readDocumentIds(entry.sceneDocumentIdsJson)
              ? { sceneDocumentIds: readDocumentIds(entry.sceneDocumentIdsJson) }
              : {}),
          },
        };
      }),
    );
  }
  // Bound headings globally as well as sources so the map fits the tool result budget.
  for (const document of documents) {
    if (!page && resources.length >= 120) {
      truncated = true;
      break;
    }
    const remaining = 120 - resources.length;
    const nodes = database
      .prepare(
        `SELECT id, document_id, version_id, node_kind, title, path_json FROM project_structure_nodes
      WHERE project_id = ? AND document_id = ? AND version_id = ? ORDER BY ordinal, id ${page ? '' : 'LIMIT ?'}`,
      )
      .all(
        ...[
          project.id,
          document.documentId,
          document.versionId ?? null,
          ...(!page ? [remaining + 1] : []),
        ],
      ) as NodeRow[];
    truncated ||= nodes.length > remaining;
    resources.push(
      ...(page ? nodes : nodes.slice(0, remaining)).map((node) => nodeResource(node, document)),
    );
  }
  const digest = createHash('sha256').update(project.id);
  // The preview can be truncated; revision checking must still cover omitted resources.
  for (const row of database.prepare(`${DOCUMENT_QUERY} ORDER BY d.id`).iterate(project.id))
    digest.update(JSON.stringify(row));
  for (const [, , query] of entityQueries)
    for (const row of database.prepare(query).iterate(project.id))
      digest.update(JSON.stringify(row));
  const revision = digest.digest('hex');
  if (page) {
    const offset = page.offset ?? 0;
    const limit = page.limit ?? 20;
    if (offset > 0 && !page.expectedRevision)
      throw new Error('expectedRevision is required to continue a project resource page.');
    if (page.expectedRevision && page.expectedRevision !== revision)
      throw new Error('Project resource revision changed; restart the query from offset=0.');
    const query = page.query?.toLocaleLowerCase('zh-CN');
    const matches = resources.filter(
      (resource) =>
        (!page.workspace || resource.locator.workspace === page.workspace) &&
        (!page.kind || resource.kind === page.kind) &&
        (!page.parentId || resource.parentId === page.parentId) &&
        (!query || resource.title.toLocaleLowerCase('zh-CN').includes(query)),
    );
    const selected: ProjectStructureResource[] = [];
    let bytes = 2;
    for (const resource of matches.slice(offset, offset + limit)) {
      const entryBytes =
        Buffer.byteLength(JSON.stringify(resource), 'utf8') + (selected.length ? 1 : 0);
      if (bytes + entryBytes > 8000 && selected.length) break;
      // A single unusually large locator must remain intact and reachable.
      selected.push(resource);
      bytes += entryBytes;
    }
    const nextOffset = offset + selected.length;
    return {
      version: 1,
      projectId: project.id,
      projectName: project.name,
      revision,
      resources: selected,
      offset,
      limit,
      totalResources: matches.length,
      counts: resources.reduce<Record<string, number>>((counts, resource) => {
        counts[resource.kind] = (counts[resource.kind] ?? 0) + 1;
        return counts;
      }, {}),
      truncated: nextOffset < matches.length,
      ...(nextOffset < matches.length ? { nextOffset } : {}),
    };
  }
  while (
    resources.length > WORKSPACES.length &&
    Buffer.byteLength(JSON.stringify(resources), 'utf8') > 30_000
  ) {
    resources.pop();
    truncated = true;
  }
  return {
    version: 1,
    projectId: project.id,
    projectName: project.name,
    revision,
    resources,
    truncated,
  };
}

export const RESOURCE_ARGUMENT_KEYS = [
  'resourceId',
  'structureNodeId',
  'versionId',
  'expectedRevision',
  'expectedRowVersion',
] as const;

/** Resolve directly from current project facts, independent of the bounded preview. */
export function resolveWriteResource(
  database: Database.Database,
  project: OpenProject,
  args: Record<string, unknown>,
  required = true,
  allowArchived = false,
): ProjectStructureResource | undefined {
  const resourceId = args.resourceId;
  if (resourceId === undefined) {
    if (required)
      throw new Error(
        'resourceId is required. Call project.structure.get, then choose the destination page or existing resource.',
      );
    if (
      RESOURCE_ARGUMENT_KEYS.some((key) => args[key] !== undefined) ||
      args.documentId !== undefined
    )
      throw new Error('Locator fields require resourceId from project.structure.get.');
    return undefined;
  }
  if (typeof resourceId !== 'string' || !resourceId.trim()) throw new Error('Invalid resourceId.');
  let resource: ProjectStructureResource | undefined;
  const workspace = WORKSPACES.find(([key]) => resourceId === `workspace:${key}`)?.[0];
  if (workspace) resource = workspaceResource(workspace);
  else {
    let documentId: string | undefined;
    let node: NodeRow | undefined;
    if (resourceId.startsWith('document:')) documentId = resourceId.slice('document:'.length);
    else if (resourceId.startsWith('novel-chapter:')) {
      documentId = (
        database
          .prepare(
            "SELECT document_id FROM novel_chapters WHERE project_id = ? AND id = ? AND lifecycle_status IN ('active', 'reserved')",
          )
          .get(project.id, resourceId.slice('novel-chapter:'.length)) as
          { document_id: string } | undefined
      )?.document_id;
    } else if (resourceId.startsWith('structure-node:')) {
      node = database
        .prepare(
          'SELECT id, document_id, version_id, node_kind, title, path_json FROM project_structure_nodes WHERE project_id = ? AND id = ?',
        )
        .get(project.id, resourceId.slice('structure-node:'.length)) as NodeRow | undefined;
      documentId = node?.document_id;
    }
    const row = documentId
      ? (database.prepare(`${DOCUMENT_QUERY} AND d.id = ?`).get(project.id, documentId) as
          DocumentRow | undefined)
      : undefined;
    if (
      row &&
      (allowArchived || row.lifecycle_status === 'active') &&
      (allowArchived || row.binding_status !== 'archived') &&
      (allowArchived || row.chapter_status !== 'archived')
    ) {
      resource = documentResource(row);
      if (node) {
        if (node.version_id !== row.current_version_id)
          throw new Error(
            'Structure node version is stale. Retrieve the current structure before writing.',
          );
        resource = nodeResource(node, resource);
      } else if (resourceId.startsWith('novel-chapter:'))
        resource = {
          ...resource,
          id: resourceId,
          kind: 'novel-chapter',
          locator: { ...resource.locator, resourceId },
        };
    }
  }
  if (!resource)
    throw new Error(
      'Writable resource was not found in the current project. Retrieve project.structure.get.',
    );
  if (
    args.expectedRevision !== undefined &&
    args.expectedRevision !== compileProjectResourceMap(database, project, allowArchived).revision
  )
    throw new Error(
      'Project resource revision is stale. expectedRevision must equal resourceMap.revision from project.structure.get, never structure.revision. No write occurred. Read current metadata and decide whether the intended operation still applies; do not automatically overwrite changed objects.',
    );
  for (const [argument, actual] of [
    ['documentId', resource.documentId],
    ['versionId', resource.versionId],
    ['expectedRowVersion', resource.rowVersion],
  ] as const)
    if (args[argument] !== undefined && args[argument] !== actual)
      throw new Error(`${argument} does not match resourceId.`);
  if (args.structureNodeId !== undefined) {
    const node = database
      .prepare(
        'SELECT document_id, version_id FROM project_structure_nodes WHERE project_id = ? AND id = ?',
      )
      .get(project.id, args.structureNodeId) as
      { document_id: string; version_id: string } | undefined;
    if (
      !node ||
      node.document_id !== resource.documentId ||
      node.version_id !== resource.versionId ||
      (resource.locator.structureNodeId &&
        args.structureNodeId !== resource.locator.structureNodeId)
    )
      throw new Error('structureNodeId does not match the resource document and current version.');
  }
  return resource;
}
