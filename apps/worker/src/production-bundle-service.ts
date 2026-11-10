import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { AgentContextStore, AgentExecutionStore, contextContentHash } from '@ai-video/persistence';
import {
  type PromptBindingIR,
  type ProductionBundleDocument,
  type ProductionBundleRef,
  type ProductionBundleScene,
  type ProductionBundleShot,
} from '@ai-video/contracts';
import type { ProjectService } from './project-service.js';
import type { ContentService } from './content-service.js';
import type { DocumentWorkflowService } from './document-workflow-service.js';
import type { AgentSystemToolIdentity } from './agent-system-tool-service.js';
import {
  assertBundleInputs,
  bundleObjects,
  bundleTask,
  committedBundle,
  loadBundle,
  retiredBundleStatus,
  stageBundle,
} from './production-bundle-state.js';
import { bundleFingerprint, checkBundle, bundleCheckPage } from './production-bundle-validation.js';
import { validateBundleOperation } from './production-bundle-schema.js';
import { submitBundle } from './production-bundle-submission.js';
type SavedObject = {
  key: string;
  kind: 'document' | 'scene' | 'shot';
  id: string;
  rowVersion: number;
  versionId?: string;
  hash: string;
  expected: Record<string, unknown>;
};
type SavedManifest = {
  fingerprint: string;
  objects: SavedObject[];
  sources: unknown[];
  requirementsHash: string;
  committedAt: string;
};
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
const hash = (v: unknown) => contextContentHash(canonical(v));
/** One bounded local transaction; no provider, media, or publication calls. */
export class ProductionBundleService {
  constructor(
    private projects: ProjectService,
    private content: ContentService,
    private documents: DocumentWorkflowService,
    private serialize: (value: unknown) => string,
  ) {}
  execute(
    args: Record<string, unknown>,
    identity: AgentSystemToolIdentity,
    submission = false,
  ): Record<string, unknown> {
    if (!submission) validateBundleOperation(args);
    if (!identity.taskId || !identity.toolCallId) throw new Error('BUNDLE_TASK_REQUIRED');
    return this.projects.access(true, (db, project) => {
      if (
        identity.projectId !== project.id ||
        identity.projectSessionId !== this.projects.currentSessionId()
      )
        throw new Error('BUNDLE_PROJECT_SESSION_CONFLICT');
      const oldUpdatedAt = project.updatedAt,
        startedAt = new Date().toISOString(),
        start = performance.now();
      try {
        const run = () => {
          bundleTask(db, project.id, identity.taskId!, true);
          const step = db
            .prepare('SELECT provider_step_id FROM agent_tool_calls WHERE id=? AND task_id=?')
            .get(identity.toolCallId, identity.taskId) as
            | {
                provider_step_id: string;
              }
            | undefined;
          const commitAndReadback = (expectedRevision: number, submitted?: unknown) => {
            const saved = JSON.parse(
              new AgentExecutionStore(db).execute(
                {
                  projectId: project.id,
                  taskId: identity.taskId!,
                  operationKey: 'production-bundle:commit',
                  toolName: 'production.bundle',
                },
                { operation: 'commit', expectedRevision },
                () => this.commit(db, project.id, identity.taskId!, { expectedRevision }),
                this.serialize,
              ),
            ) as Record<string, unknown>;
            const readback = readbackBundle(db, project.id, identity.taskId!, true);
            return {
              ...saved,
              ...readback,
              ...(submitted !== undefined ? { submission: submitted } : {}),
              status: readback.status,
              readbackVerified: readback.verified,
            };
          };
          if (submission) {
            const submitted = submitBundle(
              db,
              project.id,
              identity.taskId!,
              args,
              step?.provider_step_id,
            );
            const state = loadBundle(db, project.id, identity.taskId!);
            if (!state || state.sealedRevision !== state.revision) return submitted;
            const check = checkBundle(db, project.id, identity.taskId!);
            if (!check.structureReady)
              return { ...submitted, structureCheck: bundleCheckPage(check), businessSaved: false };
            return commitAndReadback(state.revision, submitted);
          }
          if (args.operation === 'commit') return commitAndReadback(Number(args.expectedRevision));
          if (args.operation === 'check') {
            const state = loadBundle(db, project.id, identity.taskId!);
            if (state && (state.sealedRevision !== state.revision || !state.manifest))
              return bundleCompletion(db, project.id, identity.taskId!)[0]!;
            const check = checkBundle(db, project.id, identity.taskId!);
            if (state && check.structureReady && !committedBundle(db, project.id, identity.taskId!))
              return commitAndReadback(state.revision);
            return bundleCheckPage(check, Number(args.offset ?? 0));
          }
          if (args.operation === 'readback')
            return readbackBundle(db, project.id, identity.taskId!, true);
          if (args.operation === 'saved')
            return readSavedBundle(db, project.id, identity.taskId!, args);
          const result = stageBundle(
            db,
            project.id,
            identity.taskId!,
            args,
            step?.provider_step_id,
          );
          if (args.operation === 'source' || args.operation === 'seal') {
            const state = loadBundle(db, project.id, identity.taskId!);
            if (state && state.sealedRevision === state.revision && state.manifest) {
              const check = checkBundle(db, project.id, identity.taskId!);
              if (check.structureReady && !committedBundle(db, project.id, identity.taskId!)) {
                const committed = commitAndReadback(state.revision);
                return args.operation === 'source' ? { ...result, commit: committed } : committed;
              }
            }
          }
          return result;
        };
        return db.transaction(() => {
          const result = run();
          const serialized = this.serialize(result);
          recordMetric(
            db,
            project.id,
            identity.taskId!,
            submission ? 'submit' : String(args.operation),
            startedAt,
            performance.now() - start,
            'succeeded',
          );
          return JSON.parse(serialized) as Record<string, unknown>;
        })();
      } catch (error) {
        project.updatedAt = oldUpdatedAt;
        recordMetric(
          db,
          project.id,
          identity.taskId!,
          submission ? 'submit' : String(args.operation),
          startedAt,
          performance.now() - start,
          'failed',
        );
        throw error;
      }
    });
  }
  private commit(
    db: Database.Database,
    projectId: string,
    taskId: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const state = loadBundle(db, projectId, taskId);
    if (!state || state.revision !== args.expectedRevision)
      throw new Error('BUNDLE_REVISION_CONFLICT');
    assertBundleInputs(db, projectId, taskId, state);
    const check = checkBundle(db, projectId, taskId);
    if (!check.structureReady)
      throw new Error(
        'BUNDLE_STRUCTURE_REQUIRED: Correct structural fields and frozen-source or target-version conflicts before saving. No content review or business writes occurred.',
      );
    const objects = bundleObjects(db, projectId, taskId, state);
    const ids = new Map(
      state.entries.map((e) => [e.key, objects.get(e.key)!.existing?.id ?? randomUUID()]),
    );
    const resolve = (ref: ProductionBundleRef) =>
      'existingId' in ref ? ref.existingId : ids.get(ref.localKey)!;
    const resolveBindings = (
      value: PromptBindingIR<ProductionBundleRef> | undefined,
    ): PromptBindingIR | undefined =>
      value && {
        schemaVersion: 1,
        ...Object.fromEntries(
          ['characterDocumentIds', 'sceneDocumentIds', 'propDocumentIds'].flatMap((field) => {
            const refs = value[field as 'characterDocumentIds'];
            return refs === undefined ? [] : [[field, refs.map(resolve)]];
          }),
        ),
        ...(value.voiceDocumentId ? { voiceDocumentId: resolve(value.voiceDocumentId) } : {}),
        ...(value.voiceBindings
          ? {
              voiceBindings: value.voiceBindings.map((pair) => ({
                ...(pair.characterDocumentId
                  ? { characterDocumentId: resolve(pair.characterDocumentId) }
                  : {}),
                voiceDocumentId: resolve(pair.voiceDocumentId),
              })),
            }
          : {}),
      };
    const saved: SavedObject[] = [];
    // Voice documents precede characters so strongly typed default references exist.
    const entries = [...state.entries].sort(
      (a, b) =>
        Number((objects.get(b.key) as ProductionBundleDocument).kind === 'voice') -
        Number((objects.get(a.key) as ProductionBundleDocument).kind === 'voice'),
    );
    for (const entry of entries.filter((e) => e.kind === 'document')) {
      const d = objects.get(entry.key) as ProductionBundleDocument;
      const bindings = resolveBindings(d.bindings);
      const previous = d.existing
        ? this.documents.getDocument(d.existing.id).currentVersion
        : undefined;
      const expected = {
        kind: d.kind,
        title: d.title,
        contentMarkdown: d.contentMarkdown,
        sampleText: d.sampleText ?? previous?.sampleText ?? null,
        bindings: bindings ?? previous?.bindings ?? null,
        sourceTaskId: taskId,
      };
      const output = this.documents.saveDraft(
        {
          ...(d.existing
            ? {
                documentId: d.existing.id,
                expectedDocumentRowVersion: d.existing.rowVersion,
                baseVersionId: d.existing.versionId,
              }
            : {}),
          kind: d.kind,
          title: d.title,
          contentMarkdown: d.contentMarkdown,
          bindings,
          sampleText: d.sampleText,
          sourceTaskId: taskId,
          authorType: 'agent',
        },
        d.existing ? undefined : { newId: ids.get(d.localKey)! },
      );
      saved.push({
        key: d.localKey,
        kind: 'document',
        id: output.id,
        rowVersion: output.rowVersion,
        versionId: output.currentVersion!.id,
        hash: hash(expected),
        expected,
      });
      db.prepare(
        'INSERT INTO agent_task_document_versions(task_id,document_id,document_version_id,operation,created_at) VALUES(?,?,?,?,?)',
      ).run(
        taskId,
        output.id,
        output.currentVersion!.id,
        d.existing ? 'update' : 'create',
        output.currentVersion!.createdAt,
      );
    }
    for (const key of state.manifest!.sceneKeys) {
      const s = objects.get(key) as ProductionBundleScene;
      const previous = s.existing
        ? this.content.listScenes().find((item) => item.id === s.existing!.id)
        : undefined;
      const output = this.content.saveScene(
        {
          ...(s.existing
            ? { sceneId: s.existing.id, expectedRowVersion: s.existing.rowVersion }
            : {}),
          title: s.title,
          prompt: s.prompt,
          timing: s.timing,
          bindings: resolveBindings(s.bindings),
        },
        s.existing ? undefined : { newId: ids.get(key)! },
      );
      const expected = {
        kind: 'scene',
        title: s.title,
        position: output.position,
        prompt: s.prompt ?? previous?.prompt ?? null,
        timing: s.timing ?? previous?.timing ?? null,
        bindings: resolveBindings(s.bindings) ?? previous?.bindings ?? null,
      };
      saved.push({
        key,
        kind: 'scene',
        id: output.id,
        rowVersion: output.rowVersion,
        hash: hash(expected),
        expected,
      });
    }
    for (const key of state.manifest!.shotKeys) {
      const s = objects.get(key) as ProductionBundleShot;
      const fields = { prompt: s.prompt, timing: s.timing, bindings: resolveBindings(s.bindings)! };
      const sceneId = ids.get(s.sceneKey)!;
      const output = this.content.saveShot(
        {
          ...(s.existing
            ? { shotId: s.existing.id, expectedRowVersion: s.existing.rowVersion }
            : {}),
          sceneId,
          title: s.title,
          ...fields,
        },
        s.existing ? undefined : { newId: ids.get(key)! },
      );
      const expected = {
        kind: 'shot',
        title: s.title,
        sceneId,
        position: output.position,
        ...fields,
        timing: output.timing ?? null,
      };
      saved.push({
        key,
        kind: 'shot',
        id: output.id,
        rowVersion: output.rowVersion,
        hash: hash(expected),
        expected,
      });
    }
    const manifest: SavedManifest = {
      fingerprint: bundleFingerprint(state),
      objects: saved,
      sources: state.sources,
      requirementsHash: state.requirementsHash,
      committedAt: new Date().toISOString(),
    };
    const result = new AgentContextStore(db).putResult(
      projectId,
      taskId,
      'production-bundle:saved',
      'production.bundle.committed',
      JSON.stringify(manifest),
    );
    return {
      status: 'bundle_committed',
      bundleId: taskId,
      revision: state.revision,
      mappingResultId: result.id,
      objectCount: saved.length,
      counts: counts(saved),
      businessSaved: true,
      readbackVerified: false,
      instruction:
        'Business drafts are saved; the Worker independently reads back text, timing, versions and bindings. operation=saved pages actual IDs and editable targets. Do not create another package.',
    };
  }
}
function counts(objects: SavedObject[]) {
  return Object.fromEntries(
    ['character', 'scene', 'prop', 'voice', 'plan', 'shot', 'storyScene'].map((k) => [
      k,
      objects.filter((o) =>
        k === 'shot'
          ? o.kind === 'shot'
          : k === 'storyScene'
            ? o.kind === 'scene'
            : o.kind === 'document' && o.expected.kind === k,
      ).length,
    ]),
  );
}
function savedManifest(
  db: Database.Database,
  projectId: string,
  taskId: string,
): SavedManifest | undefined {
  const receipt = committedBundle(db, projectId, taskId);
  if (!receipt || typeof receipt.mappingResultId !== 'string') return undefined;
  const result = new AgentContextStore(db).result(projectId, taskId, receipt.mappingResultId);
  if (!result || result.toolName !== 'production.bundle.committed')
    throw new Error('BUNDLE_COMMIT_MANIFEST_MISSING');
  return JSON.parse(result.content) as SavedManifest;
}
export function bundleSavedObjects(db: Database.Database, projectId: string, taskId: string) {
  return savedManifest(db, projectId, taskId)?.objects ?? [];
}
export function bundleReadbackRecorded(
  db: Database.Database,
  projectId: string,
  taskId: string,
): boolean {
  if (retiredBundleStatus(db, projectId, taskId)) return false;
  const state = loadBundle(db, projectId, taskId);
  if (!state || !committedBundle(db, projectId, taskId)) return false;
  const result = new AgentContextStore(db).resultForCall(
    projectId,
    taskId,
    `production-bundle:readback:${bundleFingerprint(state)}`,
  );
  if (
    !result ||
    !(
      JSON.parse(result.content) as {
        verified: boolean;
      }
    ).verified
  )
    return false;
  return bundleSavedObjects(db, projectId, taskId).every((o) => {
    const row = db
      .prepare(
        o.kind === 'document'
          ? 'SELECT row_version,current_version_id FROM documents WHERE id=?'
          : `SELECT row_version FROM ${o.kind === 'scene' ? 'scenes' : 'shots'} WHERE id=?`,
      )
      .get(o.id) as
      | {
          row_version: number;
          current_version_id?: string;
        }
      | undefined;
    return row?.row_version === o.rowVersion && row.current_version_id === o.versionId;
  });
}
export function readSavedBundle(
  db: Database.Database,
  projectId: string,
  taskId: string,
  args: Record<string, unknown>,
) {
  const manifest = savedManifest(db, projectId, taskId);
  if (!manifest) throw new Error('BUNDLE_NOT_COMMITTED');
  const offset = args.offset ?? 0;
  if (
    !Number.isSafeInteger(offset) ||
    Number(offset) < 0 ||
    Number(offset) > manifest.objects.length
  )
    throw new Error('BUNDLE_INVALID_RANGE');
  const objects = manifest.objects
    .slice(Number(offset), Number(offset) + 20)
    .map(({ key, kind, id, rowVersion, versionId, hash }) => ({
      key,
      kind,
      id,
      rowVersion,
      versionId,
      hash,
    }));
  return {
    status: 'bundle_saved_objects',
    objects,
    counts: counts(manifest.objects),
    ...(Number(offset) + objects.length < manifest.objects.length
      ? { nextOffset: Number(offset) + objects.length }
      : {}),
  };
}
/** Independent SQLite reads, never the save return values or in-memory candidate map. */
export function readbackBundle(
  db: Database.Database,
  projectId: string,
  taskId: string,
  persist = false,
): Record<string, unknown> {
  const manifest = savedManifest(db, projectId, taskId),
    state = loadBundle(db, projectId, taskId);
  if (!manifest || !state) return { status: 'bundle_not_committed', verified: false };
  assertBundleInputs(db, projectId, taskId, state);
  const failures: Array<{
    key: string;
    reason: string;
  }> = [];
  if (manifest.fingerprint !== bundleFingerprint(state))
    failures.push({ key: 'bundle', reason: 'Candidate/input identity changed after commit.' });
  for (const item of manifest.objects) {
    let value: unknown, version: string | undefined, rowVersion: number | undefined;
    if (item.kind === 'document') {
      const row = db
        .prepare(
          `SELECT d.kind,d.title,d.row_version,d.current_version_id,v.content_markdown,v.bindings_json,v.sample_text,v.source_task_id,v.state FROM documents d JOIN document_versions v ON v.id=d.current_version_id AND v.document_id=d.id WHERE d.id=? AND d.project_id=? AND d.lifecycle_status='active'`,
        )
        .get(item.id, projectId) as
        | {
            kind: string;
            title: string;
            row_version: number;
            current_version_id: string;
            content_markdown: string;
            sample_text: string | null;
            bindings_json: string | null;
            source_task_id: string;
            state: string;
          }
        | undefined;
      if (row && row.state === 'draft') {
        value = {
          kind: row.kind,
          title: row.title,
          contentMarkdown: row.content_markdown,
          sampleText: row.sample_text,
          bindings: row.bindings_json ? (JSON.parse(row.bindings_json) as unknown) : null,
          sourceTaskId: row.source_task_id,
        };
        version = row.current_version_id;
        rowVersion = row.row_version;
      }
    } else {
      const row = db
        .prepare(
          item.kind === 'scene'
            ? 'SELECT title,position,row_version,video_prompt AS prompt,bindings_json,timing_json FROM scenes WHERE id=? AND project_id=? AND archived_at IS NULL'
            : 'SELECT s.title,s.position,s.row_version,s.scene_id,s.prompt,s.bindings_json,s.timing_json FROM shots s JOIN scenes c ON c.id=s.scene_id WHERE s.id=? AND c.project_id=? AND s.archived_at IS NULL AND c.archived_at IS NULL',
        )
        .get(item.id, projectId) as
        | {
            title: string;
            position: number;
            row_version: number;
            scene_id?: string;
            prompt: string | null;
            timing_json: string | null;
            bindings_json: string | null;
          }
        | undefined;
      if (row) {
        value = {
          kind: item.kind,
          title: row.title,
          ...('position' in item.expected ? { position: row.position } : {}),
          ...(item.kind === 'shot' ? { sceneId: row.scene_id } : {}),
          prompt: row.prompt,
          bindings: row.bindings_json ? (JSON.parse(row.bindings_json) as unknown) : null,
          timing: row.timing_json ? (JSON.parse(row.timing_json) as unknown) : null,
        };
        rowVersion = row.row_version;
      }
    }
    if (rowVersion !== item.rowVersion || version !== item.versionId || hash(value) !== item.hash)
      failures.push({
        key: item.key,
        reason:
          'Saved current version, text, timing or relationships differ from the committed manifest.',
      });
  }
  const result = {
    status: failures.length ? 'bundle_saved_unverified' : 'bundle_readback_verified',
    verified: !failures.length,
    businessSaved: true,
    bundleId: taskId,
    fingerprint: manifest.fingerprint,
    counts: counts(manifest.objects),
    failures,
    checkedAt: new Date().toISOString(),
  };
  if (persist)
    new AgentContextStore(db).putResult(
      projectId,
      taskId,
      `production-bundle:readback:${manifest.fingerprint}`,
      'production.bundle.readback',
      JSON.stringify(result),
    );
  return { ...result, failures: failures.slice(0, 20), failureCount: failures.length };
}
export function bundleCompletion(
  db: Database.Database,
  projectId: string,
  taskId: string,
): Array<Record<string, unknown>> {
  const retired = retiredBundleStatus(db, projectId, taskId);
  if (retired) return [retired];
  const state = loadBundle(db, projectId, taskId);
  if (!state)
    return [
      {
        key: 'production-bundle',
        nextAction: {
          toolName: 'production.bundle',
          arguments: { operation: 'begin' },
          instruction:
            'Read the v2 skill, estimate output tokens, then begin the package using the frozen selected sources.',
        },
      },
    ];
  const sealed = state.sealedRevision === state.revision && !!state.manifest;
  const check = bundleCheckPage(checkBundle(db, projectId, taskId));
  const sourceWasRead = Boolean(
    db
      .prepare(
        "SELECT 1 FROM agent_context_results WHERE project_id=? AND task_id=? AND tool_name='production.bundle.source' LIMIT 1",
      )
      .get(projectId, taskId),
  );
  if (!sealed)
    return [
      {
        key: 'production-bundle',
        ...Object.fromEntries(Object.entries(check).filter(([field]) => field !== 'nextRead')),
        nextAction:
          !state.entries.length && !sourceWasRead && state.sources[0]
            ? {
                toolName: 'production.bundle',
                arguments: {
                  operation: 'source',
                  documentId: state.sources[0].documentId,
                },
                instruction:
                  'Read the frozen source pages needed to author this package. Source reads are on demand and never a structural or commit prerequisite. Submit complete ordinary prompt objects with explicit bindings when ready.',
              }
            : state.manifest && check.errors.length
              ? {
                  toolName: 'production.bundle.submit',
                  expectedRevision: state.revision,
                  requiredFields: ['partKey', 'expectedRevision', 'prompts'],
                  repairKeys: [...new Set(check.errors.map((error) => error.key))].slice(0, 20),
                  instruction:
                    'Correct the reported structural fields by resubmitting only affected complete prompt objects under their original localKeys. Unchanged candidates remain stored. Set complete=true only when all prompt objects are present.',
                }
              : {
                  toolName: 'production.bundle.submit',
                  expectedRevision: state.revision,
                  requiredFields: ['partKey', 'expectedRevision'],
                  optionalFields: ['prompts', 'complete'],
                  instruction:
                    'Continue submitting complete ordinary prompt objects with explicit bindings. Set complete=true only when every prompt object has been submitted; the Worker then validates structure, saves atomically and independently reads the saved records back.',
                },
      },
    ];
  if (!check.structureReady)
    return [
      {
        key: 'production-bundle',
        ...check,
        nextAction: {
          toolName: 'production.bundle.submit',
          expectedRevision: state.revision,
          requiredFields: ['partKey', 'expectedRevision', 'prompts'],
          repairKeys: [...new Set(check.errors.map((error) => error.key))].slice(0, 20),
          instruction:
            'Correct only the reported structural fields. Resubmit each affected complete ordinary prompt object under its original localKey and keep unaffected candidates unchanged. The Worker reseals, validates, commits and independently reads the package back when structure passes.',
        },
      },
    ];
  const receipt = committedBundle(db, projectId, taskId);
  if (!receipt)
    return [
      {
        key: 'production-bundle',
        ...check,
        nextAction: {
          toolName: 'production.bundle',
          arguments: { operation: 'commit', expectedRevision: state.revision },
        },
      },
    ];
  const readback = new AgentContextStore(db).resultForCall(
    projectId,
    taskId,
    `production-bundle:readback:${bundleFingerprint(state)}`,
  );
  const verifiedReceipt = readback
    ? (JSON.parse(readback.content) as { verified?: boolean }).verified === true
    : false;
  if (!verifiedReceipt || !readbackBundle(db, projectId, taskId, false).verified)
    return [
      {
        key: 'production-bundle-readback',
        businessSaved: true,
        nextAction: { toolName: 'production.bundle', arguments: { operation: 'readback' } },
      },
    ];
  return [];
}
function recordMetric(
  db: Database.Database,
  projectId: string,
  taskId: string,
  operation: string,
  startedAt: string,
  durationMs: number,
  outcome: string,
) {
  new AgentContextStore(db).putResult(
    projectId,
    taskId,
    `bundle-metric:${randomUUID()}`,
    'production.bundle.metric',
    JSON.stringify({
      operation,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs,
      outcome,
      clock: 'monotonic-local',
    }),
  );
}
