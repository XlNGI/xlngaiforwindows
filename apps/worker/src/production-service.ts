import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type Database from 'better-sqlite3';
import {
  renderProductionInstruction,
  seedProductionInputs,
  addProductionRoleVoices,
  type ProductionTarget,
  type ProductionInstruction,
  type ProductionReadResult,
  type ProductionCompileParams,
  type ProductionCompileResult,
  type ProductionSource,
  type ProductionIssue,
  type AdapterParameters,
  type MediaInputReferenceV1,
  type ProductionDefaultsInfo,
  type ProductionDefaults,
} from '@ai-video/contracts';
import {
  compileProductionParameters,
  getAdapter,
  parseProductionExecution,
  inspectProductionTargetInstruction,
  parseProductionDefaults,
} from '@ai-video/generation-adapters';
import {
  compileSceneSequence,
  emptyProductionInstruction,
  inheritProductionInstruction,
  planProductionSegments,
} from './scene-production.js';
import { ContentService } from './content-service.js';
import { ProjectService, resolveProjectRelativePath } from './project-service.js';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { resolveSceneMedia } from './scene-media-service.js';
import { requireProductionCharacters } from './scene-cast-binding.js';
import { AgentDraftSubmissionService } from './agent-draft-submission-service.js';
import { createRepositories, readShotContinuity } from '@ai-video/persistence';
import type { AgentSystemToolIdentity } from './agent-system-tool-service.js';

const hash = (value: unknown) =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_, item: unknown) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
          : item,
      ),
    )
    .digest('hex');
const key = (target: ProductionTarget) => `${target.kind}:${target.id}`;
interface VersionRow {
  id: string;
  revision: number;
  instruction_json: string;
  source_hash: string;
}

/** One project store, immutable instruction history, synchronous local execution. */
export class ProductionService {
  constructor(private readonly projects: ProjectService) {}

  getDefaults(): ProductionDefaultsInfo {
    return this.projects.access(false, (db, project) => {
      const row = db
        .prepare('SELECT row_version,settings_json FROM production_defaults WHERE project_id=?')
        .get(project.id) as { row_version: number; settings_json: string } | undefined;
      return row
        ? {
            rowVersion: row.row_version,
            settings: JSON.parse(row.settings_json) as ProductionDefaults,
          }
        : { rowVersion: 0, settings: {} };
    });
  }

  saveDefaults(input: {
    expectedRowVersion: number;
    settings: ProductionDefaults;
  }): ProductionDefaultsInfo {
    const settings = parseProductionDefaults(input.settings);
    return this.projects.access(true, (db, project) =>
      db.transaction(() => {
        if (this.getDefaults().rowVersion !== input.expectedRowVersion)
          throw new Error('项目视觉设置已变化，请重新读取。');
        db.prepare(
          'INSERT INTO production_defaults(project_id,row_version,settings_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET row_version=excluded.row_version,settings_json=excluded.settings_json,updated_at=excluded.updated_at',
        ).run(
          project.id,
          input.expectedRowVersion + 1,
          JSON.stringify(settings),
          new Date().toISOString(),
        );
        return this.getDefaults();
      })(),
    );
  }

