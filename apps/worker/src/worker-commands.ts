import type { WorkerMethod } from '@ai-video/contracts';
import type { AppSettingsService } from './app-settings-service.js';
import type { AgentProviderLoopService } from './agent-provider-loop-service.js';
import type { GenerationService } from './generation-service.js';
import type { ImageGenerationService } from './image-generation-service.js';
import type { MaintenanceService } from './maintenance-service.js';
import type { MarkdownExportService } from './markdown-export-service.js';
import type { ProjectService } from './project-service.js';
import type { PartialArtifactService } from './partial-artifact-service.js';
import type { SampleProjectService } from './sample-project-service.js';
import type { UsageService } from './usage-service.js';
import type { VideoGenerationService } from './video-generation-service.js';

export interface InfrastructureCommandServices {
  projectService: ProjectService;
  sampleProjectService: SampleProjectService;
  appSettingsService: AppSettingsService;
  usageService: UsageService;
  maintenanceService: MaintenanceService;
  generationService: GenerationService;
  imageGenerationService: ImageGenerationService;
  videoGenerationService: VideoGenerationService;
  agentProviderLoopService: AgentProviderLoopService;
  partialArtifactService: PartialArtifactService;
  markdownExportService: MarkdownExportService;
}

export interface InfrastructureCommandResult {
  handled: boolean;
  result?: unknown;
}

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string') throw new Error(`${key} must be a string.`);
  return value;
}

async function resetRuntime(services: InfrastructureCommandServices): Promise<void> {
  await services.generationService.cancelAll();
  services.imageGenerationService.cancelAll();
  services.videoGenerationService.cancelAll();
  services.maintenanceService.resetSession();
}

function recoverRuntime(services: InfrastructureCommandServices): void {
  services.partialArtifactService.recoverInterrupted();
  services.generationService.recoverInterrupted();
  services.agentProviderLoopService.recoverInterrupted();
  services.imageGenerationService.recoverInterrupted();
  services.videoGenerationService.recoverInterrupted();
  services.partialArtifactService.expire();
  services.markdownExportService.reconcile();
  services.maintenanceService.cleanupResearchCache();
}

