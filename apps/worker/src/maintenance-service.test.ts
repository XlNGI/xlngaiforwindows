import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MaintenanceService, redactDiagnosticText } from './maintenance-service.js';
import { ProjectService } from './project-service.js';

const temporaryDirectories: string[] = [];
const projectServices: ProjectService[] = [];

afterEach(async () => {
  for (const projectService of projectServices.splice(0)) projectService.close();
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function temporaryRoot(name: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `ai-video-m7-${name}-`));
  temporaryDirectories.push(root);
  return root;
}

function createProjectService(recentProjectsPath: string): ProjectService {
  const projectService = new ProjectService({ recentProjectsPath });
  projectServices.push(projectService);
  return projectService;
}

describe('MaintenanceService', () => {
  it('redacts credentials, URLs, data payloads, and absolute paths with a length bound', () => {
    const secret = 'sk-live-secret-value';
    const text = [
      `Authorization: Bearer ${secret}`,
      `api_key=${secret}`,
      'https://provider.example/result.png?X-Amz-Signature=signed-secret',
      'data:image/png;base64,aGVsbG8=',
      'D:\\Private\\Project\\project.sqlite',
      'x'.repeat(2_000),
    ].join(' ');

    const redacted = redactDiagnosticText(text);
    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain('provider.example');
    expect(redacted).not.toContain('aGVsbG8');
    expect(redacted).not.toContain('D:\\Private');
    expect(redacted).toContain('[REDACTED]');
    expect(redacted.length).toBeLessThanOrEqual(1_024);
  });

  it('exports a bounded diagnostic package without project content or sensitive errors', async () => {
    const base = await temporaryRoot('diagnostics');
    const projectRoot = join(base, 'private-project');
    const destinationRoot = join(base, 'support-output');
    const projects = createProjectService(join(base, 'recent.json'));
    projects.create(projectRoot, 'Confidential Drama Title');
    const openedPaths: string[] = [];
    const maintenance = new MaintenanceService(projects, {
      openPath: (path) => openedPaths.push(path),
    });
    maintenance.recordError(
      'provider.submit',
      new Error(
        `Bearer sk-sensitive https://api.example/task?id=1 data:image/png;base64,c2VjcmV0 ${projectRoot}`,
      ),
    );

    const result = maintenance.exportDiagnostics({ destinationRoot });
    const manifest = await readFile(join(result.path, 'manifest.json'), 'utf8');
    const report = await readFile(join(result.path, 'report.json'), 'utf8');
    const combined = manifest + report;

    expect(result).toMatchObject({ manifestVersion: 1, fileCount: 2 });
    expect(combined).not.toContain('sk-sensitive');
    expect(combined).not.toContain('api.example');
    expect(combined).not.toContain('c2VjcmV0');
    expect(combined).not.toContain(projectRoot);
    expect(combined).not.toContain('Confidential Drama Title');
    expect(combined).not.toContain('project.sqlite');
    expect(combined).toContain('[REDACTED]');
    expect(Buffer.byteLength(report)).toBeLessThanOrEqual(256 * 1_024);

    expect(maintenance.revealDiagnostics(result.path)).toEqual({ path: result.path });
    expect(openedPaths).toEqual([result.path]);
    expect(() => maintenance.revealDiagnostics(base)).toThrow('not created by this Worker');
  });

  it('inspects and clears only cache content without following directory links', async () => {
    const base = await temporaryRoot('cache');
    const projectRoot = join(base, 'project');
    const outside = join(base, 'outside');
    const projects = createProjectService(join(base, 'recent.json'));
    projects.create(projectRoot, 'Cache Project');
    await mkdir(join(projectRoot, 'cache', 'nested'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(projectRoot, 'cache', 'one.bin'), Buffer.alloc(5));
    await writeFile(join(projectRoot, 'cache', 'nested', 'two.bin'), Buffer.alloc(7));
    await writeFile(join(outside, 'sentinel.txt'), 'keep');
    await symlink(outside, join(projectRoot, 'cache', 'outside-link'), 'junction');
    const maintenance = new MaintenanceService(projects);

    expect(maintenance.inspectCache()).toEqual({
      fileCount: 2,
      directoryCount: 1,
      sizeBytes: 12,
      skippedLinks: 1,
    });
    expect(maintenance.clearCache()).toEqual({
      removedFiles: 2,
      removedDirectories: 1,
      freedBytes: 12,
      removedLinks: 1,
    });
    expect(maintenance.inspectCache()).toEqual({
      fileCount: 0,
      directoryCount: 0,
      sizeBytes: 0,
      skippedLinks: 0,
    });
    expect(existsSync(join(outside, 'sentinel.txt'))).toBe(true);
    expect(existsSync(join(projectRoot, 'assets'))).toBe(true);
    expect(existsSync(join(projectRoot, 'project.sqlite'))).toBe(true);
  });

  it('cleans only old unreferenced context snapshots', async () => {
    const base = await temporaryRoot('context-cleanup');
    const projectRoot = join(base, 'project');
    const projects = createProjectService(join(base, 'recent.json'));
    const project = projects.create(projectRoot, 'Context Project');
    const maintenance = new MaintenanceService(projects, {
      now: () => new Date('2026-08-16T00:00:00.000Z'),
    });
    projects.access(true, (database) => {
      const insert = database.prepare(
        `INSERT INTO context_snapshots (id, project_id, purpose, content_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      insert.run(
        'old-unreferenced',
        project.id,
        'llm-generation',
        '{}',
        '2026-01-01T00:00:00.000Z',
      );
      insert.run(
        'recent-unreferenced',
        project.id,
        'llm-generation',
        '{}',
        '2026-08-01T00:00:00.000Z',
      );
    });

    expect(maintenance.cleanupContextSnapshots({ olderThanDays: 90 })).toEqual({
      removedCount: 1,
      retainedCount: 1,
    });
    projects.access(false, (database) => {
      const row = database
        .prepare('SELECT COUNT(*) AS count FROM context_snapshots WHERE id = ?')
        .get('old-unreferenced') as { count: number };
      expect(row.count).toBe(0);
    });
  });

  it('exposes request metrics with association ids', async () => {
    const base = await temporaryRoot('metrics');
    const projects = createProjectService(join(base, 'recent.json'));
    const maintenance = new MaintenanceService(projects);
    maintenance.recordRequest('chat.message.list', 'request-1', true, 10);
    maintenance.recordRequest('chat.message.list', 'request-2', true, 20);
    maintenance.recordRequest('llm.generate', 'request-3', false, 5);

    const metrics = maintenance.getMetrics();
    expect(metrics.totals).toEqual({
      requests: 3,
      ok: 2,
      errors: 1,
      totalDurationMs: 35,
      maxDurationMs: 20,
    });
    expect(metrics.recentRequests.map((item) => item.requestId)).toEqual([
      'request-3',
      'request-2',
      'request-1',
    ]);
    expect(
      metrics.byOperation.find((item) => item.operation === 'chat.message.list'),
    ).toMatchObject({
      requests: 2,
      ok: 2,
      errors: 0,
      totalDurationMs: 30,
      maxDurationMs: 20,
      recentRequestIds: ['request-1', 'request-2'],
    });
  });

  it('tracks generation first-token and provider metrics', async () => {
    const base = await temporaryRoot('generation-metrics');
    const projects = createProjectService(join(base, 'recent.json'));
    const maintenance = new MaintenanceService(projects);
    maintenance.recordGenerationMetric({
      generationId: 'generation-1',
      providerName: 'OpenAI',
      modelId: 'gpt-test',
      status: 'complete',
      startedAt: '2026-08-16T00:00:00.000Z',
      firstTokenAt: '2026-08-16T00:00:02.000Z',
      completedAt: '2026-08-16T00:00:05.000Z',
      inputTokens: 10,
      outputTokens: 5,
      estimatedCost: '0.0001',
    });

    const metrics = maintenance.getMetrics();
    expect(metrics.generationTotals).toEqual({
      attempts: 1,
      complete: 1,
      failed: 0,
      cancelled: 0,
      totalDurationMs: 5_000,
      maxDurationMs: 5_000,
      maxFirstTokenMs: 2_000,
    });
    expect(metrics.byProvider).toEqual([
      expect.objectContaining({
        providerName: 'OpenAI',
        attempts: 1,
        complete: 1,
        maxFirstTokenMs: 2_000,
      }),
    ]);
    expect(metrics.recentGenerations[0]).toMatchObject({
      generationId: 'generation-1',
      providerName: 'OpenAI',
      status: 'complete',
    });
  });

  it('allows cache inspection but refuses cache clearing from a read-only session', async () => {
    const base = await temporaryRoot('readonly-cache');
    const projectRoot = join(base, 'project');
    const writer = createProjectService(join(base, 'writer-recent.json'));
    writer.create(projectRoot, 'Writer');
    await writeFile(join(projectRoot, 'cache', 'keep.bin'), 'keep');
    const reader = createProjectService(join(base, 'reader-recent.json'));
    expect(reader.open(projectRoot).mode).toBe('read-only');
    const maintenance = new MaintenanceService(reader);

    expect(maintenance.inspectCache().fileCount).toBe(1);
    expect(() => maintenance.clearCache()).toThrow('read-only');
    expect(existsSync(join(projectRoot, 'cache', 'keep.bin'))).toBe(true);
  });
});