  execute(input: unknown, identity?: AgentSystemToolIdentity): Record<string, unknown> {
    const list = parseProductionExecution(input);
    if (Buffer.byteLength(JSON.stringify(list)) > 512 * 1024)
      throw new Error('制作清单超过 512 KiB。');
    return this.projects.access(true, (db, project) =>
      db.transaction(() => {
        const requestHash = hash(list);
        const previous = db
          .prepare(
            'SELECT request_hash,result_json FROM production_execution_lists WHERE project_id=? AND execution_key=?',
          )
          .get(project.id, list.executionKey) as
          { request_hash: string; result_json: string } | undefined;
        if (previous) {
          if (previous.request_hash !== requestHash) throw new Error('执行键已用于其他制作清单。');
          return JSON.parse(previous.result_json) as Record<string, unknown>;
        }
        const targets = new Set<string>();
        for (const operation of list.operations) {
          if (targets.has(key(operation.target))) throw new Error('同一清单不能重复更新同一对象。');
          targets.add(key(operation.target));
          const state = this.targetState(operation.target);
          if (state.rowVersion !== operation.expectedRowVersion)
            throw new Error('制作对象已被修改，请读取最新版本后重试。');
          requireProductionCharacters(
            db,
            project.id,
            operation.instruction.subjects.map((s) => s.documentId),
          );
          if (operation.target.kind === 'scene' || operation.target.kind === 'shot') {
            const cast =
              new ContentService(this.projects).listScenes().find((s) => s.id === state.sceneId)
                ?.characterBindings ?? [];
            if (
              operation.instruction.subjects.some(
                (subject) => !cast.some((c) => c.characterDocumentId === subject.documentId),
              )
            )
              throw new Error('制作指令包含未绑定到场次的角色，请先保存场次角色绑定。');
          }
          for (const resource of operation.instruction.resources) {
            if (
              resource.documentId &&
              !db
                .prepare(
                  "SELECT 1 FROM documents WHERE id=? AND project_id=? AND lifecycle_status='active'",
                )
                .get(resource.documentId, project.id)
            )
              throw new Error('素材需求引用了无效的项目文档。');
            if (
              resource.assetId &&
              !db
                .prepare('SELECT 1 FROM assets WHERE id=? AND project_id=? AND deleted_at IS NULL')
                .get(resource.assetId, project.id)
            )
              throw new Error('素材需求引用了无效的项目素材。');
          }
        }
        // Check the full candidate dependency graph before making any writes.
        const pending = new Map(list.operations.map((op) => [key(op.target), op.instruction]));
        for (const operation of list.operations) {
          const checked = this.inspectGraph(db, project.id, operation.target, pending);
          if (checked.issues.length)
            throw new Error(checked.issues.map((issue) => issue.message).join('\n'));
        }
        const executionId = randomUUID();
        const now = new Date().toISOString();
        db.prepare(
          'INSERT INTO production_execution_lists(id,project_id,execution_key,request_hash,request_json,result_json,created_at) VALUES(?,?,?,?,?,?,?)',
        ).run(
          executionId,
          project.id,
          list.executionKey,
          requestHash,
          JSON.stringify(list),
          '{}',
          now,
        );
        const content = new ContentService(this.projects);
        const names = this.names(db, project.id);
        const outputs = [];
        for (const operation of list.operations) {
          const { target, instruction } = operation;
          const detailIssues = inspectProductionTargetInstruction(instruction, target.kind);
          if (detailIssues.length)
            throw new Error(detailIssues.map((issue) => issue.message).join('\n'));
          const state = this.targetState(target);
          const prompt = renderProductionInstruction(instruction, names);
          if ((target.kind === 'scene' || target.kind === 'shot') && prompt.length > 20000)
            throw new Error('制作提示词超过 20000 字符，请精简指令后重试。');
          if (target.kind === 'scene') {
            const scene = content.listScenes().find((s) => s.id === target.id)!;
            content.saveScene({
              sceneId: target.id,
              title: scene.title,
              videoPrompt: prompt,
              expectedRowVersion: operation.expectedRowVersion,
            });
          } else if (target.kind === 'shot') {
            const shot = content.listShots(state.sceneId!).find((s) => s.id === target.id)!;
            content.saveShot({
              shotId: target.id,
              sceneId: state.sceneId!,
              title: shot.title,
              prompt,
              expectedRowVersion: operation.expectedRowVersion,
            });
          } else {
            const document = content.getDocument(target.id);
            const workflow = new DocumentWorkflowService(this.projects);
            if (identity) {
              new AgentDraftSubmissionService(this.projects, workflow).submit(
                'document.submit_draft',
                {
                  resourceId: `document:${document.id}`,
                  documentKind: document.kind,
                  documentId: document.id,
                  title: document.title,
                  contentMarkdown: prompt,
                  expectedDocumentRowVersion: operation.expectedRowVersion,
                  baseVersionId: document.currentVersion?.id ?? null,
                },
                identity,
                `production:${executionId}:${key(target)}`,
              );
            } else {
              workflow.saveDraft({
                documentId: document.id,
                title: document.title,
                contentMarkdown: prompt,
                expectedDocumentRowVersion: operation.expectedRowVersion,
                authorType: 'agent',
              });
            }
          }
        }
        // Snapshot the final batch state, including canonical character/setting versions.
        for (const { target, instruction } of list.operations) {
          const revision = (this.latest(db, project.id, target)?.row.revision ?? 0) + 1;
          const instructionId = randomUUID();
          db.prepare(
            'INSERT INTO production_instruction_versions(id,project_id,target_kind,target_id,revision,instruction_json,source_hash,execution_list_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
          ).run(
            instructionId,
            project.id,
            target.kind,
            target.id,
            revision,
            JSON.stringify(instruction),
            this.targetState(target).semanticHash,
            executionId,
            now,
          );
          outputs.push({
            target,
            instructionId,
            revision,
            rowVersion: this.targetState(target).rowVersion,
          });
        }
        for (const operation of list.operations) {
          const final = this.inspectGraph(db, project.id, operation.target);
          if (final.issues.length)
            throw new Error(final.issues.map((issue) => issue.message).join('\n'));
        }
        const result = { status: 'applied', executionId, operations: outputs, paidRequests: 0 };
        db.prepare('UPDATE production_execution_lists SET result_json=? WHERE id=?').run(
          JSON.stringify(result),
          executionId,
        );
        return result;
      })(),
    );
  }

