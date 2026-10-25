import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { validateToolArguments } from '@earendil-works/pi-ai';
import {
  MEDIA_REVIEW_DRAFT_SCHEMA,
  type MediaReviewDraft,
  type MediaReviewForm,
  type MediaReviewSummary,
  type MediaReviewSubmitParams,
  type LlmGenerationIdentity,
} from '@ai-video/contracts';
import { ProjectService } from './project-service.js';
import {
  MediaPreparationService,
  parseMediaPrepareArguments,
} from './media-preparation-service.js';
import { MediaOrchestrationService } from './media-orchestration-service.js';
import { DubbingService } from './dubbing-service.js';
import { hashAgentToolArguments } from './agent-tool-registry.js';
import { describeProductionAsset } from './production-media-view.js';
import { ProductionService } from './production-service.js';

type SourceRow = { table: 'documents' | 'scenes' | 'shots'; id: string; version: string | number };
type Row = {
  id: string;
  project_id: string;
  conversation_id: string;
  task_id: string | null;
  draft_json: string;
  source_rows_json: string;
  draft_hash: string;
  status: MediaReviewForm['status'];
  job_id: string | null;
  error: string | null;
  row_version: number;
  created_at: string;
};
type Owner = { conversationId: string; taskId?: string };

/** Stores review intent only. Generation is delegated to the existing media/dubbing services. */
export class MediaReviewService {
  constructor(
    private readonly projects: ProjectService,
    private readonly media: Pick<
      MediaPreparationService,
      'selectionContext' | 'selectionRequest' | 'prepareSelected' | 'getTask'
    >,
    private readonly submission: Pick<
      MediaOrchestrationService,
      'requestSubmission' | 'confirmSubmission'
    >,
    private readonly dubbing: Pick<
      DubbingService,
      'scene' | 'listVoices' | 'saveCue' | 'generateTake'
    >,
  ) {}

