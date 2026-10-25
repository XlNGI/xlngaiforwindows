import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRepositories, readShotContinuity } from '@ai-video/persistence';
import { getAdapterCatalog } from '@ai-video/generation-adapters';
import { ProjectService } from './project-service.js';
import { ContentService } from './content-service.js';
import { ImageGenerationService } from './image-generation-service.js';
import { ShotContinuityService } from './shot-continuity-service.js';
import { ProductionService } from './production-service.js';
import { validateSessionRequestParams } from './request-validation.js';
import type { GenerationService } from './generation-service.js';
import type { AppSettingsService } from './app-settings-service.js';
import type { WorkerMethod, WorkerMethodMap } from '@ai-video/contracts';

const owners: { projects: ProjectService; root: string }[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) {
    owner.projects.close();
    await rm(owner.root, { recursive: true, force: true });
  }
});
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
const executable = resolve('../desktop/src-tauri/resources/ffmpeg/ffmpeg.exe');
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'shot continuity 中文 '));
  const projects = new ProjectService({ recentProjectsPath: join(root, 'recent.json') });
  owners.push({ projects, root });
  const project = projects.create(join(root, 'project'), '桥上的人');
  const content = new ContentService(projects);
  const scene = content.saveScene({ title: '桥上' });
  const previous = content.saveShot({ sceneId: scene.id, title: '站在第三根桥柱旁' });
  const shot = content.saveShot({
    sceneId: scene.id,
    title: '转头',
    prompt: '人物双脚保持原位，缓慢转头。',
  });
  const id = randomUUID();
  const relativePath = `assets/videos/${id}.mp4`;
  const source = join(project.rootPath, relativePath);
  await mkdir(join(project.rootPath, 'assets', 'videos'), { recursive: true });
  execFileSync(
    executable,
    [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=s=160x120:r=25:d=2',
      '-c:v',
      'libopenh264',
      '-b:v',
      '1000000',
      '-pix_fmt',
      'yuv420p',
      source,
    ],
    { windowsHide: true, timeout: 30000 },
  );
  const bytes = await readFile(source);
  projects.access(true, (db) => {
    const repo = createRepositories(db);
    const now = new Date().toISOString();
    repo.assets.save({
      id,
      projectId: project.id,
      kind: 'shot-video',
      relativePath,
      contentHash: digest(bytes),
      sizeBytes: bytes.length,
      createdAt: now,
    });
    repo.jobs.save({
      id: 'source-job',
      projectId: project.id,
      shotId: previous.id,
      adapterKey: 'fixture',
      status: 'succeeded',
      mediaState: 'succeeded',
      requestJson: '{}',
      createdAt: now,
      updatedAt: now,
    });
    repo.generationResults.save({
      id: 'source-result',
      jobId: 'source-job',
      assetId: id,
      createdAt: now,
    });
  });
  const assets = new ImageGenerationService(projects);
  const prepare = vi.fn(() => ({ stream: { generationId: 'llm' } }));
  const service = new ShotContinuityService(
    projects,
    assets,
    undefined,
    undefined,
    { prepare } as unknown as GenerationService,
    {
      listModels: () => [
        { id: 'vision', capabilities: { vision: true } },
        { id: 'text', capabilities: { vision: false } },
      ],
      resolveLlmSelection: vi.fn(),
    } as unknown as AppSettingsService,
  );
  const preview = () => service.preview({ shotId: shot.id, videoAssetId: id, timeMs: 1000 });
  const confirm = async (mode: 'continue' | 'reframe' = 'continue', expectedRowVersion = 0) =>
    service.confirm({
      shotId: shot.id,
      videoAssetId: id,
      sourceToken: (await preview()).sourceToken,
      timesMs: [240, 1000],
      anchorTimeMs: 1000,
      mode,
      notes: '人物仍在第三根桥柱旁，脚不移动。',
      expectedRowVersion,
    });
  return {
    root,
    project,
    projects,
    content,
    previous,
    shot,
    id,
    source,
    assets,
    service,
    prepare,
    preview,
    confirm,
  };
}