  read(target: ProductionTarget, shotIds?: string[]): ProductionReadResult {
    if (
      !target ||
      !['character', 'setting', 'scene', 'shot'].includes(target.kind) ||
      typeof target.id !== 'string' ||
      !target.id.trim() ||
      target.id.length > 200 ||
      Object.keys(target).some((k) => !['kind', 'id'].includes(k))
    )
      throw new Error('制作目标无效。');
    return this.projects.access(false, (db, project) => {
      const state = this.targetState(target);
      const latest = this.latest(db, project.id, target);
      const defaults = this.getDefaults();
      const content = new ContentService(this.projects);
      const continuity =
        target.kind === 'shot' ? readShotContinuity(db, project.id, target.id) : undefined;
      const scene =
        target.kind === 'scene'
          ? content.listScenes().find((item) => item.id === target.id)
          : undefined;
      const allShots = scene ? content.listShots(scene.id) : [];
      if (shotIds) {
        const first = allShots.findIndex((shot) => shot.id === shotIds[0]);
        if (
          !scene ||
          !shotIds.length ||
          shotIds.length > 30 ||
          new Set(shotIds).size !== shotIds.length ||
          first < 0 ||
          allShots
            .slice(first, first + shotIds.length)
            .map((shot) => shot.id)
            .join('|') !== shotIds.join('|')
        )
          throw new Error('制作分段必须引用当前场次按顺序连续的真实镜头。');
      }
      const shots = (shotIds ? allShots.filter((shot) => shotIds.includes(shot.id)) : allShots).map(
        (shot) => {
          const saved = this.latest(db, project.id, { kind: 'shot', id: shot.id });
          return {
            shot,
            hasStoredInstruction: Boolean(saved),
            instruction:
              saved &&
              saved.row.source_hash === this.targetState({ kind: 'shot', id: shot.id }).semanticHash
                ? saved.instruction
                : undefined,
          };
        },
      );
      if (
        !latest &&
        !shots.length &&
        !Object.keys(defaults.settings).length &&
        !continuity?.binding
      )
        return { target, rowVersion: state.rowVersion, issues: [] };
      const { issues, dependencies } = latest
        ? this.inspectGraph(db, project.id, target)
        : { issues: [] as ProductionIssue[], dependencies: [] as unknown[] };
      const continuityAssets = continuity?.binding
        ? [
            continuity.binding.sourceVideoAssetId,
            ...continuity.binding.frames.map((frame) => frame.assetId),
            continuity.binding.firstFrameAssetId,
          ]
            .filter((id): id is string => Boolean(id))
            .map((id) => {
              const asset = createRepositories(db).assets.get(id);
              return [
                id,
                asset,
                Boolean(
                  asset &&
                  !asset.deletedAt &&
                  existsSync(resolveProjectRelativePath(project.rootPath, asset.relativePath)),
                ),
              ];
            })
        : [];
      if (continuity?.binding) {
        const binding = continuity.binding;
        const ordered = content.listShots(state.sceneId!);
        const previous = ordered[ordered.findIndex((shot) => shot.id === target.id) - 1];
        const video = createRepositories(db).assets.get(binding.sourceVideoAssetId);
        if (
          binding.targetRowVersion !== state.rowVersion ||
          previous?.id !== binding.sourceShotId ||
          video?.contentHash !== binding.sourceVideoHash ||
          continuityAssets.some((entry) => !entry[2])
        )
          issues.push({
            code: 'STALE_CONTINUITY',
            message: '衔接来源、剧情或已选画面已变化，请返回镜头重新确认选帧。',
          });
      }
      const legacyPrompt =
        scene?.videoPrompt ??
        (target.kind === 'shot'
          ? content.listShots(state.sceneId!).find((item) => item.id === target.id)?.prompt
          : ['character', 'setting'].includes(target.kind)
            ? content.getDocument(target.id).currentVersion?.contentMarkdown
            : undefined);
      let instruction =
        latest?.instruction ??
        emptyProductionInstruction(legacyPrompt ?? scene?.title ?? '制作内容');
      if (target.kind === 'shot') {
        const parent = this.latest(db, project.id, { kind: 'scene', id: state.sceneId! });
        if (parent) instruction = inheritProductionInstruction(parent.instruction, instruction);
      }
      instruction = {
        ...instruction,
        style: { ...defaults.settings.style, ...instruction.style },
        visual: { ...defaults.settings.visual, ...instruction.visual },
        generation: { ...instruction.generation },
      };
      if (shotIds) {
        const generation = { ...instruction.generation };
        delete generation.duration;
        const before = new Map(instruction.continuity.before.map((fact) => [fact.key, fact.value]));
        const locked = new Map(instruction.continuity.locked.map((fact) => [fact.key, fact.value]));
        for (const previous of allShots.slice(
          0,
          allShots.findIndex((shot) => shot.id === shotIds[0]),
        )) {
          const prior = this.latest(db, project.id, { kind: 'shot', id: previous.id })?.instruction;
          for (const fact of prior?.continuity.after ?? []) before.set(fact.key, fact.value);
          for (const fact of prior?.continuity.locked ?? []) locked.set(fact.key, fact.value);
        }
        instruction = {
          ...instruction,
          timing: undefined,
          generation,
          continuity: {
            ...instruction.continuity,
            before: [...before].map(([key, value]) => ({ key, value })),
            locked: [...locked].map(([key, value]) => ({ key, value })),
            after: shots.at(-1)?.instruction?.continuity.after ?? [],
          },
        };
      }
      const sequence = scene
        ? compileSceneSequence(scene, instruction, shots, this.names(db, project.id), {
            isSegment: Boolean(shotIds),
            sharedText:
              latest && latest.row.source_hash !== state.semanticHash
                ? scene.videoPrompt
                : undefined,
          })
        : undefined;
      if (sequence) {
        issues.push(...sequence.issues);
        for (const entry of shots)
          if (entry.hasStoredInstruction)
            issues.push(
              ...this.inspectGraph(db, project.id, { kind: 'shot', id: entry.shot.id }).issues,
            );
      }
      const referenceState = (sequence?.instruction ?? instruction).resources
        .filter((resource) => resource.assetId)
        .map((resource) => {
          const asset = db
            .prepare(
              'SELECT id,content_hash,relative_path,deleted_at FROM assets WHERE id=? AND project_id=?',
            )
            .get(resource.assetId, project.id) as
            | { id: string; content_hash: string; relative_path: string; deleted_at: string | null }
            | undefined;
          return [
            resource.assetId,
            asset,
            asset
              ? existsSync(resolveProjectRelativePath(project.rootPath, asset.relative_path))
              : false,
          ];
        });
      const source: ProductionSource = {
        target,
        instructionId: latest?.row.id ?? `aggregate:${target.kind}:${target.id}`,
        revision: latest?.row.revision ?? 1,
        token: hash([
          latest?.row.id,
          state.inputHash,
          dependencies,
          defaults,
          referenceState,
          shotIds,
          shots.map((entry) => [entry.shot, entry.instruction]),
          continuity,
          continuityAssets,
        ]),
        ...(shotIds ? { shotIds } : {}),
      };
      return {
        target,
        rowVersion: state.rowVersion,
        instruction: sequence?.instruction ?? instruction,
        ...(sequence
          ? {
              compiledPrompt: shotIds
                ? `【本次只制作下面列出的分镜；共享场次设定用于背景，后续剧情留待下一段】\n${sequence.compiledPrompt}`
                : sequence.compiledPrompt,
              timeline: sequence.timeline,
              estimatedDurationSeconds: sequence.estimatedDurationSeconds,
            }
          : {
              estimatedDurationSeconds: instruction.timing?.estimatedDurationSeconds,
              ...(latest && latest.row.source_hash !== state.semanticHash && legacyPrompt
                ? { compiledPrompt: legacyPrompt }
                : {}),
            }),
        source,
        issues,
      };
    });
  }

