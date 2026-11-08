import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, existsSync, statSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  RoughCutClip,
  RoughCutEpisode,
  RoughCutExportJob,
  RoughCutPrepareParams,
  RoughCutPrepared,
  RoughCutSaveParams,
  RoughCutSequence,
  RoughCutState,
} from '@ai-video/contracts';
import { createRepositories, RoughCutRepository } from '@ai-video/persistence';
import { ProjectService, resolveProjectRelativePath } from './project-service.js';
import { ImageGenerationService } from './image-generation-service.js';
import { FfmpegRuntime, type MediaProbe } from './ffmpeg-runtime.js';
import { ExecutionPool } from './execution-pool.js';
import { RequestValidationError } from './request-validation.js';
import { assertStorageCapacity } from './storage-capacity.js';
import { episodeNumber } from './rough-cut-episodes.js';
import { openExportDirectory } from './open-export-directory.js';

const MAX_CLIPS = 200;
const MAX_DURATION = 2 * 60 * 60 * 1000;
const fail = (message: string): never => {
  throw new RequestValidationError(message);
};
function id(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 128)
    return fail('无效的粗剪标识。');
  return value;
}
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_CLIPS) return fail('一次最多选择 200 项。');
  return [...new Set(value.map(id))];
}
function version(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return fail('缺少有效的序列版本。');
  return value as number;
}
const xml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
  );

