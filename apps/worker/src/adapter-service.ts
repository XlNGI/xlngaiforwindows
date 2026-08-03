import { createHash, randomUUID } from 'node:crypto';
import type {
  AdapterCatalogResult,
  AdapterDescriptor,
  AdapterResolveParams,
  AdapterValidateParams,
  AdapterValidationResult,
  GenerationDraftGetParams,
  GenerationDraftInfo,
  GenerationDraftSaveParams,
} from '@ai-video/contracts';
import {
  getAdapter,
  getAdapterCatalog,
  resolveAdapter,
  validateAdapterParameters,
} from '@ai-video/generation-adapters';
import { createRepositories } from '@ai-video/persistence';
import type { ProjectService } from './project-service.js';

export class AdapterNotFoundError extends Error {}

export class InvalidAdapterParametersError extends Error {
  constructor(readonly validation: AdapterValidationResult) {
    super('生产参数未通过适配器 Schema 校验。');
  }
}

export class AdapterService {
  constructor(private readonly projects: ProjectService) {}

  catalog(): AdapterCatalogResult {
    return getAdapterCatalog();
  }

  resolve(params: AdapterResolveParams): AdapterDescriptor {
    try {
      return resolveAdapter(params);
    } catch (error) {
      throw new AdapterNotFoundError(error instanceof Error ? error.message : '适配器不存在。');
    }
  }

  validate(params: AdapterValidateParams): AdapterValidationResult {
    return validateAdapterParameters(params.adapterKey, params.parameters);
  }

  getDraft(params: GenerationDraftGetParams): GenerationDraftInfo | null {
    this.requireAdapter(params.adapterKey);
    const storageKey = draftStorageKey(params);
    return this.projects.access(false, (database, project) => {
      const repositories = createRepositories(database);
      this.requireProjectShot(repositories, project.id, params.shotId);
      const draft = repositories.generationDrafts.get(params.shotId, storageKey);
      return draft
        ? {
            id: draft.id,
            shotId: draft.shotId,
            adapterKey: params.adapterKey,
            parameters: JSON.parse(draft.parametersJson) as GenerationDraftInfo['parameters'],
            updatedAt: draft.updatedAt,
          }
        : null;
    });
  }

  saveDraft(params: GenerationDraftSaveParams): GenerationDraftInfo {
    this.requireAdapter(params.adapterKey);
    const storageKey = draftStorageKey(params);
    const validation = validateAdapterParameters(params.adapterKey, params.parameters);
    if (!validation.valid) throw new InvalidAdapterParametersError(validation);
    if (containsLocalImageData(params.parameters)) {
      throw new InvalidAdapterParametersError({
        valid: false,
        errors: [{ path: 'images', message: '本地图片仅用于当前提交，不能写入项目草稿。' }],
      });
    }

    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      this.requireProjectShot(repositories, project.id, params.shotId);
      const existing = repositories.generationDrafts.get(params.shotId, storageKey);
      const saved = {
        id: existing?.id ?? randomUUID(),
        shotId: params.shotId,
        adapterKey: storageKey,
        parametersJson: JSON.stringify(params.parameters),
        updatedAt: new Date().toISOString(),
      };
      repositories.generationDrafts.save(saved);
      return {
        id: saved.id,
        shotId: saved.shotId,
        adapterKey: params.adapterKey,
        parameters: params.parameters,
        updatedAt: saved.updatedAt,
      };
    });
  }

  private requireAdapter(adapterKey: string): void {
    if (!getAdapter(adapterKey)) throw new AdapterNotFoundError('适配器不存在。');
  }

  private requireProjectShot(
    repositories: ReturnType<typeof createRepositories>,
    projectId: string,
    shotId: string,
  ): void {
    const shot = repositories.shots.get(shotId);
    const scene = shot ? repositories.scenes.get(shot.sceneId) : undefined;
    if (!shot || !scene || scene.projectId !== projectId) {
      throw new Error('镜头不属于当前项目。');
    }
  }
}

function draftStorageKey(params: GenerationDraftGetParams): string {
  if (params.providerProfileId === undefined && params.modelId === undefined) {
    return params.adapterKey;
  }
  if (!params.providerProfileId || !params.modelId) {
    throw new Error('Provider profile and model are both required for a scoped draft.');
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      params.providerProfileId,
    )
  ) {
    throw new Error('Provider profile ID is invalid.');
  }
  const modelId = params.modelId.trim();
  if (!modelId || modelId.length > 200 || [...modelId].some((value) => value.charCodeAt(0) < 32)) {
    throw new Error('Provider model ID is invalid.');
  }
  const scope = createHash('sha256')
    .update(params.providerProfileId.toLowerCase())
    .update('\0')
    .update(modelId)
    .digest('hex')
    .slice(0, 24);
  return `${params.adapterKey}::${scope}`;
}

function containsLocalImageData(parameters: GenerationDraftSaveParams['parameters']): boolean {
  return Object.values(parameters).some((value) =>
    Array.isArray(value)
      ? value.some((item) => item.toLowerCase().startsWith('data:image/'))
      : typeof value === 'string' && value.toLowerCase().startsWith('data:image/'),
  );
}
