import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import type Database from 'better-sqlite3';
import {
  productionShotReferenceIds,
  productionFrameInputConflict,
  seedProductionInputs,
  validateProductionAuthoringIR,
  type ProductionAuthoringIR,
  type ProductionCompileParams,
  type ProductionCompileResult,
  type ProductionDefaults,
  type ProductionDefaultsInfo,
  type ProductionFormSource,
  type ProductionIssue,
  type ProductionReadResult,
  type ProductionSegment,
  type ProductionTarget,
  type ProductionTimelineEntry,
  type SceneCharacterBindingInfo,
  type SceneInfo,
  type SceneMaterialBindingInfo,
} from '@ai-video/contracts';
import {
  compileProductionParameters,
  getAdapter,
  resolveProductionDuration,
  parseProductionDefaults,
} from '@ai-video/generation-adapters';
import { createRepositories, readShotContinuity } from '@ai-video/persistence';
import { continuityReferenceImageIds, continuitySourceImageIds } from '@ai-video/contracts';
import { ContentService } from './content-service.js';
import { ProjectService, resolveProjectRelativePath } from './project-service.js';
import { resolveSceneMedia } from './scene-media-service.js';
import { resolveIRMaterialBindings } from './production-ir-bindings.js';
import { validateProductionIRReferences } from './project-ir-validation.js';
import { productionMediaView } from './production-media-view.js';

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

export function summarizeProductionReadiness(issues: ProductionIssue[]) {
  return {
    readiness: issues.length ? 'needs_attention' : 'ready',
    issueCount: issues.length,
    issuesTruncated: issues.length > 8 || issues.some((issue) => issue.message.length > 240),
    issues: issues.slice(0, 8).map((issue) => ({
      ...issue,
      message: issue.message.slice(0, 240),
      targetTitle: issue.targetTitle?.slice(0, 120),
    })),
  };
}

export function summarizeProductionNotices(notices: ProductionIssue[]) {
  return notices.length
    ? {
        noticeCount: notices.length,
        notices: notices
          .slice(0, 5)
          .map(({ code, message, target }) => ({ code, message: message.slice(0, 240), target })),
        noticesTruncated:
          notices.length > 5 || notices.some((notice) => notice.message.length > 240),
      }
    : {};
}