/** FCP 7 XML / xmeml: editable cuts and linked source audio, with local media paths. */
export function roughCutXml(sequence: RoughCutSequence, mediaPaths: Map<string, string>): string {
  const frames = (ms: number) => Math.round((ms * 30) / 1000);
  const rate = '<rate><timebase>30</timebase><ntsc>FALSE</ntsc></rate>';
  const first = sequence.clips[0];
  const width = first ? Math.min(4096, Math.max(2, Math.round(first.width / 2) * 2)) : 1920;
  const height = first ? Math.min(4096, Math.max(2, Math.round(first.height / 2) * 2)) : 1080;
  const format = `<samplecharacteristics>${rate}<width>${width}</width><height>${height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics>`;
  let offset = 0;
  const audio: string[][] = [[], []];
  const video = sequence.clips
    .map((clip, index) => {
      const length = Math.max(1, frames(clip.outMs - clip.inMs));
      const sourceFps = clip.fps ?? 30;
      const base = Math.round(sourceFps);
      const ntsc =
        [24, 30, 60, 120].includes(base) && Math.abs(sourceFps - (base * 1000) / 1001) < 0.005;
      const sourceRate = `<rate><timebase>${base}</timebase><ntsc>${ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
      const sourceFrames = (ms: number) => Math.round((ms * sourceFps) / 1000);
      const sourceLength = Math.max(1, sourceFrames(clip.outMs - clip.inMs));
      const timing = `${sourceRate}<start>${offset}</start><end>${offset + length}</end><in>${sourceFrames(clip.inMs)}</in><out>${sourceFrames(clip.inMs) + sourceLength}</out>`;
      offset += length;
      const sourceFormat = `<samplecharacteristics>${sourceRate}<width>${clip.width}</width><height>${clip.height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics>`;
      const channels = Math.min(2, clip.audioChannels ?? 2);
      const links =
        `<link><linkclipref>video-${index}</linkclipref><mediatype>video</mediatype><trackindex>1</trackindex><clipindex>${index + 1}</clipindex></link>` +
        (clip.hasAudio
          ? Array.from(
              { length: channels },
              (_, channel) =>
                `<link><linkclipref>audio-${index}-${channel}</linkclipref><mediatype>audio</mediatype><trackindex>${channel + 1}</trackindex><clipindex>${audio[channel]!.length + 1}</clipindex><groupindex>1</groupindex></link>`,
            ).join('')
          : '');
      const file = `<file id="file-${index}"><name>${xml(clip.name)}</name><pathurl>${xml(pathToFileURL(mediaPaths.get(clip.assetId)!).href)}</pathurl>${sourceRate}<duration>${sourceFrames(clip.durationMs)}</duration><media><video>${sourceFormat}</video>${clip.hasAudio ? `<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>${channels}</channelcount></audio>` : ''}</media></file>`;
      if (clip.hasAudio)
        for (let channel = 0; channel < channels; channel++)
          audio[channel]!.push(
            `<clipitem id="audio-${index}-${channel}"><name>${xml(clip.name)}</name><enabled>${clip.muted ? 'FALSE' : 'TRUE'}</enabled><duration>${sourceFrames(clip.durationMs)}</duration>${timing}<file id="file-${index}"/><sourcetrack><mediatype>audio</mediatype><trackindex>${channel + 1}</trackindex></sourcetrack>${links}</clipitem>`,
          );
      const scale =
        (clip.fit === 'cover'
          ? Math.max(width / clip.width, height / clip.height)
          : Math.min(width / clip.width, height / clip.height)) * 100;
      const transform = `<filter><effect><name>Basic Motion</name><effectid>basic</effectid><effectcategory>motion</effectcategory><effecttype>motion</effecttype><mediatype>video</mediatype><parameter><parameterid>scale</parameterid><name>Scale</name><value>${scale.toFixed(6)}</value></parameter><parameter><parameterid>center</parameterid><name>Center</name><value><horiz>0</horiz><vert>0</vert></value></parameter></effect></filter>`;
      return `<clipitem id="video-${index}"><name>${xml(clip.name)}</name><enabled>TRUE</enabled><duration>${sourceFrames(clip.durationMs)}</duration>${timing}${file}<sourcetrack><mediatype>video</mediatype><trackindex>1</trackindex></sourcetrack>${links}${transform}</clipitem>`;
    })
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="5"><sequence id="sequence-${xml(sequence.id)}"><name>${xml(sequence.name)}</name><duration>${offset}</duration>${rate}<timecode>${rate}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode><media><video><format>${format}</format><track>${video}</track></video><audio><numOutputChannels>2</numOutputChannels><format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>${audio.map((track) => `<track>${track.join('')}</track>`).join('')}</audio></media></sequence></xmeml>`;
}

interface ExportTask {
  job: RoughCutExportJob;
  controller: AbortController;
  work: Promise<void>;
}

export class RoughCutService {
  private readonly probes = new Map<string, MediaProbe>();
  private readonly controllers = new Set<AbortController>();
  private readonly exports = new Map<string, ExportTask>();
  constructor(
    private readonly projects: ProjectService,
    private readonly assets: ImageGenerationService,
    private readonly ffmpeg = new FfmpegRuntime(),
    private readonly capacity = new ExecutionPool(),
    private readonly reveal: (path: string) => void | Promise<void> = openExportDirectory,
  ) {}

  async stop(): Promise<void> {
    for (const controller of this.controllers) controller.abort();
    await Promise.allSettled([...this.exports.values()].map((task) => task.work));
  }

  list(): RoughCutSequence[] {
    return this.projects.access(false, (db, project) =>
      new RoughCutRepository(db).list(project.id),
    );
  }

  get(sequenceId: string): RoughCutState {
    return this.projects.access(false, (db, project) => {
      const sequence = new RoughCutRepository(db).get(project.id, id(sequenceId));
      if (!sequence) throw new Error('粗剪序列不存在。');
      const repo = createRepositories(db);
      return {
        sequence,
        unavailableClipIds: sequence.clips
          .filter((clip) => {
            const asset = repo.assets.get(clip.assetId);
            return (
              !asset ||
              asset.projectId !== project.id ||
              asset.deletedAt ||
              asset.contentHash !== clip.contentHash ||
              !existsSync(resolveProjectRelativePath(project.rootPath, asset.relativePath))
            );
          })
          .map((clip) => clip.id),
      };
    });
  }

  private source(assetId: string) {
    const asset = this.assets.getAssetInfo(id(assetId));
    if (asset.deletedAt || !asset.kind.includes('video'))
      throw new Error('请选择当前项目内有效的视频素材。');
    const path = this.assets.assetMediaSource({ assetId }).path;
    const relation: {
      shotId?: string;
      sceneId?: string;
      scenePosition?: number;
      shotPosition?: number;
    } = this.projects.access(false, (db, project) => {
      const row = db
        .prepare(
          `SELECT j.shot_id AS shotId,coalesce(json_extract(j.task_snapshot_json,'$.sceneId'),sh.scene_id) AS sceneId,
        s.position AS scenePosition,sh.position AS shotPosition
        FROM generation_results r JOIN generation_jobs j ON j.id=r.job_id
        LEFT JOIN shots sh ON sh.id=j.shot_id LEFT JOIN scenes s ON s.id=coalesce(json_extract(j.task_snapshot_json,'$.sceneId'),sh.scene_id)
        WHERE r.asset_id=? AND j.project_id=? AND j.status='succeeded' ORDER BY r.created_at DESC,r.id DESC LIMIT 1`,
        )
        .get(assetId, project.id) as
        | { shotId?: string; sceneId?: string; scenePosition?: number; shotPosition?: number }
        | undefined;
      return (
        row ??
        (db
          .prepare(
            `SELECT d.scene_id AS sceneId,s.position AS scenePosition FROM dubbing_jobs d JOIN scenes s ON s.id=d.scene_id WHERE d.output_asset_id=? AND d.project_id=?`,
          )
          .get(assetId, project.id) as { sceneId: string; scenePosition: number } | undefined) ??
        {}
      );
    });
    return { asset, path, ...relation };
  }

  episodes(): RoughCutEpisode[] {
    return this.projects.access(false, (db, project) => {
      const groups = new Map<number, RoughCutEpisode>();
      const rows = db
        .prepare(
          `SELECT c.title, s.id AS sceneId, s.position
        FROM agent_change_sets c JOIN agent_change_set_items i ON i.change_set_id=c.id AND i.project_id=c.project_id
        JOIN scenes s ON s.id=i.applied_entity_id AND s.project_id=c.project_id
        WHERE c.project_id=? AND i.entity_type='scene' AND i.action='create' AND i.status='applied'
        ORDER BY c.created_at,c.id,i.ordinal`,
        )
        .all(project.id) as { title: string; sceneId: string; position: number }[];
      for (const row of rows) {
        const number = episodeNumber(row.title);
        if (number === undefined) continue;
        const group = groups.get(number) ?? {
          number,
          title: row.title,
          sceneIds: [],
          source: 'structure' as const,
        };
        if (!group.sceneIds.includes(row.sceneId)) group.sceneIds.push(row.sceneId);
        groups.set(number, group);
      }
      // Explicit user grouping saved in a rough-cut sequence takes precedence.
      for (const sequence of [...new RoughCutRepository(db).list(project.id)].reverse()) {
        const number = episodeNumber(sequence.name);
        if (number === undefined || !sequence.sceneIds.length) continue;
        groups.set(number, {
          number,
          title: sequence.name,
          sceneIds: sequence.sceneIds,
          source: 'sequence',
        });
      }
      const scenes = createRepositories(db).scenes.listByProject(project.id);
      const positions = new Map(scenes.map((scene) => [scene.id, scene.position]));
      return [...groups.values()]
        .map((group) => ({
          ...group,
          sceneIds: group.sceneIds
            .filter((sceneId) => positions.has(sceneId))
            .sort((a, b) => positions.get(a)! - positions.get(b)!),
        }))
        .filter((group) => group.sceneIds.length)
        .sort((a, b) => a.number - b.number);
    });
  }

  async prepare(params: RoughCutPrepareParams): Promise<RoughCutPrepared> {
    const project = this.projects.current();
    if (!project) throw new Error('请先打开项目。');
    const session = this.projects.currentSessionId();
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      let assetIds: string[];
      const missingSceneIds: string[] = [];
      if (params.sceneIds !== undefined) {
        if (params.assetIds !== undefined) return fail('请选择场次或素材，不能混合两种选择。');
        const selectedScenes = ids(params.sceneIds);
        assetIds = this.projects.access(false, (db, current) => {
          const repo = createRepositories(db);
          return selectedScenes.flatMap((sceneId) => {
            const scene = repo.scenes.get(sceneId);
            if (!scene || scene.projectId !== current.id) return fail('本集场次不属于当前项目。');
            const videos = db
              .prepare(
                `SELECT DISTINCT a.id,a.created_at AS createdAt FROM assets a
              LEFT JOIN generation_results r ON r.asset_id=a.id LEFT JOIN generation_jobs j ON j.id=r.job_id
              LEFT JOIN shots sh ON sh.id=j.shot_id WHERE a.project_id=? AND a.deleted_at IS NULL AND a.kind LIKE '%video%'
              AND ((j.status='succeeded' AND coalesce(json_extract(j.task_snapshot_json,'$.sceneId'),sh.scene_id)=?)
                OR EXISTS(SELECT 1 FROM dubbing_jobs d WHERE d.output_asset_id=a.id AND d.project_id=a.project_id AND d.scene_id=?))
              ORDER BY createdAt DESC,a.id DESC`,
              )
              .all(current.id, sceneId, sceneId) as { id: string; createdAt: string }[];
            const sources = videos.map((asset) => this.source(asset.id));
            const whole = sources.find((source) => source.sceneId === sceneId && !source.shotId);
            if (whole) return [whole.asset.id];
            const shots = repo.shots.listByScene(sceneId);
            const found = shots.flatMap((shot) => {
              const source = sources.find((item) => item.shotId === shot.id);
              return source ? [source.asset.id] : [];
            });
            if (!found.length || found.length < shots.length) missingSceneIds.push(sceneId);
            return found;
          });
        });
      } else assetIds = ids(params.assetIds);
      if (assetIds.length > MAX_CLIPS) return fail('本次选材超过 200 个视频，请分批加入。');
      const sources = assetIds
        .map((assetId) => this.source(assetId))
        .sort(
          (a, b) =>
            (a.scenePosition ?? Number.MAX_SAFE_INTEGER) -
              (b.scenePosition ?? Number.MAX_SAFE_INTEGER) ||
            (a.shotPosition ?? -1) - (b.shotPosition ?? -1) ||
            a.asset.createdAt.localeCompare(b.asset.createdAt) ||
            a.asset.id.localeCompare(b.asset.id),
        );
      const clips: RoughCutClip[] = [];
      for (const source of sources) {
        const info = statSync(source.path);
        const key = `${session}:${source.asset.id}:${source.asset.contentHash}:${info.size}:${info.mtimeMs}`;
        let probe = this.probes.get(key);
        if (!probe) {
          probe = await this.capacity.run('ffmpeg', project.id, controller.signal, () =>
            this.ffmpeg.probe(source.path, controller.signal),
          );
          if (!probe.hasVideo || !probe.width || !probe.height)
            throw new Error('素材没有可用的视频画面。');
          if (this.probes.size >= 400) this.probes.delete(this.probes.keys().next().value!);
          this.probes.set(key, probe);
        }
        if (session !== this.projects.currentSessionId())
          throw new Error('项目已切换，请重新选择素材。');
        clips.push({
          id: randomUUID(),
          assetId: source.asset.id,
          contentHash: source.asset.contentHash,
          name: source.asset.alias?.trim() || '视频片段',
          durationMs: probe.durationMs,
          width: probe.width!,
          height: probe.height!,
          hasAudio: probe.hasAudio,
          fps: probe.fps ?? 30,
          ...(probe.channels ? { audioChannels: probe.channels } : {}),
          inMs: 0,
          outMs: probe.durationMs,
          muted: false,
          fit: 'contain',
          ...(source.sceneId ? { sceneId: source.sceneId } : {}),
          ...(source.shotId ? { shotId: source.shotId } : {}),
        });
      }
      return { clips, missingSceneIds };
    } finally {
      this.controllers.delete(controller);
    }
  }

  async save(params: RoughCutSaveParams): Promise<RoughCutState> {
    version(params.expectedRowVersion);
    const name = typeof params.name === 'string' ? params.name.trim() : '';
    if (!name || name.length > 200) return fail('序列名称需为 1–200 个字符。');
    const sceneIds = ids(params.sceneIds);
    if (!Array.isArray(params.clips) || params.clips.length > MAX_CLIPS)
      return fail('序列最多包含 200 个片段。');
    const sequenceId = params.id === undefined ? randomUUID() : id(params.id);
    const project = this.projects.access(true, (db, current) => {
      for (const sceneId of sceneIds) {
        if (createRepositories(db).scenes.get(sceneId)?.projectId !== current.id)
          return fail('本集场次不属于当前项目。');
      }
      return current;
    });
    const session = this.projects.currentSessionId();
    const current = this.list().find((item) => item.id === sequenceId);
    if ((current?.rowVersion ?? 0) !== params.expectedRowVersion)
      throw new Error('粗剪序列已更新，请重新打开；当前编辑尚未保存。');
    const seen = new Set<string>();
    let duration = 0;
    const clips: RoughCutClip[] = [];
    for (const raw of params.clips) {
      if (!raw || typeof raw !== 'object') return fail('无效的片段。');
      id(raw.id);
      id(raw.assetId);
      if (seen.has(raw.id)) return fail('片段标识重复。');
      seen.add(raw.id);
      const old = current?.clips.find(
        (clip) =>
          clip.id === raw.id &&
          clip.assetId === raw.assetId &&
          clip.contentHash === raw.contentHash,
      );
      const frozen = old ?? (await this.prepare({ assetIds: [raw.assetId] })).clips[0]!;
      if (frozen.contentHash !== raw.contentHash)
        throw new Error('来源视频已改变，请重新加入素材。');
      if (
        !Number.isSafeInteger(raw.inMs) ||
        !Number.isSafeInteger(raw.outMs) ||
        raw.inMs < 0 ||
        raw.outMs <= raw.inMs ||
        raw.outMs > frozen.durationMs ||
        raw.outMs - raw.inMs < 34
      )
        return fail('片段起止点必须位于源视频内，长度至少一帧（34 毫秒）。');
      if (typeof raw.muted !== 'boolean' || !['contain', 'cover'].includes(raw.fit))
        return fail('无效的片段设置。');
      if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 200)
        return fail('片段名称需为 1–200 个字符。');
      duration += raw.outMs - raw.inMs;
      clips.push({
        ...frozen,
        id: raw.id,
        name: raw.name.trim(),
        inMs: raw.inMs,
        outMs: raw.outMs,
        muted: raw.muted,
        fit: raw.fit,
      });
    }
    if (duration > MAX_DURATION) return fail('序列总时长不能超过两小时。');
    if (session !== this.projects.currentSessionId())
      throw new Error('项目已切换，未保存到其他项目。');
    const now = new Date().toISOString();
    this.projects.access(true, (db) =>
      new RoughCutRepository(db).save(
        {
          id: sequenceId,
          projectId: project.id,
          name,
          sceneIds,
          clips,
          rowVersion: params.expectedRowVersion,
          createdAt: current?.createdAt ?? now,
          updatedAt: now,
        },
        params.expectedRowVersion,
      ),
    );
    return this.get(sequenceId);
  }

  delete(sequenceId: string, expectedRowVersion: number) {
    this.projects.access(true, (db, project) =>
      new RoughCutRepository(db).delete(project.id, id(sequenceId), version(expectedRowVersion)),
    );
    return { deleted: true as const };
  }

  startExport(params: {
    sequenceId: string;
    expectedRowVersion: number;
    format: 'xml' | 'mp4';
  }): RoughCutExportJob {
    if (!['xml', 'mp4'].includes(params.format)) return fail('请选择 XML 剪辑包或 MP4。');
    const project = this.projects.access(true, (_db, current) => current);
    const state = this.get(params.sequenceId);
    if (state.sequence.rowVersion !== version(params.expectedRowVersion))
      throw new Error('序列已变化，请保存后重试导出。');
    if (!state.sequence.clips.length || state.unavailableClipIds.length)
      throw new Error('请先加入片段并处理不可用的来源视频。');
    if ([...this.exports.values()].some((task) => task.job.status === 'running'))
      throw new Error('当前项目已有粗剪导出，请等待完成或取消。');
    return this.launchExport(structuredClone(state.sequence), params.format, project.rootPath);
  }

  async exportAssets(assetIds: string[]): Promise<RoughCutExportJob> {
    const project = this.projects.access(true, (_db, current) => current);
    const prepared = await this.prepare({ assetIds });
    if (!prepared.clips.length) throw new Error('请先选择视频素材。');
    const now = new Date().toISOString();
    return this.launchExport(
      {
        id: randomUUID(),
        projectId: project.id,
        name: '素材库视频序列',
        sceneIds: [],
        clips: prepared.clips,
        rowVersion: 0,
        createdAt: now,
        updatedAt: now,
      },
      'xml',
      project.rootPath,
    );
  }

  private launchExport(
    sequence: RoughCutSequence,
    format: 'xml' | 'mp4',
    root: string,
  ): RoughCutExportJob {
    if ([...this.exports.values()].some((task) => task.job.status === 'running'))
      throw new Error('当前项目已有粗剪导出，请等待完成或取消。');
    const sources = sequence.clips.map((clip) => this.source(clip.assetId));
    const controller = new AbortController();
    const job: RoughCutExportJob = {
      id: randomUUID(),
      format,
      status: 'running',
      completedClips: 0,
      totalClips: sequence.clips.length,
      sequenceVersion: sequence.rowVersion,
    };
    this.controllers.add(controller);
    const work = this.export(sequence, sources, job, root, controller.signal)
      .then((path) => {
        job.status = 'succeeded';
        job.path = path;
      })
      .catch((error: unknown) => {
        job.status = controller.signal.aborted ? 'cancelled' : 'failed';
        job.error = error instanceof Error ? error.message : String(error);
      })
      .finally(() => {
        this.controllers.delete(controller);
      });
    for (const [key, task] of this.exports)
      if (this.exports.size >= 50 && task.job.status !== 'running') this.exports.delete(key);
    this.exports.set(job.id, { job, controller, work });
    return { ...job };
  }

  exportJob(jobId: string): RoughCutExportJob {
    const task = this.exports.get(id(jobId));
    if (!task) throw new Error('导出任务不存在或项目已重新打开。');
    return { ...task.job };
  }
  cancelExport(jobId: string): RoughCutExportJob {
    const task = this.exports.get(id(jobId));
    if (!task) throw new Error('导出任务不存在。');
    if (task.job.status === 'running') task.controller.abort();
    return this.exportJob(jobId);
  }
  async revealExport(jobId: string) {
    const job = this.exportJob(jobId);
    if (job.status !== 'succeeded' || !job.path || !existsSync(job.path))
      throw new Error('导出尚未完成或文件已移动。');
    await this.reveal(job.path);
    return { path: job.path };
  }

  private async export(
    sequence: RoughCutSequence,
    sources: ReturnType<RoughCutService['source']>[],
    job: RoughCutExportJob,
    root: string,
    signal: AbortSignal,
  ): Promise<string> {
    const parent = resolveProjectRelativePath(root, 'exports');
    await mkdir(parent, { recursive: true });
    const staging = await mkdtemp(join(parent, '.rough-cut-'));
    const target = join(parent, `rough-cut-${job.id}`);
    const mediaPaths = new Map<string, string>();
    try {
      const bytes = [
        ...new Map(sources.map((source) => [source.asset.id, source.asset.sizeBytes])).values(),
      ].reduce((a, b) => a + b, 0);
      assertStorageCapacity(parent, bytes);
      await mkdir(join(staging, 'media'));
      for (const [index, source] of sources.entries()) {
        signal.throwIfAborted();
        if (mediaPaths.has(source.asset.id)) continue;
        const filename = `${source.asset.id}${extname(source.path)}`;
        const copied = join(staging, 'media', filename);
        await copyFile(source.path, copied, constants.COPYFILE_EXCL);
        const digest = createHash('sha256');
        for await (const chunk of createReadStream(copied, {
          signal,
        }))
          digest.update(chunk as Buffer);
        if (digest.digest('hex') !== sequence.clips[index]!.contentHash)
          throw new Error('来源文件内容已变化，请重新选择素材。');
        if (job.format === 'xml') {
          mediaPaths.set(source.asset.id, join(target, 'media', filename));
          job.completedClips = index + 1;
        } else mediaPaths.set(source.asset.id, copied);
      }
      if (job.format === 'xml') {
        await writeFile(join(staging, 'timeline.xml'), roughCutXml(sequence, mediaPaths), 'utf8');
        await writeFile(join(staging, 'sequence.json'), JSON.stringify(sequence, null, 2), 'utf8');
        await writeFile(
          join(staging, 'README.txt'),
          '将 timeline.xml 以 Final Cut Pro 7 XML 导入支持该格式的剪辑软件。\nmedia 文件夹包含独立媒体副本；移动文件夹后可能需要重新链接媒体。\n剪切、顺序、源音频和静音写入 XML；画面适配等设置同时保存在 sequence.json。不同软件对变换的解释可能不同，请在专业软件中复核。\n',
          'utf8',
        );
      } else {
        const first = sequence.clips[0]!;
        await this.capacity.run('ffmpeg', sequence.projectId, signal, () =>
          this.ffmpeg.composeRoughCut(
            sequence.clips.map((clip) => ({ ...clip, path: mediaPaths.get(clip.assetId)! })),
            join(staging, 'rough-cut.mp4'),
            Math.min(4096, Math.max(2, Math.round(first.width / 2) * 2)),
            Math.min(4096, Math.max(2, Math.round(first.height / 2) * 2)),
            signal,
            (completed) => {
              job.completedClips = completed;
            },
          ),
        );
        await rm(join(staging, 'media'), { recursive: true, force: true });
      }
      signal.throwIfAborted();
      await rename(staging, target);
      job.completedClips = sequence.clips.length;
      return target;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}