  compile(params: ProductionCompileParams): ProductionCompileResult {
    if (params.target.kind === 'shot' && params.inputImages === undefined) {
      const binding = this.projects.access(
        false,
        (db, project) => readShotContinuity(db, project.id, params.target.id).binding,
      );
      if (binding) {
        const isVideo = getAdapter(params.adapterKey)?.capability.endsWith('_VIDEO');
        params = {
          ...params,
          inputImages: isVideo
            ? binding.firstFrameAssetId
              ? [{ assetId: binding.firstFrameAssetId, role: 'first-frame' }]
              : []
            : binding.frames.map((frame) => ({ assetId: frame.assetId, role: 'reference' })),
        };
      }
    }
    const read = this.read(params.target, params.shotIds);
    if (params.inputImages && read.source) {
      if (params.inputImages.length > 30) throw new Error('制作图片选择过多。');
      read.source = {
        ...read.source,
        inputImages: structuredClone(params.inputImages),
        token: hash([
          read.source.token,
          params.inputImages,
          this.projects.access(false, (db, project) =>
            params.inputImages!.map(
              (image) =>
                db
                  .prepare(
                    'SELECT content_hash,size_bytes,relative_path,deleted_at FROM assets WHERE id=? AND project_id=?',
                  )
                  .get(image.assetId, project.id) ?? null,
            ),
          ),
        ]),
      };
    }
    if (!read.instruction) return { ...read, parameters: {} };
    if (params.expectedToken && params.expectedToken !== read.source?.token)
      throw new Error('制作来源已变化，请重新适配。');
    const adapter = getAdapter(params.adapterKey);
    if (!adapter) throw new Error('制作模型不存在。');
    return this.projects.access(false, (db, project) => {
      let effective = structuredClone(read.instruction!);
      const notices: ProductionIssue[] = [];
      const issues = [...read.issues];
      const continuityState =
        params.target.kind === 'shot'
          ? readShotContinuity(db, project.id, params.target.id)
          : undefined;
      const continuity = continuityState?.binding;
      const isVideo = adapter.capability.endsWith('_VIDEO');
      const continuityPrompt = continuity
        ? isVideo
          ? continuity.videoPrompt
          : continuity.mode === 'reframe'
            ? continuity.imagePrompt
            : undefined
        : undefined;
      if (continuity && isVideo) {
        if (!continuity.firstFrameAssetId)
          issues.push({
            code: 'CONTINUITY_FRAME_MISSING',
            message: '请先选择并确认下一视频首帧。',
          });
        if (!['IMAGE_TO_VIDEO', 'START_END_TO_VIDEO'].includes(adapter.capability))
          issues.push({
            code: 'CONTINUITY_FRAME_MODE',
            message: '本次衔接需要严格首帧输入，请选择图生视频或首尾帧模式。',
          });
        if (
          params.inputImages &&
          !params.inputImages.some(
            (image) =>
              image.assetId === continuity.firstFrameAssetId && image.role === 'first-frame',
          )
        )
          issues.push({
            code: 'CONTINUITY_FRAME_CHANGED',
            message: '当前表单首帧与人工确认的衔接首帧不同，请重新打开制作。',
          });
      }
      if (continuity?.mode === 'reframe' && !isVideo) {
        if (adapter.capability !== 'REFERENCE_TO_IMAGE')
          issues.push({
            code: 'CONTINUITY_IMAGE_MODE',
            message: '换机位首帧需要参考生图模式，请将已确认画面作为构图参考。',
          });
        if (!params.inputImages?.some((image) => image.assetId === continuity.anchorAssetId))
          issues.push({
            code: 'CONTINUITY_ANCHOR_MISSING',
            message: '新首帧制作缺少人工指定的衔接基准图，请重新打开制作。',
          });
      }
      const state = this.targetState(params.target);
      let sceneInputs: ProductionCompileResult['sceneInputs'];
      if (state.sceneId) {
        const scene = new ContentService(this.projects)
          .listScenes()
          .find((s) => s.id === state.sceneId)!;
        const styleReferences = effective.resources.filter(
          (resource) => resource.kind === 'style-image' && resource.assetId,
        );
        scene.materialBindings = [
          ...(scene.materialBindings ?? []),
          ...styleReferences
            .filter(
              (resource) =>
                !scene.materialBindings?.some((binding) => binding.assetId === resource.assetId),
            )
            .map((resource) => ({
              id: `style:${resource.assetId}`,
              role: 'other' as const,
              label: `风格参考：${resource.purpose}`,
              assetId: resource.assetId!,
              source: 'auto' as const,
            })),
        ];
        const cast = scene.characterBindings ?? [];
        try {
          requireProductionCharacters(
            db,
            project.id,
            cast.map((c) => c.characterDocumentId),
          );
        } catch {
          issues.push({
            code: 'INVALID_CAST',
            message: '出场角色已不可用，请先调整并保存场次关系。',
          });
        }
        const media = resolveSceneMedia(this.projects, {
          characterDocumentIds: cast.map((c) => c.characterDocumentId),
          assetIds: [
            ...cast.flatMap((c) => (c.imageAssetId ? [c.imageAssetId] : [])),
            ...(scene.materialBindings ?? []).map((b) => b.assetId),
          ],
          voiceVersionIds: cast.flatMap((c) =>
            c.voiceReferenceVersionId ? [c.voiceReferenceVersionId] : [],
          ),
        });
        const names = this.names(db, project.id);
        const requiresRecording = effective.resources.some(
          (r) => r.required && r.kind === 'dialogue-audio',
        );
        const requiresVoice = effective.resources.some(
          (r) => r.required && r.kind === 'voice-reference',
        );
        const hasVoice = cast.some(
          (c) =>
            !c.voiceDisabled &&
            (c.voiceReferenceVersionId ||
              media.characters.find((m) => m.characterDocumentId === c.characterDocumentId)?.voice),
        );
        if (
          (effective.audio.mode === 'dialogue-driven' &&
            !scene.dialogueAudioId &&
            !requiresRecording) ||
          (effective.audio.mode === 'voice-reference' && !hasVoice && !requiresVoice)
        ) {
          effective = { ...effective, audio: { ...effective.audio, mode: 'auto' } };
          notices.push({
            code: 'AUDIO_METHOD_ADAPTED',
            message:
              '尚未选用录音或声音样本，本次沿用所选模型的声音方式；对白和声音描述保留在提示词中。',
          });
        }
        sceneInputs = {
          scene,
          media,
          characterNames: Object.fromEntries(
            cast.map((c) => [c.characterDocumentId, names[c.characterDocumentId] ?? '角色']),
          ),
        };
        const availableAsset = (id: string | undefined) => {
          if (!id) return false;
          const asset = db
            .prepare(
              'SELECT relative_path FROM assets WHERE id=? AND project_id=? AND deleted_at IS NULL',
            )
            .get(id, project.id) as { relative_path: string } | undefined;
          return (
            asset && existsSync(resolveProjectRelativePath(project.rootPath, asset.relative_path))
          );
        };
        for (const resource of effective.resources.filter((r) => r.required)) {
          const binding = cast.find((c) => c.characterDocumentId === resource.documentId);
          const character = media.characters.find(
            (c) => c.characterDocumentId === resource.documentId,
          );
          const selectedImageId =
            binding && !binding.imageDisabled
              ? (binding.imageAssetId ?? character?.defaultImage?.id)
              : undefined;
          const available =
            resource.kind === 'character-image'
              ? availableAsset(selectedImageId) &&
                (!resource.assetId || resource.assetId === selectedImageId)
              : resource.kind === 'voice-reference'
                ? binding &&
                  !binding.voiceDisabled &&
                  (binding.voiceReferenceVersionId
                    ? media.voices.some((v) => v.versionId === binding.voiceReferenceVersionId)
                    : character?.voice)
                : resource.kind === 'setting-image'
                  ? scene.materialBindings?.some(
                      (b) =>
                        b.role === 'scene' &&
                        (!resource.documentId || b.sourceDocumentId === resource.documentId) &&
                        (!resource.assetId || b.assetId === resource.assetId) &&
                        availableAsset(b.assetId),
                    )
                  : resource.kind === 'dialogue-audio'
                    ? scene.dialogueAudioId
                    : resource.assetId &&
                      scene.materialBindings?.some((b) => b.assetId === resource.assetId) &&
                      availableAsset(resource.assetId);
          if (!available)
            issues.push({
              code: 'MISSING_RESOURCE',
              message: `尚未准备或选用必需素材：${resource.purpose}`,
            });
        }
        if (
          effective.audio.mode === 'voice-reference' &&
          !cast.some(
            (c) =>
              !c.voiceDisabled &&
              (c.voiceReferenceVersionId ||
                media.characters.find((m) => m.characterDocumentId === c.characterDocumentId)
                  ?.voice),
          )
        )
          issues.push({
            code: 'MISSING_VOICE',
            message: '制作指令要求角色音色，请先绑定可用的声音样本。',
          });
        if (effective.audio.mode === 'dialogue-driven' && !scene.dialogueAudioId)
          issues.push({
            code: 'MISSING_DIALOGUE',
            message: '制作指令要求完整对白驱动，请先绑定对白录音。',
          });
      } else if (effective.resources.some((r) => r.required)) {
        for (const resource of effective.resources.filter((r) => r.required)) {
          const asset = resource.assetId
            ? (db
                .prepare(
                  'SELECT relative_path FROM assets WHERE id=? AND project_id=? AND deleted_at IS NULL',
                )
                .get(resource.assetId, project.id) as { relative_path: string } | undefined)
            : undefined;
          if (
            !asset ||
            !existsSync(resolveProjectRelativePath(project.rootPath, asset.relative_path))
          )
            issues.push({
              code: 'MISSING_RESOURCE',
              message: `尚未准备必需素材：${resource.purpose}`,
            });
        }
      }
      const compiled = compileProductionParameters(
        adapter.capability.endsWith('_VIDEO')
          ? {
              ...effective,
              generation: { ...this.getDefaults().settings.generation, ...effective.generation },
            }
          : effective,
        adapter,
        this.names(db, project.id),
        {
          ...(continuityPrompt ? { prompt: continuityPrompt } : {}),
          ...((adapter.capability.endsWith('_VIDEO') || params.target.kind !== 'scene') &&
          read.compiledPrompt &&
          !continuityPrompt
            ? { prompt: read.compiledPrompt }
            : {}),
          estimatedDurationSeconds: read.estimatedDurationSeconds,
        },
      );
      issues.push(...compiled.issues);
      const bindings = sceneInputs
        ? [
            ...(sceneInputs.scene.materialBindings ?? []).filter((b) => b.role !== 'character'),
            ...(sceneInputs.scene.characterBindings ?? []).flatMap((c) => {
              const id = c.imageDisabled
                ? undefined
                : (c.imageAssetId ??
                  sceneInputs.media.characters.find(
                    (m) => m.characterDocumentId === c.characterDocumentId,
                  )?.defaultImage?.id);
              return id
                ? [
                    {
                      id: 'cast-' + c.characterDocumentId,
                      role: 'character' as const,
                      label: sceneInputs.characterNames[c.characterDocumentId] ?? '角色',
                      assetId: id,
                      source: 'auto' as const,
                    },
                  ]
                : [];
            }),
          ]
        : [];
      const selected =
        params.inputImages ??
        bindings.map((b) => ({
          assetId: b.assetId,
          role:
            b.role === 'character'
              ? ('character' as const)
              : b.role === 'scene'
                ? ('scene' as const)
                : ('reference' as const),
          label: b.label,
        }));
      for (const image of selected) {
        const asset = db
          .prepare(
            'SELECT kind,relative_path FROM assets WHERE id=? AND project_id=? AND deleted_at IS NULL',
          )
          .get(image.assetId, project.id) as { kind: string; relative_path: string } | undefined;
        if (
          !asset ||
          asset.kind.toLowerCase().includes('video') ||
          !existsSync(resolveProjectRelativePath(project.rootPath, asset.relative_path))
        ) {
          issues.push({
            code: 'INVALID_INPUT_IMAGE',
            message: '选用的制作图片不可用，请重新选择。',
          });
        }
      }
      try {
        if (
          ['IMAGE_TO_VIDEO', 'START_END_TO_VIDEO'].includes(adapter.capability) &&
          selected.some((image) => ['character', 'scene'].includes(image.role))
        )
          notices.push({
            code: 'FRAME_INPUT_ONLY',
            message:
              '本次生成方式使用首帧/尾帧；角色和场景图保留用于准备画面，本次不作为独立参考图提交。',
          });
        if (selected.length || params.inputImages !== undefined)
          compiled.parameters = seedProductionInputs(
            adapter,
            compiled.parameters,
            undefined,
            selected.map((image) => ({ ...image, url: 'project-asset://' + image.assetId })),
          );
        compiled.parameters = addProductionRoleVoices(
          adapter,
          compiled.parameters,
          [],
          undefined,
          bindings,
        );
      } catch (error) {
        issues.push({
          code: 'INPUT_SELECTION_CONFLICT',
          message: error instanceof Error ? error.message : '制作素材用途不符合当前模式。',
        });
      }
      if (!sceneInputs && adapter.parameterSchema.properties.images) {
        const images = read
          .instruction!.resources.filter(
            (resource) => resource.kind === 'style-image' && resource.assetId,
          )
          .map((resource) => `project-asset://${resource.assetId}`);
        if (images.length) compiled.parameters.images = images;
      }
      const duration = Number(compiled.parameters.duration);
      return {
        ...read,
        instruction: effective,
        parameters: compiled.parameters,
        notices: [...notices, ...compiled.notices],
        issues,
        sceneInputs,
        ...(continuity ? { continuity: continuityState } : {}),
        requestedDurationSeconds: Number.isFinite(duration) && duration > 0 ? duration : undefined,
        ...(read.timeline?.length
          ? { segments: planProductionSegments(read.timeline, adapter) }
          : {}),
      };
    });
  }