  prepare(raw: unknown, owner: Owner): MediaReviewForm {
    const draft = this.completeBoundImageReferences(validateDraft(raw));
    if (draft.kind !== 'audio') parseMediaPrepareArguments(draft.kind, this.arguments(draft, []));
    const expected = draft.expectedRowVersion;
    delete draft.expectedRowVersion;
    return this.projects.access(true, (db, project) =>
      db.transaction(() => {
        if (
          !db
            .prepare(
              'SELECT 1 FROM conversations WHERE id=? AND project_id=? AND archived_at IS NULL',
            )
            .get(owner.conversationId, project.id)
        )
          throw new Error('审核表单会话不属于当前项目。');
        const existing = db
          .prepare(
            'SELECT * FROM production_review_forms WHERE project_id=? AND conversation_id=? AND form_key=?',
          )
          .get(project.id, owner.conversationId, draft.key) as Row | undefined;
        const sources = this.captureSources(db, project.id, draft);
        const digest = hashAgentToolArguments(draft);
        if (
          existing?.draft_hash === digest &&
          existing.source_rows_json === JSON.stringify(sources) &&
          existing.status !== 'cancelled'
        )
          return this.describe(existing);
        if (existing && (existing.status !== 'pending' || expected !== existing.row_version))
          throw new Error(
            '此表单已存在或版本已变化；请读取后使用当前 expectedRowVersion 更新待审核表单。',
          );
        for (const ref of draft.inputReferences ?? []) {
          if ('reviewFormId' in ref) {
            const dependency = this.row(ref.reviewFormId);
            if (
              dependency.id === existing?.id ||
              dependency.conversation_id !== owner.conversationId ||
              (JSON.parse(dependency.draft_json) as MediaReviewDraft).kind !== 'image' ||
              dependency.status === 'cancelled'
            )
              throw new Error('参考图依赖必须是同会话的其他有效图片表单。');
            this.assertAcyclic(dependency, existing?.id, new Set());
          } else this.assertImage(db, project.id, ref.assetId);
        }
        const id = existing?.id ?? randomUUID();
        const now = new Date().toISOString();
        if (existing)
          db.prepare(
            `UPDATE production_review_forms SET draft_json=?,source_rows_json=?,draft_hash=?,error=NULL,row_version=row_version+1,updated_at=? WHERE id=?`,
          ).run(JSON.stringify(draft), JSON.stringify(sources), digest, now, id);
        else
          db.prepare(
            `INSERT INTO production_review_forms(id,project_id,conversation_id,task_id,form_key,draft_json,source_rows_json,draft_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
          ).run(
            id,
            project.id,
            owner.conversationId,
            owner.taskId ?? null,
            draft.key,
            JSON.stringify(draft),
            JSON.stringify(sources),
            digest,
            now,
            now,
          );
        return this.get(id);
      })(),
    );
  }

  /**
   * A review form is the final user-facing media boundary. When it targets a
   * saved shot or scene, carry every currently selected character/scene/prop
   * image into that form automatically. The Agent still owns the prompt and
   * ordering intent; the Worker only fills missing, real asset references from
   * the saved binding projection, never candidates or disabled bindings.
   */
  private completeBoundImageReferences(draft: MediaReviewDraft): MediaReviewDraft {
    if (draft.kind === 'audio' || (!draft.shotId && !draft.sceneId)) return draft;
    const target = draft.shotId
      ? { kind: 'shot' as const, id: draft.shotId }
      : { kind: 'scene' as const, id: draft.sceneId! };
    const media = new ProductionService(this.projects).readMediaForAgent(target);
    // Keep the same order used by production defaults (materials first, then
    // cast) and append only bindings that are not represented there, such as
    // continuity frames. The review form stores IDs, so this order is the only
    // stable link between prompt image numbering and actual inputs.
    const orderedBoundIds = [
      ...media.inputs.referenceImages.map((image) => image.assetId),
      ...media.bindings.flatMap((binding) => {
        if (binding.selectionSource === 'disabled' || !binding.selectedAsset) return [];
        return binding.selectedAsset.availability === 'not-found'
          ? []
          : [binding.selectedAsset.assetId];
      }),
    ];
    const boundIds = [...new Set(orderedBoundIds)];
    const references = [...(draft.inputReferences ?? [])];
    const existing = new Set(
      references.flatMap((reference) => ('assetId' in reference ? [reference.assetId] : [])),
    );
    for (const assetId of boundIds) {
      if (!existing.has(assetId)) {
        references.push({ assetId });
        existing.add(assetId);
      }
    }
    if (references.length > 7)
      throw new Error('当前镜头绑定的参考图片超过 7 张，请拆分镜头或减少绑定后再准备表单。');
    return references.length ? { ...draft, inputReferences: references } : draft;
  }

  list(conversationId?: string): MediaReviewSummary[] {
    return this.projects.access(false, (db, project) => {
      const rows = (
        conversationId
          ? db
              .prepare(
                'SELECT * FROM production_review_forms WHERE project_id=? AND conversation_id=? ORDER BY created_at,id',
              )
              .all(project.id, conversationId)
          : db
              .prepare(
                'SELECT * FROM production_review_forms WHERE project_id=? ORDER BY created_at,id',
              )
              .all(project.id)
      ) as Row[];
      return rows.map((row) => {
        const { draft, ...form } = this.describe(row, false);
        return {
          ...form,
          draft: {
            key: draft.key,
            label: draft.label,
            kind: draft.kind,
            shotId: draft.shotId,
            sceneId: draft.sceneId,
            sourceDocumentId: draft.sourceDocumentId,
            inputReferences: draft.inputReferences,
          },
        };
      });
    });
  }

  get(id: string): MediaReviewForm {
    return this.describe(this.row(id));
  }

  readAudio(sceneId: string) {
    const scene = this.dubbing.scene(sceneId);
    return {
      sceneId,
      voices: scene.voices.map(({ id, characterDocumentId, voiceId, model, versionId }) => ({
        id,
        characterDocumentId,
        voiceId,
        model,
        versionId,
      })),
      cues: scene.cues
        .slice(0, 20)
        .map(({ id, shotId, speakerKind, characterDocumentId, text, rowVersion }) => ({
          id,
          shotId,
          speakerKind,
          characterDocumentId,
          text: text.slice(0, 1000),
          rowVersion,
        })),
      totalCueCount: scene.cues.length,
      truncated: scene.cues.length > 20 || scene.cues.some((cue) => cue.text.length > 1000),
      audioFiles: scene.audioFiles.slice(0, 60).map(({ id, kind, durationMs, deletedAt }) => ({
        id,
        kind,
        durationMs,
        deleted: Boolean(deletedAt),
      })),
      jobs: scene.jobs.slice(0, 30).map(({ id, kind, status }) => ({ id, kind, status })),
    };
  }

  cancel(id: string, version: number): MediaReviewForm {
    return this.projects.access(true, (db, project) => {
      const result = db
        .prepare(
          "UPDATE production_review_forms SET status='cancelled',row_version=row_version+1,updated_at=? WHERE id=? AND project_id=? AND status='pending' AND row_version=?",
        )
        .run(new Date().toISOString(), id, project.id, version);
      if (!result.changes) throw new Error('表单已提交、取消或版本已变化。');
      return this.get(id);
    });
  }

  async submit(params: MediaReviewSubmitParams): Promise<MediaReviewForm> {
    const session = this.projects.currentSessionId();
    const staged = this.projects.access(true, (db) =>
      db.transaction(() => {
        const row = this.row(params.formId);
        // Replays return the existing job, including an uncertain submission. Never charge twice.
        if (row.status === 'submitted' || row.status === 'submitting') return { id: row.id };
        if (row.status !== 'pending' || row.row_version !== params.expectedRowVersion)
          throw new Error('审核表单版本已变化，请刷新。');
        const form = this.describe(row);
        if (form.blockers.length) throw new Error(form.blockers.join('\n'));
        if (!params.reviewToken || params.reviewToken !== form.reviewToken)
          throw new Error('参考图、模型合同或音色已变化，请重新打开审核表单。');
        const draft = form.draft;
        if (draft.kind === 'audio') {
          const audio = validateDraft({ ...draft, audio: params.audio ?? draft.audio }).audio!;
          if (
            audio.sceneId !== draft.audio?.sceneId ||
            audio.shotId !== draft.audio?.shotId ||
            audio.characterDocumentId !== draft.audio?.characterDocumentId ||
            audio.speakerKind !== draft.audio?.speakerKind
          )
            throw new Error('音频的场次、镜头和说话者已冻结，不能在提交时换成其他对象。');
          const cue = this.dubbing.saveCue(audio);
          const job = this.dubbing.generateTake({
            cueId: cue.id,
            expectedRowVersion: cue.rowVersion,
            costAcknowledged: true,
          });
          db.prepare(
            "UPDATE production_review_forms SET status='submitted',job_id=?,row_version=row_version+1,updated_at=? WHERE id=?",
          ).run(job.id, new Date().toISOString(), row.id);
          return { id: row.id };
        }
        if (!params.selection) throw new Error('请选择模型并审核生成参数。');
        const identity = this.identity(row);
        const context = this.context(row, form.inputAssetIds);
        const prepared = this.media.prepareSelected(context, params.selection, identity);
        const submission = this.submission.requestSubmission({ jobId: prepared.draftId });
        db.prepare(
          "UPDATE production_review_forms SET status='submitting',job_id=?,row_version=row_version+1,updated_at=? WHERE id=?",
        ).run(prepared.draftId, new Date().toISOString(), row.id);
        return { id: row.id, submission };
      })(),
    );
    if ('submission' in staged && staged.submission) {
      let error: string | undefined;
      try {
        if (staged.submission.confirmation)
          await this.submission.confirmSubmission({
            jobId: staged.submission.job.id,
            confirmationToken: staged.submission.confirmation.confirmationToken,
            approved: true,
          });
      } catch (reason) {
        error = reason instanceof Error ? reason.message : String(reason);
      }
      if (this.projects.currentSessionId() !== session)
        throw new Error('提交期间项目会话已变化；原任务不会重复提交。');
      this.projects.access(true, (db) =>
        db
          .prepare(
            "UPDATE production_review_forms SET status='submitted',error=?,row_version=row_version+1,updated_at=? WHERE id=? AND status='submitting'",
          )
          .run(error ?? null, new Date().toISOString(), staged.id),
      );
    }
    return this.get(staged.id);
  }

  private row(id: string): Row {
    return this.projects.access(false, (db, project) => {
      const row = db
        .prepare('SELECT * FROM production_review_forms WHERE id=? AND project_id=?')
        .get(id, project.id) as Row | undefined;
      if (!row) throw new Error('审核表单不存在或不属于当前项目。');
      return row;
    });
  }

  private identity(row: Row): LlmGenerationIdentity {
    // Deferred forms are project-owned; generation lifetime is not their lifetime.
    return {
      projectId: row.project_id,
      projectSessionId: this.projects.currentSessionId()!,
      conversationId: row.conversation_id,
      generationId: row.id,
      attemptId: row.id,
    };
  }

  private context(row: Row, ids: string[]) {
    const draft = JSON.parse(row.draft_json) as MediaReviewDraft;
    if (draft.kind === 'audio') throw new Error('Audio uses the dubbing service.');
    return this.media.selectionContext(
      draft.kind,
      this.arguments(draft, ids),
      this.identity(row),
      false,
    );
  }

  private arguments(draft: MediaReviewDraft, ids: string[]) {
    return {
      prompt: draft.prompt,
      inputAssetIds: ids,
      parameters: draft.parameters ?? {},
      ...(draft.shotId ? { shotId: draft.shotId } : {}),
      ...(draft.sceneId && !draft.shotId ? { sceneId: draft.sceneId } : {}),
      ...(draft.assetKind ? { assetKind: draft.assetKind } : {}),
      ...(draft.kind === 'image' && draft.sourceDocumentId
        ? { sourceDocumentId: draft.sourceDocumentId }
        : {}),
    };
  }

  private describe(row: Row, includeSelection = true): MediaReviewForm {
    const draft = JSON.parse(row.draft_json) as MediaReviewDraft;
    const blockers: string[] = [];
    const inputAssetIds: string[] = [];
    this.projects.access(false, (db, project) => {
      try {
        this.assertSources(db, project.id, JSON.parse(row.source_rows_json) as SourceRow[]);
      } catch (reason) {
        blockers.push(String((reason as Error).message));
      }
      for (const ref of draft.inputReferences ?? []) {
        try {
          let assetId: string;
          if ('assetId' in ref) assetId = ref.assetId;
          else {
            const dependency = this.row(ref.reviewFormId);
            if (!dependency.job_id || dependency.status !== 'submitted')
              throw new Error(`等待参考图表单 ${ref.reviewFormId} 提交并完成。`);
            const task = this.media.getTask(dependency.job_id);
            assetId = task.resultAssetIds[ref.resultIndex]!;
            if (!assetId)
              throw new Error(
                `参考图表单 ${ref.reviewFormId} 尚无第 ${ref.resultIndex + 1} 张结果（${task.state}）。`,
              );
          }
          this.assertImage(db, project.id, assetId);
          inputAssetIds.push(assetId);
        } catch (reason) {
          blockers.push((reason as Error).message);
        }
      }
    });
    let selectionRequest: MediaReviewForm['selectionRequest'];
    let voices: MediaReviewForm['voices'];
    let reviewToken: string | undefined;
    if (includeSelection && row.status === 'pending' && !blockers.length) {
      try {
        if (draft.kind === 'audio')
          voices = this.dubbing
            .listVoices()
            .filter((voice) => voice.characterDocumentId === draft.audio?.characterDocumentId);
        else {
          const context = this.context(row, inputAssetIds);
          reviewToken = hashAgentToolArguments({
            formId: row.id,
            rowVersion: row.row_version,
            context,
          });
          selectionRequest = this.media.selectionRequest(
            context,
            reviewToken,
            '9999-12-31T23:59:59.999Z',
          );
        }
        if (draft.kind === 'audio')
          reviewToken = hashAgentToolArguments({
            formId: row.id,
            rowVersion: row.row_version,
            voices,
          });
      } catch (reason) {
        blockers.push((reason as Error).message);
      }
    }
    return {
      id: row.id,
      projectId: row.project_id,
      conversationId: row.conversation_id,
      taskId: row.task_id ?? undefined,
      draft,
      status: row.status,
      rowVersion: row.row_version,
      jobId: row.job_id ?? undefined,
      blockers,
      inputAssetIds,
      selectionRequest,
      voices,
      reviewToken,
      error: row.error ?? undefined,
      createdAt: row.created_at,
    };
  }

  private assertImage(db: Database.Database, projectId: string, id: string) {
    const asset = describeProductionAsset(db, projectId, this.projects.current()!.rootPath, id);
    if (asset.availability !== 'available' || asset.kind?.includes('video'))
      throw new Error(`参考图片 ${id} 不可用（${asset.availability}）。`);
  }

  private captureSources(
    db: Database.Database,
    projectId: string,
    draft: MediaReviewDraft,
  ): SourceRow[] {
    if (draft.kind === 'audio' && (!draft.audio || draft.inputReferences?.length))
      throw new Error('音频表单必须提供台词且不能引用图片。');
    if (draft.kind !== 'audio' && draft.audio) throw new Error('图片或视频表单不能包含音频台词。');
    const sources: SourceRow[] = [];
    const sceneId = draft.audio?.sceneId ?? draft.sceneId;
    const shotId = draft.audio?.shotId ?? draft.shotId;
    if (draft.sourceVersionId && !draft.sourceDocumentId) throw new Error('源版本缺少文档 ID。');
    if (draft.sourceDocumentId) {
      const doc = db
        .prepare(
          "SELECT d.current_version_id AS version,d.kind FROM documents d WHERE d.id=? AND d.project_id=? AND d.lifecycle_status='active' AND NOT EXISTS(SELECT 1 FROM document_bindings b WHERE b.document_id=d.id AND b.domain_scope='novel' AND b.status<>'archived')",
        )
        .get(draft.sourceDocumentId, projectId) as { version: string; kind: string } | undefined;
      if (!doc?.version || (draft.sourceVersionId && doc.version !== draft.sourceVersionId))
        throw new Error('制作源文档不可用或版本已变化。');
      if (
        draft.kind === 'image' &&
        ['character', 'scene', 'prop'].includes(draft.assetKind ?? '') &&
        doc.kind !== draft.assetKind
      )
        throw new Error('素材类型必须与角色/场景/道具文档类型一致。');
      draft.sourceVersionId = doc.version;
      sources.push({ table: 'documents', id: draft.sourceDocumentId, version: doc.version });
    }
    if (sceneId) {
      const scene = db
        .prepare('SELECT row_version AS version FROM scenes WHERE id=? AND project_id=?')
        .get(sceneId, projectId) as { version: number } | undefined;
      if (!scene) throw new Error('场次不属于当前项目。');
      sources.push({ table: 'scenes', id: sceneId, version: scene.version });
    }
    if (shotId) {
      const shot = db
        .prepare(
          'SELECT s.row_version AS version,s.scene_id FROM shots s JOIN scenes c ON c.id=s.scene_id WHERE s.id=? AND c.project_id=?',
        )
        .get(shotId, projectId) as { version: number; scene_id: string } | undefined;
      if (!shot || (sceneId && shot.scene_id !== sceneId))
        throw new Error('镜头不属于当前项目或指定场次。');
      sources.push({ table: 'shots', id: shotId, version: shot.version });
    }
    if (draft.audio?.characterDocumentId) {
      const character = db
        .prepare(
          "SELECT current_version_id AS version FROM documents WHERE id=? AND project_id=? AND kind='character' AND lifecycle_status='active'",
        )
        .get(draft.audio.characterDocumentId, projectId) as { version: string } | undefined;
      if (!character?.version) throw new Error('音频说话者不是当前项目的角色。');
      sources.push({
        table: 'documents',
        id: draft.audio.characterDocumentId,
        version: character.version,
      });
    }
    if (draft.audio?.speakerKind === 'character' && !draft.audio.characterDocumentId)
      throw new Error('角色配音必须声明真实角色。');
    return sources;
  }

  private assertSources(db: Database.Database, projectId: string, sources: SourceRow[]) {
    for (const source of sources) {
      const row =
        source.table === 'documents'
          ? db
              .prepare(
                "SELECT current_version_id AS version FROM documents WHERE id=? AND project_id=? AND lifecycle_status='active'",
              )
              .get(source.id, projectId)
          : source.table === 'scenes'
            ? db
                .prepare('SELECT row_version AS version FROM scenes WHERE id=? AND project_id=?')
                .get(source.id, projectId)
            : db
                .prepare(
                  'SELECT s.row_version AS version FROM shots s JOIN scenes c ON c.id=s.scene_id WHERE s.id=? AND c.project_id=?',
                )
                .get(source.id, projectId);
      if (!row || (row as { version: unknown }).version !== source.version)
        throw new Error('源文档、场次或镜头已变化，请重新准备该表单。');
    }
  }

  private assertAcyclic(row: Row, targetId: string | undefined, visited: Set<string>) {
    if (row.id === targetId || visited.has(row.id)) throw new Error('参考图表单不能形成循环依赖。');
    visited.add(row.id);
    const draft = JSON.parse(row.draft_json) as MediaReviewDraft;
    for (const ref of draft.inputReferences ?? [])
      if ('reviewFormId' in ref)
        this.assertAcyclic(this.row(ref.reviewFormId), targetId, new Set(visited));
  }
}

function validateDraft(raw: unknown): MediaReviewDraft {
  if (Buffer.byteLength(JSON.stringify(raw) ?? '', 'utf8') > 65536)
    throw new Error('审核表单超过 64 KiB。');
  const value: unknown = validateToolArguments(
    {
      name: 'media.review.prepare',
      description: 'Prepare review form.',
      parameters: MEDIA_REVIEW_DRAFT_SCHEMA,
    },
    {
      type: 'toolCall',
      id: 'validate',
      name: 'media.review.prepare',
      arguments: raw as Record<string, unknown>,
    },
  );
  return structuredClone(value) as MediaReviewDraft;
}