/** Reads and compiles the single persisted scene/shot authoring IR. */
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
        const current = db
          .prepare('SELECT row_version FROM production_defaults WHERE project_id=?')
          .get(project.id) as { row_version: number } | undefined;
        const version = current?.row_version ?? 0;
        if (version !== input.expectedRowVersion)
          throw new Error('项目生成设置已变化，请重新读取。');
        const next = version + 1;
        db.prepare(
          'INSERT INTO production_defaults(project_id,row_version,settings_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET row_version=excluded.row_version,settings_json=excluded.settings_json,updated_at=excluded.updated_at',
        ).run(project.id, next, JSON.stringify(settings), new Date().toISOString());
        return { rowVersion: next, settings };
      })(),
    );
  }

  queryVersion(target: ProductionTarget): string {
    // Version the data this target actually exposes. A shot read does not
    // contain sibling bodies; their edits must not expire this shot's pages.
    // Semantic/continuity review has its own explicit dependency graph.
    const read = this.read(target);
    return this.projects.access(false, (db, project) => {
      const content = new ContentService(this.projects);
      const scene =
        target.kind === 'scene'
          ? content.listScenes().find((item) => item.id === target.id)
          : target.kind === 'shot'
            ? content
                .listScenes()
                .find((item) => item.id === this.findShot(content, target.id).sceneId)
            : undefined;
      const shots = scene
        ? content
            .listShots(scene.id)
            .filter((shot) => target.kind === 'scene' || shot.id === target.id)
        : [];
      const ids = new Set<string>();
      const collect = (ir?: ProductionAuthoringIR) => {
        for (const field of [
          'characterDocumentIds',
          'sceneDocumentIds',
          'propDocumentIds',
        ] as const)
          for (const id of ir?.references?.[field] ?? []) ids.add(id);
      };
      collect(read.authoringIR);
      if (target.kind === 'scene') for (const shot of shots) collect(shot.authoringIR);
      const documents = [...ids]
        .sort()
        .map(
          (id) =>
            db
              .prepare(
                'SELECT id,kind,lifecycle_status,current_version_id,published_version_id FROM documents WHERE id=? AND project_id=?',
              )
              .get(id, project.id) ?? null,
        );
      return hash([project.id, read, scene, shots, this.getDefaults(), documents]);
    });
  }

  readForAgent(target: ProductionTarget) {
    const result = this.read(target);
    return this.projects.access(false, () => {
      const content = new ContentService(this.projects);
      let currentText = '';
      let scene: SceneInfo | undefined;
      let shots: ReturnType<ContentService['listShots']> = [];
      if (target.kind === 'scene') {
        scene = content.listScenes().find((item) => item.id === target.id);
        if (!scene) throw new Error('制作场次不存在。');
        currentText = scene.authoringIR?.prompt ?? '';
        shots = content.listShots(scene.id);
      } else if (target.kind === 'shot') {
        const shot = this.findShot(content, target.id);
        currentText = shot.authoringIR?.prompt ?? '';
        scene = content.listScenes().find((item) => item.id === shot.sceneId);
        shots = [shot];
      } else {
        currentText = content.getDocument(target.id).currentVersion?.contentMarkdown ?? '';
      }
      return {
        target,
        rowVersion: result.rowVersion,
        authoringIR: result.authoringIR,
        contentFormat: result.authoringIR
          ? 'authoring-ir-v1'
          : target.kind === 'scene' || target.kind === 'shot'
            ? 'missing'
            : 'saved-prompt',
        currentText,
        issues: result.issues,
        ...(result.notices?.length ? { notices: result.notices } : {}),
        estimatedDurationSeconds: result.estimatedDurationSeconds,
        scene: scene
          ? (() => {
              const { authoringIR, ...metadata } = scene;
              delete metadata.videoPrompt;
              return {
                ...metadata,
                hasPrompt: Boolean(authoringIR?.prompt),
                hasAuthoringIR: Boolean(authoringIR),
              };
            })()
          : undefined,
        shots: shots.map(({ authoringIR, ...shot }) => {
          delete shot.prompt;
          return {
            ...shot,
            hasPrompt: Boolean(authoringIR?.prompt),
            hasAuthoringIR: Boolean(authoringIR),
            contentFormat: authoringIR ? 'authoring-ir-v1' : 'missing',
            timing: authoringIR?.timing,
            estimatedDurationSeconds: authoringIR?.timing?.estimatedDurationSeconds,
          };
        }),
      };
    });
  }

  read(target: ProductionTarget, shotIds?: string[]): ProductionReadResult {
    this.assertTarget(target);
    return this.projects.access(false, (db, project) => {
      const content = new ContentService(this.projects);
      const issues: ProductionIssue[] = [];
      let rowVersion: number;
      let authoringIR: ProductionAuthoringIR | undefined;
      let scene: SceneInfo | undefined;
      let shots: ReturnType<ContentService['listShots']> = [];
      let savedPrompt: string | undefined;

      if (target.kind === 'scene') {
        scene = content.listScenes().find((item) => item.id === target.id);
        if (!scene) throw new Error('制作场次不存在。');
        rowVersion = scene.rowVersion;
        authoringIR = scene.authoringIR;
        shots = content.listShots(scene.id);
      } else if (target.kind === 'shot') {
        const shot = this.findShot(content, target.id);
        const parent = content.listScenes().find((item) => item.id === shot.sceneId);
        if (!parent) throw new Error('镜头所属场次不存在。');
        scene = parent;
        shots = content.listShots(parent.id);
        rowVersion = shot.rowVersion;
        authoringIR = shot.authoringIR;
      } else {
        const document = content.getDocument(target.id);
        const expectedKind = target.kind === 'character' ? 'character' : 'scene';
        if (
          document.kind !== expectedKind ||
          document.lifecycleStatus !== 'active' ||
          db
            .prepare(
              "SELECT 1 FROM document_bindings WHERE document_id=? AND domain_scope='novel' AND status<>'archived'",
            )
            .get(target.id)
        )
          throw new Error(`制作来源目标不是有效的 ${expectedKind} 文档。`);
        rowVersion = document.rowVersion;
        savedPrompt = document.currentVersion?.contentMarkdown;
      }

      if (authoringIR) {
        authoringIR = validateProductionAuthoringIR(
          authoringIR,
          target.kind === 'shot' ? 'shot' : 'scene',
        );
        try {
          validateProductionIRReferences(db, project.id, authoringIR);
        } catch (error) {
          issues.push({
            code: 'INVALID_IR_REFERENCE',
            message: error instanceof Error ? error.message : '制作 IR 引用无效。',
            target,
          });
        }
      }

      if (shotIds) {
        const first = shots.findIndex((shot) => shot.id === shotIds[0]);
        if (
          target.kind !== 'scene' ||
          !shotIds.length ||
          shotIds.length > 30 ||
          new Set(shotIds).size !== shotIds.length ||
          first < 0 ||
          shots
            .slice(first, first + shotIds.length)
            .map((shot) => shot.id)
            .join('|') !== shotIds.join('|')
        )
          throw new Error('制作分段必须引用当前场次按顺序连续的真实镜头。');
      }

      const selectedShots = shotIds ? shots.filter((shot) => shotIds.includes(shot.id)) : shots;
      if (target.kind === 'scene') {
        for (const shot of selectedShots) {
          if (!shot.authoringIR) continue;
          try {
            validateProductionIRReferences(db, project.id, shot.authoringIR);
          } catch (error) {
            issues.push({
              code: 'INVALID_IR_REFERENCE',
              message: error instanceof Error ? error.message : '镜头 IR 引用无效。',
              target: { kind: 'shot', id: shot.id },
            });
          }
        }
      }
      const timeline: ProductionTimelineEntry[] = selectedShots.map((shot) => ({
        shotId: shot.id,
        title: shot.title,
        estimatedDurationSeconds: shot.authoringIR?.timing?.estimatedDurationSeconds,
        ...(shot.authoringIR?.timing ? { timing: shot.authoringIR.timing } : {}),
        prompt: shot.authoringIR?.prompt ?? '',
      }));
      let cursor = 0;
      for (const entry of timeline) {
        if (entry.estimatedDurationSeconds === undefined) continue;
        entry.startSeconds = cursor;
        cursor += entry.estimatedDurationSeconds;
        entry.endSeconds = cursor;
      }
      const shotDurations = timeline.map((entry) => entry.estimatedDurationSeconds);
      const completeTiming =
        shotDurations.length > 0 && shotDurations.every((value) => value !== undefined);
      const estimatedDurationSeconds =
        target.kind === 'shot'
          ? authoringIR?.timing?.estimatedDurationSeconds
          : ((!shotIds ? authoringIR?.timing?.estimatedDurationSeconds : undefined) ??
            (completeTiming ? shotDurations.reduce((sum, value) => sum + value, 0) : undefined));
      // A target's prompt is complete. Ranges consume only their selected shots;
      // open data is never interpreted as reusable scene text.
      const prompts =
        authoringIR && !shotIds
          ? [authoringIR.prompt]
          : target.kind === 'scene'
            ? timeline.flatMap((entry) => (entry.prompt ? [entry.prompt] : []))
            : [];
      const compiledPrompt =
        target.kind === 'scene' || target.kind === 'shot'
          ? prompts.length
            ? prompts.join('\n\n')
            : undefined
          : savedPrompt;
      return {
        target,
        rowVersion,
        ...(authoringIR ? { authoringIR } : {}),
        ...(prompts.length ? { promptSource: 'authoring-ir' as const } : {}),
        ...(target.kind !== 'scene' && target.kind !== 'shot' && savedPrompt
          ? { promptSource: 'saved-prompt' as const }
          : {}),
        issues,
        ...(compiledPrompt !== undefined ? { compiledPrompt } : {}),
        ...(target.kind === 'scene' ? { timeline } : {}),
        ...(estimatedDurationSeconds !== undefined ? { estimatedDurationSeconds } : {}),
      };
    });
  }

  /** Shared saved binding projection for compilation and the Agent's on-demand media view. */
  private resolveSceneInputs(target: ProductionTarget, shotIds?: string[]) {
    return this.projects.access(false, (db, project) => {
      const content = new ContentService(this.projects);
      let materialReferences: Array<{ documentId: string; role: 'scene' | 'prop' }> = [];
      let sceneInputs: ProductionCompileResult['sceneInputs'];
      const imageBindings: Array<{
        id: string;
        role: 'character' | 'scene' | 'prop' | 'other';
        label: string;
        assetId: string;
        source: 'auto' | 'manual';
        sourceDocumentId?: string;
      }> = [];

      if (target.kind === 'scene' || target.kind === 'shot') {
        const scene =
          target.kind === 'scene'
            ? content.listScenes().find((item) => item.id === target.id)!
            : content
                .listScenes()
                .find((item) => item.id === this.findShot(content, target.id).sceneId)!;
        const allShots = content.listShots(scene.id);
        const scopedShots =
          target.kind === 'shot'
            ? allShots.filter((shot) => shot.id === target.id)
            : shotIds
              ? allShots.filter((shot) => shotIds.includes(shot.id))
              : allShots;
        const scopedReferences = scopedShots.map((shot) => ({
          shot,
          references: productionShotReferenceIds(shot),
        }));
        materialReferences = [
          ...new Map(
            scopedReferences
              .flatMap(({ references }) => [
                ...references.sceneDocumentIds.map((documentId) => ({
                  documentId,
                  role: 'scene' as const,
                })),
                ...references.propDocumentIds.map((documentId) => ({
                  documentId,
                  role: 'prop' as const,
                })),
              ])
              .map((reference) => [`${reference.role}:${reference.documentId}`, reference]),
          ).values(),
        ];
        const characterIds = [
          ...new Set([
            ...(target.kind === 'scene' && shotIds === undefined
              ? (scene.characterBindings ?? []).map((binding) => binding.characterDocumentId)
              : []),
            ...scopedReferences.flatMap(({ references }) => references.characterDocumentIds),
          ]),
        ];
        const previousCast = new Map(
          (scene.characterBindings ?? []).map((binding) => [binding.characterDocumentId, binding]),
        );
        const cast: SceneCharacterBindingInfo[] = characterIds.map((id) => {
          const previous = previousCast.get(id);
          return {
            characterDocumentId: id,
            ...(previous?.imageAssetId ? { imageAssetId: previous.imageAssetId } : {}),
            ...(previous?.voiceReferenceVersionId
              ? { voiceReferenceVersionId: previous.voiceReferenceVersionId }
              : {}),
            ...(previous?.imageDisabled ? { imageDisabled: true } : {}),
            ...(previous?.voiceDisabled ? { voiceDisabled: true } : {}),
          };
        });
        const bindingIRs: ProductionAuthoringIR[] = scopedReferences.map(
          ({ shot, references }) => ({
            schemaVersion: 1,
            kind: 'shot',
            prompt: shot.authoringIR?.prompt ?? shot.prompt ?? '',
            references: {
              sceneDocumentIds: references.sceneDocumentIds,
              propDocumentIds: references.propDocumentIds,
            },
          }),
        );
        const defaultMaterials = resolveIRMaterialBindings(db, project.id, [], ...bindingIRs);
        const defaultMaterialByDocument = new Map(
          defaultMaterials
            .filter((binding) => binding.sourceDocumentId)
            .map((binding) => [`${binding.role}:${binding.sourceDocumentId}`, binding]),
        );
        const selectedMaterials = new Map<string, SceneMaterialBindingInfo>();
        const addMaterial = (binding: SceneMaterialBindingInfo) => {
          const key = `${binding.role}:${binding.sourceDocumentId ?? ''}:${binding.assetId}`;
          if (!selectedMaterials.has(key)) selectedMaterials.set(key, binding);
        };
        for (const { shot, references } of scopedReferences) {
          const shotBindings = shot.referenceBindings;
          const structuredScenes = new Map(
            (shotBindings?.sceneBindings ?? []).map((binding) => [
              binding.sourceDocumentId,
              binding.assetId,
            ]),
          );
          const legacyScenes =
            shotBindings?.sceneAssetIds ??
            (shotBindings?.sceneAssetId ? [shotBindings.sceneAssetId] : []);
          references.sceneDocumentIds.forEach((documentId, index) => {
            if (shotBindings?.ignoreSceneBinding) return;
            const selectedAssetId = structuredScenes.get(documentId) ?? legacyScenes[index];
            const fallback = defaultMaterialByDocument.get(`scene:${documentId}`);
            if (selectedAssetId && fallback)
              addMaterial({ ...fallback, assetId: selectedAssetId, source: 'manual' });
            else if (selectedAssetId) {
              const document = db
                .prepare(
                  "SELECT title FROM documents WHERE id=? AND project_id=? AND kind='scene' AND lifecycle_status='active'",
                )
                .get(documentId, project.id) as { title: string } | undefined;
              if (document)
                addMaterial({
                  id: `scene:${documentId}`,
                  role: 'scene',
                  label: document.title,
                  assetId: selectedAssetId,
                  sourceDocumentId: documentId,
                  source: 'manual',
                });
            } else if (fallback) addMaterial(fallback);
          });
          for (const documentId of references.propDocumentIds) {
            const fallback = defaultMaterialByDocument.get(`prop:${documentId}`);
            if (fallback) addMaterial(fallback);
          }
        }
        const irMaterials = [...selectedMaterials.values()];
        imageBindings.push(...irMaterials);
        const characterSelections = new Map<string, SceneMaterialBindingInfo>();
        for (const { shot, references } of scopedReferences) {
          const shotBindings = shot.referenceBindings;
          const structuredCharacters = new Map(
            (shotBindings?.characterBindings ?? []).map((binding) => [
              binding.characterDocumentId,
              binding.assetId,
            ]),
          );
          const legacyCharacters =
            shotBindings?.characterAssetIds ??
            (shotBindings?.characterAssetId ? [shotBindings.characterAssetId] : []);
          references.characterDocumentIds.forEach((documentId, index) => {
            const selectedAssetId = structuredCharacters.get(documentId) ?? legacyCharacters[index];
            if (selectedAssetId)
              characterSelections.set(`${documentId}:${selectedAssetId}`, {
                id: `character:${documentId}:${selectedAssetId}`,
                role: 'character',
                label: this.documentTitle(db, project.id, documentId),
                assetId: selectedAssetId,
                source: 'manual',
                sourceDocumentId: documentId,
              });
          });
        }
        const media = resolveSceneMedia(this.projects, {
          characterDocumentIds: cast.map((binding) => binding.characterDocumentId),
          assetIds: [
            ...[...characterSelections.values()].map((binding) => binding.assetId),
            ...irMaterials.map((binding) => binding.assetId),
          ],
          voiceVersionIds: cast.flatMap((binding) =>
            binding.voiceReferenceVersionId ? [binding.voiceReferenceVersionId] : [],
          ),
        });
        for (const binding of cast) {
          const selected = [...characterSelections.values()].filter(
            (item) => item.sourceDocumentId === binding.characterDocumentId,
          );
          const defaultImage = media.characters.find(
            (character) => character.characterDocumentId === binding.characterDocumentId,
          )?.defaultImage;
          if (!selected.length && defaultImage && !binding.imageDisabled)
            selected.push({
              id: `cast-${binding.characterDocumentId}`,
              role: 'character',
              label: this.documentTitle(db, project.id, binding.characterDocumentId),
              assetId: defaultImage.id,
              source: 'auto',
              sourceDocumentId: binding.characterDocumentId,
            });
          for (const selection of selected) {
            imageBindings.push(selection);
            if (!binding.imageAssetId) binding.imageAssetId = selection.assetId;
          }
        }
        const names = Object.fromEntries(
          cast.map((binding) => [
            binding.characterDocumentId,
            this.documentTitle(db, project.id, binding.characterDocumentId),
          ]),
        );
        sceneInputs = {
          scene: { ...scene, characterBindings: cast, materialBindings: irMaterials },
          media,
          characterNames: names,
        };
      }

      return { sceneInputs, imageBindings, materialReferences };
    });
  }

  readMediaForAgent(target: ProductionTarget) {
    this.assertTarget(target);
    if (target.kind !== 'scene' && target.kind !== 'shot')
      throw new Error('媒体视图用于场次或镜头；单个素材来源使用 asset.get。');
    const { sceneInputs, imageBindings, materialReferences } = this.resolveSceneInputs(target);
    return productionMediaView(
      this.projects,
      target,
      sceneInputs,
      imageBindings,
      materialReferences,
      {
        imageGeneration: this.defaultImages(target, false),
        videoGeneration: this.defaultImages(target, true),
      },
    );
  }

  compile(params: ProductionCompileParams): ProductionCompileResult {
    const adapter = getAdapter(params.adapterKey);
    if (!adapter) throw new Error('制作模型不存在。');
    const read = this.read(params.target, params.shotIds);
    const selected =
      params.inputImages ??
      this.defaultImages(params.target, adapter.capability.endsWith('_VIDEO'));
    const source = this.formSource(params.target, params.shotIds, selected);
    if (params.expectedToken && params.expectedToken !== source.token)
      throw new Error('制作来源已变化，请重新适配。');
    if (!read.compiledPrompt && ['scene', 'shot'].includes(params.target.kind)) {
      const { sceneInputs } = this.resolveSceneInputs(params.target, params.shotIds);
      return {
        ...read,
        parameters: {},
        source,
        ...(sceneInputs ? { sceneInputs } : {}),
      };
    }

    return this.projects.access(false, (db, project) => {
      const issues = [...read.issues];
      const notices: ProductionIssue[] = [];
      const continuityState =
        params.target.kind === 'shot'
          ? readShotContinuity(db, project.id, params.target.id)
          : undefined;
      const continuity = continuityState?.binding;
      const video = adapter.capability.endsWith('_VIDEO');
      const { sceneInputs, imageBindings } = this.resolveSceneInputs(params.target, params.shotIds);

      const ir = read.authoringIR ?? {
        schemaVersion: 1 as const,
        kind: 'scene' as const,
        prompt: read.compiledPrompt ?? '',
      };
      const compiled = compileProductionParameters(ir, adapter, {
        prompt:
          !video && continuity?.imagePrompt !== undefined
            ? (continuity.imagePrompt ?? read.compiledPrompt ?? ir.prompt)
            : (read.compiledPrompt ?? ir.prompt),
        estimatedDurationSeconds: read.estimatedDurationSeconds,
        generation: this.getDefaults().settings.generation,
      });
      issues.push(...compiled.issues);
      notices.push(...compiled.notices);

      const inputs =
        selected.length || params.inputImages !== undefined
          ? selected.map((image) => ({ ...image, url: `project-asset://${image.assetId}` }))
          : imageBindings.map((binding) => ({
              role:
                binding.role === 'other' || binding.role === 'prop'
                  ? ('reference' as const)
                  : binding.role,
              url: `project-asset://${binding.assetId}`,
              label: binding.label,
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
        )
          issues.push({
            code: 'INVALID_INPUT_IMAGE',
            message: '选用的制作图片不可用，请重新选择。',
          });
      }
      try {
        if (inputs.length || params.inputImages !== undefined)
          compiled.parameters = seedProductionInputs(
            adapter,
            compiled.parameters,
            undefined,
            inputs,
          );
        if (productionFrameInputConflict(adapter, compiled.parameters, selected))
          issues.push({
            code: 'INPUT_SELECTION_CONFLICT',
            message:
              '已保留全部图片；当前模型不能同时使用这些首帧与参考素材用途，请在表单选择用途或更换模型。',
          });
      } catch (error) {
        issues.push({
          code: 'INPUT_SELECTION_CONFLICT',
          message: error instanceof Error ? error.message : '制作素材用途不符合当前模式。',
        });
      }
      const duration = Number(compiled.parameters.duration);
      const result: ProductionCompileResult = {
        ...read,
        parameters: compiled.parameters,
        source,
        notices,
        issues,
        ...(sceneInputs ? { sceneInputs } : {}),
        ...(continuityState?.binding ? { continuity: continuityState } : {}),
        ...(Number.isFinite(duration) && duration > 0
          ? { requestedDurationSeconds: duration }
          : {}),
      };
      if (read.timeline?.length) result.segments = planSegments(read.timeline, adapter);
      return result;
    });
  }

  private assertTarget(target: ProductionTarget): void {
    if (
      !target ||
      !['character', 'setting', 'scene', 'shot'].includes(target.kind) ||
      typeof target.id !== 'string' ||
      !target.id.trim() ||
      target.id.length > 200 ||
      Object.keys(target).some((field) => !['kind', 'id'].includes(field))
    )
      throw new Error('制作目标无效。');
  }

  private findShot(content: ContentService, shotId: string) {
    const repositories = this.projects.access(false, (db) => createRepositories(db));
    const shot = repositories.shots.get(shotId);
    if (!shot) throw new Error('制作镜头不存在。');
    const scene = content.listScenes().find((item) => item.id === shot.sceneId);
    if (!scene) throw new Error('镜头所属场次不存在。');
    const activeShot = content.listShots(scene.id).find((item) => item.id === shotId);
    if (!activeShot) throw new Error('制作镜头已归档或不存在，请先恢复。');
    return activeShot;
  }

  private defaultImages(target: ProductionTarget, video: boolean) {
    if (target.kind !== 'shot') return [];
    return this.projects.access(false, (db, project) => {
      const binding = readShotContinuity(db, project.id, target.id).binding;
      if (!binding) return [];
      if (video) {
        return [
          ...continuityReferenceImageIds(binding)
            .filter((id) => id !== binding.firstFrameAssetId)
            .map((assetId) => ({ assetId, role: 'reference' as const })),
          ...(binding.firstFrameAssetId
            ? [{ assetId: binding.firstFrameAssetId, role: 'first-frame' as const }]
            : []),
        ];
      }
      return !video
        ? continuitySourceImageIds(binding).map((assetId) => ({
            assetId,
            role: 'reference' as const,
          }))
        : [];
    });
  }

  private formSource(
    target: ProductionTarget,
    shotIds?: string[],
    inputImages?: ProductionFormSource['inputImages'],
  ): ProductionFormSource {
    const normalizedImages = inputImages?.map((image) => ({ ...image }));
    const token = this.projects.access(false, (db, project) => {
      const imageState = (normalizedImages ?? []).map(
        (image) =>
          db
            .prepare(
              'SELECT id,content_hash,size_bytes,relative_path,deleted_at FROM assets WHERE id=? AND project_id=?',
            )
            .get(image.assetId, project.id) ?? null,
      );
      const continuity =
        target.kind === 'shot' ? readShotContinuity(db, project.id, target.id) : undefined;
      return hash([this.queryVersion(target), shotIds, normalizedImages, imageState, continuity]);
    });
    return {
      mode: 'form',
      target,
      token,
      ...(shotIds ? { shotIds: [...shotIds] } : {}),
      ...(normalizedImages ? { inputImages: normalizedImages } : {}),
    };
  }

  private documentTitle(db: Database.Database, projectId: string, id: string): string {
    const row = db
      .prepare(
        "SELECT title FROM documents WHERE id=? AND project_id=? AND lifecycle_status='active'",
      )
      .get(id, projectId) as { title: string } | undefined;
    return row?.title ?? '资料';
  }
}