describe.runIf(process.platform === 'win32')('manual shot continuity with real local video', () => {
  it('previews without adoption, then persists exact full-size selected frames and first-frame production inputs', async () => {
    const f = await fixture();
    expect(f.service.get(f.previous.id).previousShot).toBeUndefined();
    const preview = await f.preview();
    expect(preview).toMatchObject({ timeMs: 1000, durationMs: 2000, fps: 25 });
    expect(preview.dataUrl).toMatch(/^data:image\/jpeg;base64,/u);
    expect(f.assets.listAssets({})).toHaveLength(1);
    expect(await readdir(join(f.project.rootPath, 'cache', 'shot-continuity'))).toEqual([]);
    const confirmed = await f.confirm();
    expect(confirmed).toMatchObject({
      rowVersion: 1,
      stale: false,
      binding: { mode: 'continue', sourceShotId: f.previous.id, sourceVideoAssetId: f.id },
    });
    const anchor = confirmed.images.find(
      (asset) => asset.id === confirmed.binding?.firstFrameAssetId,
    )!;
    const png = await readFile(join(f.project.rootPath, anchor.relativePath));
    expect(png.readUInt32BE(16)).toBe(160);
    expect(png.readUInt32BE(20)).toBe(120);
    const extractedRaw = execFileSync(
      executable,
      [
        '-v',
        'error',
        '-i',
        join(f.project.rootPath, anchor.relativePath),
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-',
      ],
      { windowsHide: true },
    );
    const sourceRaw = execFileSync(
      executable,
      [
        '-v',
        'error',
        '-ss',
        '1',
        '-i',
        f.source,
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        '-',
      ],
      { windowsHide: true },
    );
    expect(digest(extractedRaw)).toBe(digest(sourceRaw));
    const adapter = getAdapterCatalog().adapters.find(
      (item) => item.capability === 'IMAGE_TO_VIDEO',
    )!;
    const production = new ProductionService(f.projects);
    const compiled = production.compile({
      target: { kind: 'shot', id: f.shot.id },
      adapterKey: adapter.key,
    });
    expect(compiled.issues).toEqual([]);
    expect(JSON.stringify(compiled.parameters)).toContain(anchor.id);
    expect(compiled.source?.inputImages).toContainEqual({
      assetId: anchor.id,
      role: 'first-frame',
    });
    expect(() =>
      production.assertSource(compiled.source, { kind: 'shot', id: f.shot.id }, adapter.key),
    ).not.toThrow();
    expect(() =>
      production.assertSource(compiled.source, { kind: 'shot', id: f.shot.id }, adapter.key, {
        parameters: { prompt: '实际提交移除了首帧' },
      }),
    ).toThrow('首帧');
    const path = f.project.rootPath;
    f.projects.close();
    f.projects.open(path);
    expect(f.service.get(f.shot.id).binding?.firstFrameAssetId).toBe(anchor.id);
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it('rejects wrong shots, missing adoption, unsupported LLMs, out of range time and modified source bytes', async () => {
    const f = await fixture();
    await expect(
      f.service.preview({ shotId: f.previous.id, videoAssetId: f.id, timeMs: 0 }),
    ).rejects.toThrow('上一镜头');
    await expect(
      f.service.preparePrompt({
        shotId: f.shot.id,
        expectedRowVersion: 0,
        kind: 'video',
        providerProfileId: 'profile',
        modelId: 'vision',
      }),
    ).rejects.toThrow('确认');
    await expect(
      f.service.preview({ shotId: f.shot.id, videoAssetId: f.id, timeMs: 2000 }),
    ).rejects.toThrow('时间点');
    await f.confirm();
    await expect(
      f.service.preparePrompt({
        shotId: f.shot.id,
        expectedRowVersion: 1,
        kind: 'video',
        providerProfileId: 'profile',
        modelId: 'text',
      }),
    ).rejects.toThrow('支持看图');
    await writeFile(f.source, 'modified source');
    await expect(f.preview()).rejects.toThrow('来源视频');
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it('sends only confirmed images to the LLM and preserves editable drafts with CAS and stale story protection', async () => {
    const f = await fixture();
    await f.confirm();
    await f.service.preparePrompt({
      shotId: f.shot.id,
      expectedRowVersion: 1,
      kind: 'video',
      providerProfileId: 'profile',
      modelId: 'vision',
    });
    expect(f.prepare).toHaveBeenCalledOnce();
    const request = f.prepare.mock.calls[0] as unknown as [
      { prompt: string; attachments: { dataUrl: string }[] },
    ];
    expect(request[0].attachments).toHaveLength(2);
    expect(request[0].prompt).toContain('人物双脚保持原位');
    expect(request[0].prompt).toContain('脚不移动');
    expect(request[0].attachments[0]?.dataUrl).toMatch(/^data:image\/jpeg;base64,/u);
    const saved = f.service.savePrompt(f.shot.id, 1, 'video', '  保持站位，轻轻转头。\n');
    expect(saved.stale).toBe(false);
    expect(saved.binding?.targetRowVersion).toBe(f.shot.rowVersion + 1);
    expect(() => f.service.savePrompt(f.shot.id, 1, 'video', '旧窗口文本')).toThrow('确认');
    expect(f.content.listShots(f.shot.sceneId).find((shot) => shot.id === f.shot.id)?.prompt).toBe(
      '  保持站位，轻轻转头。\n',
    );
    const production = new ProductionService(f.projects);
    expect(production.read({ kind: 'shot', id: f.shot.id }).authoringIR?.prompt).toBe(
      saved.binding?.videoPrompt,
    );
    f.content.saveShot({
      shotId: f.shot.id,
      sceneId: f.shot.sceneId,
      title: f.shot.title,
      prompt: '人物走下桥。',
      expectedRowVersion: saved.binding!.targetRowVersion,
    });
    expect(f.service.get(f.shot.id).stale).toBe(true);
    expect(() => f.service.savePrompt(f.shot.id, 2, 'video', '迟到输出')).toThrow('重新确认');
  });

  it('rolls back the shot IR when saving its continuity CAS fails', async () => {
    const f = await fixture();
    await f.confirm();
    const before = f.content.listShots(f.shot.sceneId);
    f.projects.access(true, (db) =>
      db.exec(`CREATE TRIGGER fail_continuity_prompt BEFORE UPDATE ON shot_continuity
      BEGIN SELECT RAISE(ABORT, 'continuity write failed'); END`),
    );
    expect(() => f.service.savePrompt(f.shot.id, 1, 'video', '不应保存')).toThrow(
      'continuity write failed',
    );
    expect(f.content.listShots(f.shot.sceneId)).toEqual(before);
    expect(f.service.get(f.shot.id).rowVersion).toBe(1);
  });

  it('keeps reframing separate from final first-frame adoption and invalidates prior production on a changed selection', async () => {
    const f = await fixture();
    const first = await f.confirm('reframe');
    expect(first.binding?.firstFrameAssetId).toBeUndefined();
    expect(() => f.service.savePrompt(f.shot.id, 1, 'video', '转头')).toThrow('首帧');
    const adapter = getAdapterCatalog().adapters.find(
      (item) => item.capability === 'IMAGE_TO_VIDEO',
    )!;
    const production = new ProductionService(f.projects);
    expect(
      production
        .compile({ target: { kind: 'shot', id: f.shot.id }, adapterKey: adapter.key })
        .issues.some((issue) => issue.code === 'CONTINUITY_FRAME_MISSING'),
    ).toBe(true);
    const direct = await f.confirm('continue', 1);
    const compiled = production.compile({
      target: { kind: 'shot', id: f.shot.id },
      adapterKey: adapter.key,
    });
    f.service.firstFrame(f.shot.id, direct.rowVersion, direct.binding!.frames[0]!.assetId);
    expect(() =>
      production.assertSource(compiled.source, { kind: 'shot', id: f.shot.id }, adapter.key),
    ).toThrow('来源已变化');
    expect(() => f.assets.deleteAsset(f.id)).toThrow('referenced');
    f.assets.deleteAsset(f.id, true);
    expect(f.service.get(f.shot.id).stale).toBe(true);
    expect(() => f.assets.purgeAsset(f.id, true)).toThrow('镜头衔接');
  });

  it('rolls back files, assets, results and selection together after a database failure', async () => {
    const f = await fixture();
    f.projects.access(true, (db) =>
      db.exec(
        "CREATE TRIGGER fail_frame BEFORE INSERT ON assets WHEN NEW.kind='first-frame' BEGIN SELECT RAISE(ABORT,'fixture frame failure'); END",
      ),
    );
    await expect(f.confirm()).rejects.toThrow('fixture frame failure');
    expect(f.service.get(f.shot.id).rowVersion).toBe(0);
    expect(f.assets.listAssets({})).toHaveLength(1);
    expect(await readdir(join(f.project.rootPath, 'assets', 'images'))).toEqual([]);
    expect(await readdir(join(f.project.rootPath, 'cache', 'shot-continuity'))).toEqual([]);
  });

  it('cancels extraction on shutdown without adopting anything', async () => {
    const f = await fixture();
    const pending = f.preview();
    f.service.cancelAll();
    await expect(pending).rejects.toThrow('运行已结束');
    expect(f.service.get(f.shot.id).rowVersion).toBe(0);
    expect(f.assets.listAssets({})).toHaveLength(1);
  });

  it('preserves committed frame files if the result view fails after the transaction', async () => {
    const f = await fixture();
    const original = f.service.get.bind(f.service);
    const view = vi.spyOn(f.service, 'get').mockImplementation((shotId) => {
      const version = f.projects.access(
        false,
        (db, project) => readShotContinuity(db, project.id, shotId).rowVersion,
      );
      if (version > 0) throw new Error('fixture result read failure');
      return original(shotId);
    });
    await expect(f.confirm()).rejects.toThrow('fixture result read failure');
    view.mockRestore();
    expect(f.service.get(f.shot.id).stale).toBe(false);
    expect(f.service.get(f.shot.id).rowVersion).toBe(1);
    expect(await readdir(join(f.project.rootPath, 'assets', 'images'))).toHaveLength(2);
  });

  it('uses a separately confirmed new composition when prompting a reframed video', async () => {
    const f = await fixture();
    const selected = await f.confirm('reframe');
    const anchor = selected.images.find((asset) => asset.id === selected.binding?.anchorAssetId)!;
    const imageAdapter = getAdapterCatalog().adapters.find(
      (adapter) => adapter.capability === 'REFERENCE_TO_IMAGE',
    )!;
    const production = new ProductionService(f.projects);
    const draft = production.compile({
      target: { kind: 'shot', id: f.shot.id },
      adapterKey: imageAdapter.key,
    });
    expect(draft.issues).toEqual([]);
    expect(() =>
      production.assertSource(draft.source, { kind: 'shot', id: f.shot.id }, imageAdapter.key, {
        parameters: { prompt: '移除基准图' },
      }),
    ).toThrow('衔接画面');
    expect(
      production
        .compile({
          target: { kind: 'shot', id: f.shot.id },
          adapterKey: imageAdapter.key,
          inputImages: [],
        })
        .issues.some((issue) => issue.code === 'CONTINUITY_ANCHOR_MISSING'),
    ).toBe(true);
    expect(() => f.service.firstFrame(f.shot.id, 1, anchor.id)).toThrow('新构图');
    const id = randomUUID();
    const relativePath = `assets/images/${id}.png`;
    await writeFile(
      join(f.project.rootPath, relativePath),
      await readFile(join(f.project.rootPath, anchor.relativePath)),
    );
    f.projects.access(true, (db) =>
      createRepositories(db).assets.save({ ...anchor, id, relativePath }),
    );
    const bound = f.service.firstFrame(f.shot.id, 1, id);
    await f.service.preparePrompt({
      shotId: f.shot.id,
      expectedRowVersion: bound.rowVersion,
      kind: 'video',
      providerProfileId: 'profile',
      modelId: 'vision',
    });
    const args = f.prepare.mock.calls[0] as unknown as [
      { attachments: { name: string; dataUrl: string }[] },
    ];
    expect(args[0].attachments.at(-1)?.name).toBe('人工确认的下一视频首帧');
    expect(args[0].attachments.at(-1)?.dataUrl).toMatch(/^data:image\/jpeg;base64,/u);
    const textAdapter = getAdapterCatalog().adapters.find(
      (adapter) => adapter.capability === 'TEXT_TO_VIDEO',
    )!;
    expect(
      new ProductionService(f.projects)
        .compile({ target: { kind: 'shot', id: f.shot.id }, adapterKey: textAdapter.key })
        .issues.some((issue) => issue.code === 'CONTINUITY_FRAME_MODE'),
    ).toBe(true);
  });

  it('routes the public IPC through the owning project runtime', async () => {
    const f = await fixture();
    f.projects.close();
    process.env.AI_VIDEO_APP_DATA_DIR = await mkdtemp(
      join(tmpdir(), 'shot-continuity-rpc-settings-'),
    );
    const { handleRequest, parseRequest } = await import('./handler.js');
    async function rpc<M extends WorkerMethod>(method: M, params: WorkerMethodMap[M]['params']) {
      const parsed = parseRequest({ id: randomUUID(), protocolVersion: 1, method, params });
      const response = 'ok' in parsed ? parsed : await handleRequest(parsed);
      if (!response.ok) throw new Error(response.error.message);
      return response.result as WorkerMethodMap[M]['result'];
    }
    try {
      await rpc('project.open', { rootPath: f.project.rootPath });
      expect((await rpc('shot.continuity.get', { shotId: f.shot.id })).previousShot?.id).toBe(
        f.previous.id,
      );
      const preview = await rpc('shot.continuity.preview', {
        shotId: f.shot.id,
        videoAssetId: f.id,
        timeMs: 1000,
      });
      const selection = await rpc('shot.continuity.confirm', {
        shotId: f.shot.id,
        videoAssetId: f.id,
        sourceToken: preview.sourceToken,
        timesMs: [1000],
        anchorTimeMs: 1000,
        mode: 'continue',
        notes: '',
        expectedRowVersion: 0,
      });
      expect(selection.binding?.firstFrameAssetId).toBeTruthy();
      const saved = await rpc('shot.continuity.prompt.save', {
        shotId: f.shot.id,
        expectedRowVersion: selection.rowVersion,
        kind: 'video',
        prompt: '保持原位，缓慢转头。',
      });
      expect(saved.binding?.videoPrompt).toBe('保持原位，缓慢转头。');
    } finally {
      await rpc('project.close', {});
    }
  });
});

describe('continuity IPC boundaries', () => {
  it('rejects unchosen anchors, excess frames and provider fields on local extraction', () => {
    const params = {
      shotId: 'shot',
      videoAssetId: 'video',
      sourceToken: 'a'.repeat(64),
      timesMs: [100],
      anchorTimeMs: 100,
      mode: 'continue',
      notes: '',
      expectedRowVersion: 0,
    };
    expect(validateSessionRequestParams('shot.continuity.confirm', params)).toEqual(params);
    expect(() =>
      validateSessionRequestParams('shot.continuity.confirm', { ...params, anchorTimeMs: 99 }),
    ).toThrow();
    expect(() =>
      validateSessionRequestParams('shot.continuity.confirm', {
        ...params,
        timesMs: [1, 2, 3, 4, 5],
      }),
    ).toThrow();
    expect(() =>
      validateSessionRequestParams('shot.continuity.preview', {
        shotId: 's',
        videoAssetId: 'v',
        timeMs: 0,
        providerProfileId: 'p',
      }),
    ).toThrow();
  });
});