  assertSource(
    source: ProductionSource | undefined,
    target: ProductionTarget,
    adapterKey?: string,
    actual?: { parameters: AdapterParameters; inputs?: MediaInputReferenceV1[] },
  ): void {
    const exists = this.projects.access(
      false,
      (db, project) =>
        this.latest(db, project.id, target) ??
        (target.kind === 'scene'
          ? db
              .prepare(
                "SELECT 1 FROM production_instruction_versions v JOIN shots s ON s.id=v.target_id WHERE v.project_id=? AND v.target_kind='shot' AND s.scene_id=? LIMIT 1",
              )
              .get(project.id, target.id)
          : undefined),
    );
    if (!exists && !source) return;
    const current = adapterKey
      ? this.compile({
          target,
          adapterKey,
          shotIds: source?.shotIds,
          inputImages: source?.inputImages,
        })
      : this.read(target, source?.shotIds);
    if (!current.source) {
      if (source) throw new Error('制作来源不存在。');
      return;
    }
    if (
      !source ||
      !source.target ||
      key(source.target) !== key(target) ||
      source.token !== current.source.token ||
      source.instructionId !== current.source.instructionId ||
      source.revision !== current.source.revision
    )
      throw new Error('制作来源已变化或未适配，请重新打开制作表单。');
    if (current.issues.length) throw new Error(current.issues.map((i) => i.message).join('\n'));
    const continuity = adapterKey
      ? (current as ProductionCompileResult).continuity?.binding
      : undefined;
    const storySeconds =
      current.estimatedDurationSeconds ?? current.instruction?.generation.duration;
    if (
      actual &&
      storySeconds !== undefined &&
      actual.parameters.duration !== undefined &&
      Number(actual.parameters.duration) < storySeconds
    )
      throw new Error('实际提交时长短于剧情预计时长，请重新适配制作内容。');
    if (actual && current.instruction)
      this.assertInputs(
        current.instruction,
        actual,
        'sceneInputs' in current
          ? (current.sceneInputs as ProductionCompileResult['sceneInputs'])
          : undefined,
        source.inputImages,
        continuity
          ? [
              getAdapter(adapterKey!)?.capability.endsWith('_VIDEO')
                ? continuity.firstFrameAssetId
                : continuity.anchorAssetId,
            ].filter((id): id is string => Boolean(id))
          : [],
      );
  }