function planSegments(
  timeline: NonNullable<ProductionReadResult['timeline']>,
  adapter: NonNullable<ReturnType<typeof getAdapter>>,
): ProductionSegment[] {
  if (timeline.some((shot) => shot.estimatedDurationSeconds === undefined)) return [];
  const schema = adapter.parameterSchema.properties.duration;
  if (!schema) return [];
  const limits = schema.enum?.map(Number).filter(Number.isFinite) ?? [];
  const max = limits.length ? Math.max(...limits) : Number(schema.maximum ?? 3600);
  if (!Number.isFinite(max) || max <= 0) return [];
  const segments: ProductionSegment[] = [];
  let current: ProductionSegment | undefined;
  for (const shot of timeline) {
    const seconds = shot.estimatedDurationSeconds;
    if (seconds === undefined) continue;
    if (current && current.estimatedDurationSeconds + seconds > max) {
      segments.push(current);
      current = undefined;
    }
    if (!current) current = { shotIds: [], estimatedDurationSeconds: 0 };
    current.shotIds.push(shot.shotId);
    current.estimatedDurationSeconds += seconds;
    if (seconds > max) current.needsShotRevision = true;
  }
  if (current) segments.push(current);
  for (const segment of segments) {
    const resolved = resolveProductionDuration(adapter, segment.estimatedDurationSeconds);
    if (resolved !== undefined) segment.requestedDurationSeconds = resolved;
    else segment.needsShotRevision = true;
  }
  return segments;
}