export async function executeInfrastructureCommand(
  method: WorkerMethod,
  params: Record<string, unknown>,
  services: InfrastructureCommandServices,
): Promise<InfrastructureCommandResult> {
  switch (method) {
    case 'project.create': {
      const rootPath = requireString(params, 'rootPath');
      const name = requireString(params, 'name');
      await resetRuntime(services);
      const result = services.projectService.create(rootPath, name);
      recoverRuntime(services);
      return { handled: true, result };
    }
    case 'project.createSample': {
      const rootPath = requireString(params, 'rootPath');
      const name = typeof params.name === 'string' ? params.name : undefined;
      await resetRuntime(services);
      const result = services.sampleProjectService.create({ rootPath, name });
      recoverRuntime(services);
      return { handled: true, result };
    }
    case 'project.open': {
      const rootPath = requireString(params, 'rootPath');
      await resetRuntime(services);
      const result = services.projectService.open(rootPath);
      recoverRuntime(services);
      return { handled: true, result };
    }
    case 'project.close':
      await resetRuntime(services);
      services.projectService.close();
      return { handled: true, result: { closed: true } };
    case 'project.current':
      return { handled: true, result: services.projectService.current() ?? null };
    case 'project.recent':
      return { handled: true, result: services.projectService.listRecent() };
    case 'project.integrity':
      return { handled: true, result: services.projectService.integrity() };
    case 'project.backup':
      return {
        handled: true,
        result: {
          path: await services.projectService.backup(
            typeof params.destinationPath === 'string' ? params.destinationPath : undefined,
          ),
        },
      };
    case 'project.export':
      return {
        handled: true,
        result: {
          path: await services.projectService.exportProject(
            requireString(params, 'destinationRoot'),
          ),
        },
      };
    case 'project.restore': {
      const backupPath = requireString(params, 'backupPath');
      const destinationRoot = requireString(params, 'destinationRoot');
      await resetRuntime(services);
      const result = services.projectService.restore(backupPath, destinationRoot);
      recoverRuntime(services);
      return { handled: true, result };
    }
    case 'provider.profile.list':
      return {
        handled: true,
        result: services.appSettingsService.listProfiles(params.includeArchived === true),
      };
    case 'provider.profile.get':
      return {
        handled: true,
        result: services.appSettingsService.getProfile(requireString(params, 'profileId')),
      };
    case 'provider.profile.create':
      return {
        handled: true,
        result: services.appSettingsService.createProfile(
          params as unknown as Parameters<AppSettingsService['createProfile']>[0],
        ),
      };
    case 'provider.profile.update':
      return {
        handled: true,
        result: services.appSettingsService.updateProfile(
          params as unknown as Parameters<AppSettingsService['updateProfile']>[0],
        ),
      };
    case 'provider.profile.archive':
      return {
        handled: true,
        result: services.appSettingsService.archiveProfile(requireString(params, 'profileId')),
      };
    case 'provider.profile.migrateLegacy':
      return {
        handled: true,
        result: services.appSettingsService.migrateLegacyProfile(
          params as unknown as Parameters<AppSettingsService['migrateLegacyProfile']>[0],
        ),
      };
    case 'provider.definition.list':
      return { handled: true, result: services.appSettingsService.listProviderDefinitions() };
    case 'provider.connection.begin':
      return {
        handled: true,
        result: services.appSettingsService.beginConnectionTest(requireString(params, 'profileId')),
      };
    case 'provider.connection.complete':
      return {
        handled: true,
        result: services.appSettingsService.completeConnectionTest(
          params as unknown as Parameters<AppSettingsService['completeConnectionTest']>[0],
        ),
      };
    case 'provider.model.list':
      return {
        handled: true,
        result: services.appSettingsService.listModels(requireString(params, 'profileId')),
      };
    case 'provider.model.createManual':
      return {
        handled: true,
        result: services.appSettingsService.createManualModel(
          params as unknown as Parameters<AppSettingsService['createManualModel']>[0],
        ),
      };
    case 'provider.model.update':
      return {
        handled: true,
        result: services.appSettingsService.updateModel(
          params as unknown as Parameters<AppSettingsService['updateModel']>[0],
        ),
      };
    case 'provider.model.pricing.list':
      return {
        handled: true,
        result: services.appSettingsService.listModelPricing(requireString(params, 'profileId')),
      };
    case 'provider.model.pricing.update':
      return {
        handled: true,
        result: services.appSettingsService.updateModelPricing(
          params as unknown as Parameters<AppSettingsService['updateModelPricing']>[0],
        ),
      };
    case 'provider.default.list':
      return { handled: true, result: services.appSettingsService.listProviderDefaults() };
    case 'provider.default.update':
      return {
        handled: true,
        result: services.appSettingsService.updateProviderDefault(
          params as unknown as Parameters<AppSettingsService['updateProviderDefault']>[0],
        ),
      };
    case 'usage.list':
      return {
        handled: true,
        result: services.usageService.list(
          params as unknown as Parameters<UsageService['list']>[0],
        ),
      };
    case 'usage.rebuild':
      return { handled: true, result: services.usageService.rebuild() };
    case 'maintenance.cache.inspect':
      return { handled: true, result: services.maintenanceService.inspectCache() };
    case 'maintenance.cache.clear':
      return { handled: true, result: services.maintenanceService.clearCache() };
    case 'maintenance.researchCache.cleanup':
      return {
        handled: true,
        result: services.maintenanceService.cleanupResearchCache(
          typeof params.maxBytes === 'number' ? params.maxBytes : undefined,
        ),
      };
    case 'maintenance.metrics':
      return { handled: true, result: services.maintenanceService.getMetrics() };
    case 'maintenance.contextSnapshots.cleanup':
      return {
        handled: true,
        result: services.maintenanceService.cleanupContextSnapshots(params),
      };
    case 'maintenance.diagnostics.export': {
      const destinationRoot =
        typeof params.destinationRoot === 'string' ? params.destinationRoot : undefined;
      return {
        handled: true,
        result: services.maintenanceService.exportDiagnostics({ destinationRoot }),
      };
    }
    case 'maintenance.diagnostics.reveal':
      return {
        handled: true,
        result: services.maintenanceService.revealDiagnostics(requireString(params, 'path')),
      };
    default:
      return { handled: false };
  }
}