  private assertInputs(
    instruction: ProductionInstruction,
    actual: { parameters: AdapterParameters; inputs?: MediaInputReferenceV1[] },
    sceneInputs?: ProductionCompileResult['sceneInputs'],
    selectedImages?: import('@ai-video/contracts').ProductionImageSelection[],
    requiredImageIds: string[] = [],
  ) {
    const refs = new Set<string>();
    let hasVoiceInput = false;
    const collect = (value: unknown) => {
      if (typeof value === 'string') {
        if (/^(project-asset|asset|character-voice|project-audio):\/\//u.test(value))
          refs.add(value.replace(/^asset:\/\//u, 'project-asset://'));
      } else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === 'object') {
        const item = value as Record<string, unknown>;
        if (
          item.type === 'reference_audio' ||
          (item.type === 'audio_url' && item.role === 'reference_audio')
        )
          hasVoiceInput = true;
        for (const [field, item] of Object.entries(value))
          if (!['text', 'prompt'].includes(field)) collect(item);
      }
    };
    for (const [field, value] of Object.entries(actual.parameters))
      if (!['prompt', 'negative_prompt'].includes(field)) collect(value);
    for (const input of actual.inputs ?? [])
      if (input.type === 'asset') refs.add(`project-asset://${input.assetId}`);
      else if (input.audioId) refs.add(`project-audio://${input.audioId}`);
    const missing = (purpose: string) => {
      throw new Error(`提交参数缺少制作清单要求的素材：${purpose}。请重新填入制作内容。`);
    };
    for (const id of requiredImageIds)
      if (!refs.has(`project-asset://${id}`)) missing('已确认的衔接画面或首帧');
    for (const image of selectedImages ?? [])
      if (
        ['first-frame', 'last-frame'].includes(image.role) &&
        !refs.has(`project-asset://${image.assetId}`)
      )
        missing(image.role === 'first-frame' ? '本镜首帧' : '本镜尾帧');
    for (const resource of instruction.resources.filter((r) => r.required)) {
      const binding = sceneInputs?.scene.characterBindings?.find(
        (c) => c.characterDocumentId === resource.documentId,
      );
      const defaults = sceneInputs?.media.characters.find(
        (c) => c.characterDocumentId === resource.documentId,
      );
      if (resource.kind === 'voice-reference') {
        const voiceId = binding?.voiceReferenceVersionId ?? defaults?.voice?.versionId;
        const voice = sceneInputs?.media.voices.find((v) => v.versionId === voiceId);
        if (
          !refs.has(`character-voice://${resource.documentId}/${voiceId}`) &&
          !refs.has(`project-audio://${voice?.audioId}`)
        )
          missing(resource.purpose);
      } else if (resource.kind === 'dialogue-audio') {
        if (!refs.has(`project-audio://${sceneInputs?.scene.dialogueAudioId}`))
          missing(resource.purpose);
      } else {
        const id =
          resource.assetId ??
          (resource.kind === 'character-image'
            ? (binding?.imageAssetId ?? defaults?.defaultImage?.id)
            : sceneInputs?.scene.materialBindings?.find(
                (b) =>
                  b.role === 'scene' &&
                  (!resource.documentId || b.sourceDocumentId === resource.documentId),
              )?.assetId);
        if (!id || !refs.has(`project-asset://${id}`)) missing(resource.purpose);
      }
    }
    if (
      instruction.audio.mode === 'voice-reference' &&
      !hasVoiceInput &&
      ![...refs].some((value) => value.startsWith('character-voice://')) &&
      !(actual.inputs ?? []).some(
        (input) => input.type === 'controlled_temporary_file' && input.characterDocumentId,
      )
    )
      missing('角色音色');
    if (
      instruction.audio.mode === 'dialogue-driven' &&
      !refs.has(`project-audio://${sceneInputs?.scene.dialogueAudioId}`)
    )
      missing('完整对白录音');
  }

  private inspectGraph(
    db: Database.Database,
    projectId: string,
    target: ProductionTarget,
    pending = new Map<string, ProductionInstruction>(),
  ) {
    const issues: ProductionIssue[] = [];
    const dependencies: unknown[] = [];
    type Facts = { ending: Map<string, string>; locked: Map<string, string> };
    const cache = new Map<string, Facts>();
    const expanded = new Set<string>();
    const visit = (current: ProductionTarget, path: Set<string>): Facts => {
      const id = key(current);
      const empty = () => ({
        ending: new Map<string, string>(),
        locked: new Map<string, string>(),
      });
      const fail = (code: string, message: string) => {
        issues.push({ code, message });
        return empty();
      };
      if (path.has(id)) return fail('DEPENDENCY_CYCLE', '制作指令的连续性依赖存在循环。');
      const cached = cache.get(id);
      if (cached) return cached;
      if (expanded.size >= 200) return fail('DEPENDENCY_LIMIT', '连续性依赖超过本次可检查范围。');
      expanded.add(id);
      let state: ReturnType<ProductionService['targetState']>;
      try {
        state = this.targetState(current);
      } catch {
        return fail('MISSING_DEPENDENCY', `制作依赖 ${id} 不存在或已不可用。`);
      }
      const latest = this.latest(db, projectId, current);
      const instruction = pending.get(id) ?? latest?.instruction;
      dependencies.push([current, latest?.row.id, state.semanticHash]);
      if (!instruction) return fail('MISSING_DEPENDENCY', `制作依赖 ${id} 缺少结构化制作指令。`);
      if (!pending.has(id) && latest?.row.source_hash !== state.semanticHash)
        issues.push({
          code: 'STALE_INSTRUCTION',
          message: `${id} 的提示词、角色/场景资料或出场关系已变化，需要更新结构化制作指令。`,
        });
      const facts = empty();
      const merge = (into: Map<string, string>, values: Map<string, string>) => {
        for (const [name, value] of values) {
          if (into.has(name) && into.get(name) !== value)
            issues.push({
              code: 'CONTINUITY_CONFLICT',
              message: `前置对象对状态 ${name} 的值互相冲突。`,
            });
          into.set(name, value);
        }
      };
      const nextPath = new Set([...path, id]);
      for (const predecessor of instruction.continuity.predecessors) {
        const previous = visit(predecessor, nextPath);
        merge(facts.ending, previous.ending);
        merge(facts.locked, previous.locked);
      }
      for (const fact of instruction.continuity.before) {
        if (instruction.continuity.predecessors.length && facts.ending.get(fact.key) !== fact.value)
          issues.push({
            code: 'CONTINUITY_CONFLICT',
            message: `前置状态无法满足 ${fact.key}=${fact.value}。`,
          });
      }
      merge(facts.locked, new Map(instruction.continuity.locked.map((f) => [f.key, f.value])));
      for (const fact of [...instruction.continuity.before, ...instruction.continuity.after]) {
        if (facts.locked.has(fact.key) && facts.locked.get(fact.key) !== fact.value)
          issues.push({
            code: 'LOCKED_FACT_CHANGED',
            message: `锁定状态 ${fact.key} 在后续制作指令中被改变。`,
          });
        facts.ending.set(fact.key, fact.value);
      }
      for (const [name, value] of facts.locked) facts.ending.set(name, value);
      cache.set(id, facts);
      return facts;
    };
    visit(target, new Set());
    return { issues, dependencies };
  }

  private latest(db: Database.Database, projectId: string, target: ProductionTarget) {
    const row = db
      .prepare(
        'SELECT id,revision,instruction_json,source_hash FROM production_instruction_versions WHERE project_id=? AND target_kind=? AND target_id=? ORDER BY revision DESC LIMIT 1',
      )
      .get(projectId, target.kind, target.id) as VersionRow | undefined;
    return row
      ? { row, instruction: JSON.parse(row.instruction_json) as ProductionInstruction }
      : undefined;
  }

  private names(db: Database.Database, projectId: string): Record<string, string> {
    return Object.fromEntries(
      (
        db
          .prepare(
            "SELECT id,title FROM documents WHERE project_id=? AND lifecycle_status='active'",
          )
          .all(projectId) as Array<{ id: string; title: string }>
      ).map((d) => [d.id, d.title]),
    );
  }

  private targetState(target: ProductionTarget): {
    rowVersion: number;
    semanticHash: string;
    inputHash: string;
    sceneId?: string;
  } {
    return this.projects.access(false, (db, project) => {
      const content = new ContentService(this.projects);
      if (target.kind === 'character' || target.kind === 'setting') {
        const document = content.getDocument(target.id);
        if (
          document.kind !== (target.kind === 'character' ? 'character' : 'scene') ||
          document.lifecycleStatus !== 'active' ||
          db
            .prepare(
              "SELECT 1 FROM document_bindings WHERE document_id=? AND domain_scope='novel' AND status<>'archived'",
            )
            .get(target.id)
        )
          throw new Error('目标不是有效的制作角色或场景。');
        const semanticHash = hash(document.currentVersion?.contentMarkdown);
        return {
          rowVersion: document.rowVersion,
          semanticHash,
          inputHash: hash([semanticHash, document.currentVersion?.id]),
        };
      }
      const shot =
        target.kind === 'shot'
          ? (db.prepare('SELECT scene_id FROM shots WHERE id=?').get(target.id) as
              { scene_id: string } | undefined)
          : undefined;
      if (target.kind === 'shot' && !shot) throw new Error('镜头不存在。');
      const scene = content.listScenes().find((s) => s.id === (shot?.scene_id ?? target.id));
      if (!scene) throw new Error('场次不属于当前项目。');
      const cast = scene.characterBindings ?? [];
      const item =
        target.kind === 'shot'
          ? content.listShots(scene.id).find((s) => s.id === target.id)!
          : scene;
      const prompt =
        target.kind === 'shot' ? ('prompt' in item ? item.prompt : undefined) : scene.videoPrompt;
      const definitions = [scene.sceneDocumentId, ...cast.map((c) => c.characterDocumentId)]
        .filter((id): id is string => Boolean(id))
        .map((id) =>
          db
            .prepare(
              'SELECT id,current_version_id,lifecycle_status FROM documents WHERE id=? AND project_id=?',
            )
            .get(id, project.id),
        );
      const semanticHash = hash([
        prompt,
        scene.sceneDocumentId,
        cast.map((c) => c.characterDocumentId),
        definitions,
      ]);
      const relatedVersions =
        target.kind === 'scene'
          ? content
              .listShots(scene.id)
              .map((child) => [
                child.id,
                child.title,
                child.position,
                child.prompt,
                child.rowVersion,
                this.latest(db, project.id, { kind: 'shot', id: child.id })?.row.id,
              ])
          : [
              scene.videoPrompt,
              this.latest(db, project.id, { kind: 'scene', id: scene.id })?.row.id,
            ];
      const media = resolveSceneMedia(this.projects, {
        characterDocumentIds: cast.map((c) => c.characterDocumentId),
        assetIds: [
          ...cast.flatMap((c) => (c.imageAssetId ? [c.imageAssetId] : [])),
          ...(scene.materialBindings ?? []).map((b) => b.assetId),
        ],
        voiceVersionIds: cast.flatMap((c) =>
          c.voiceReferenceVersionId ? [c.voiceReferenceVersionId] : [],
        ),
      });
      const selectedAssets = [
        ...cast
          .filter((c) => !c.imageDisabled)
          .map(
            (c) =>
              c.imageAssetId ??
              media.characters.find((m) => m.characterDocumentId === c.characterDocumentId)
                ?.defaultImage?.id,
          ),
        ...(scene.materialBindings ?? []).map((b) => b.assetId),
      ];
      const selectedVoices = cast
        .filter((c) => !c.voiceDisabled)
        .map(
          (c) =>
            c.voiceReferenceVersionId ??
            media.characters.find((m) => m.characterDocumentId === c.characterDocumentId)?.voice
              ?.versionId,
        );
      const assetState = selectedAssets.map((id) => {
        const asset = media.assets.find((a) => a.id === id);
        return asset
          ? [
              asset.id,
              asset.contentHash,
              asset.relativePath,
              existsSync(resolveProjectRelativePath(project.rootPath, asset.relativePath)),
            ]
          : id;
      });
      const audioState = (id: string | undefined) => {
        const audio = id
          ? (db
              .prepare(
                'SELECT id,content_hash,relative_path,deleted_at FROM audio_files WHERE id=? AND project_id=?',
              )
              .get(id, project.id) as
              | {
                  id: string;
                  content_hash: string;
                  relative_path: string;
                  deleted_at: string | null;
                }
              | undefined)
          : undefined;
        return audio
          ? [
              audio.id,
              audio.content_hash,
              audio.deleted_at,
              existsSync(resolveProjectRelativePath(project.rootPath, audio.relative_path)),
            ]
          : id;
      };
      const voiceState = selectedVoices.map((id) => {
        const voice = media.voices.find((v) => v.versionId === id);
        return voice ? [voice.versionId, audioState(voice.audioId)] : id;
      });
      const dialogue = audioState(scene.dialogueAudioId);
      const inputHash = hash([
        semanticHash,
        relatedVersions,
        scene.materialBindings,
        cast,
        assetState,
        voiceState,
        dialogue,
        cast.map((c) => this.names(db, project.id)[c.characterDocumentId]),
      ]);
      return { rowVersion: item.rowVersion, semanticHash, inputHash, sceneId: scene.id };
    });
  }
}
