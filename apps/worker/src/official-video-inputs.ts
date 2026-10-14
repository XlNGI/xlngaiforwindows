import { createHash, randomUUID } from 'node:crypto';
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, extname, join, resolve } from 'node:path';
import type {
  AdapterParameters,
  AdapterParameterValue,
  MediaInputReferenceV1,
  VideoGenerationPrepareParams,
} from '@ai-video/contracts';
import { officialVideoAudioContracts } from '@ai-video/contracts';
import {
  VoiceReferenceRepository,
  DubbingRepository,
  createRepositories,
} from '@ai-video/persistence';
import { resolveProjectRelativePath, type ProjectService } from './project-service.js';
import { assertStorageCapacity } from './storage-capacity.js';

const OFFICIAL_PROVIDERS = new Set(['wan-video', 'seedance-video', 'minimax-video']);
export const isOfficialVideoAdapter = (key: string) =>
  OFFICIAL_PROVIDERS.has(key.split(':')[1] ?? '');

/** Resolve local domain references before freezing the existing paid-media draft. */
export function materializeOfficialVideoInputs(
  projects: ProjectService,
  params: VideoGenerationPrepareParams,
): { parameters: AdapterParameters; references: MediaInputReferenceV1[]; paths: string[] } {
  const current = projects.current();
  if (!current || current.mode !== 'read-write')
    throw new Error('当前项目不可写，无法准备视频素材。');
  const project = current;
  const adapterParts = params.adapterKey.split(':');
  const contract = officialVideoAudioContracts.find(
    (value) =>
      value.contractId === adapterParts[2] &&
      value.contractRevision === Number(adapterParts[3]?.slice('contract-'.length)),
  );
  if (!contract) throw new Error('官方视频合同不存在。');
  const roots = process.env.AI_VIDEO_MEDIA_INPUT_ROOT?.trim() || project.rootPath;
  const directory = join(roots, 'cache', 'media-inputs');
  const references: MediaInputReferenceV1[] = [];
  const paths: string[] = [];
  const replacements = new Map<string, string>();
  const voiceReferences = projects.access(false, (database) =>
    new VoiceReferenceRepository(database, project.id).list(),
  );
  function materialize(original: string): string {
    if (replacements.has(original)) return replacements.get(original)!;
    let bytes: Buffer;
    let sourcePath: string | undefined;
    let mime: string;
    let durationMs: number | undefined;
    let characterDocumentId: string | undefined;
    let voiceRevision: number | undefined;
    let audioReferenceId: string | undefined;
    if (/^(character-voice|project-audio):\/\//u.test(original)) {
      const [characterId, selectedVersionId] = original
        .slice('character-voice://'.length)
        .split('/');
      const voice = original.startsWith('character-voice://')
        ? voiceReferences.find((value) => value.characterDocumentId === characterId)
        : undefined;
      if (original.startsWith('character-voice://') && !voice)
        throw new Error('角色还没有绑定可用声音样本，或已归档。');
      if (voice && selectedVersionId && voice.versionId !== selectedVersionId)
        throw new Error('角色声音样本已更新，请刷新后重新选择。');
      const audioId = voice?.audioId ?? original.slice('project-audio://'.length);
      audioReferenceId = audioId;
      const audio = projects.access(false, (database) =>
        new DubbingRepository(database, project.id).getAudio(audioId),
      );
      if (!audio || audio.deletedAt) throw new Error('音频不属于当前项目，或已删除。');
      sourcePath = resolveProjectRelativePath(project.rootPath, audio.relativePath);
      bytes = readFileSync(sourcePath);
      mime = audio.mime;
      durationMs = audio.durationMs;
      if (
        createHash('sha256').update(bytes).digest('hex') !== audio.contentHash ||
        bytes.length !== audio.sizeBytes
      )
        throw new Error('声音文件已变化，请重新导入并确认。');
      characterDocumentId = voice?.characterDocumentId;
      voiceRevision = voice?.revision;
      const limit = contract!.inputMediaLimits?.find(
        (limit) => limit.kind === 'reference_audio' || limit.kind === 'driving_audio',
      );
      if (
        !limit ||
        bytes.length > (limit.maxBytes ?? 15 * 1024 * 1024) ||
        durationMs < limit.minDurationMs ||
        durationMs > limit.maxDurationMs
      )
        throw new Error('声音样本的大小或时长不符合所选模型的官方要求。');
      if (
        limit.kind === 'driving_audio' &&
        durationMs > Number(params.parameters.duration ?? 5) * 1000
      )
        throw new Error('完整对白超出视频时长，请加长画面或明确拆分，不能截断台词。');
    } else if (original.startsWith('asset://') || original.startsWith('project-asset://')) {
      const localId = original.slice(original.indexOf('://') + 3);
      const asset = projects.access(false, (database) =>
        createRepositories(database).assets.get(localId),
      );
      if (!asset && original.startsWith('asset://') && adapterParts[1] === 'seedance-video')
        return original;
      if (!asset || asset.projectId !== project.id || asset.deletedAt)
        throw new Error('输入素材不属于当前项目或已删除。');
      references.push({ type: 'asset', assetId: asset.id });
      sourcePath = resolveProjectRelativePath(project.rootPath, asset.relativePath);
      bytes = readFileSync(sourcePath);
      mime =
        (
          {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.webp': 'image/webp',
            '.mp4': 'video/mp4',
          } as Record<string, string>
        )[extname(sourcePath).toLowerCase()] ?? '';
      if (
        !mime ||
        bytes.length !== asset.sizeBytes ||
        createHash('sha256').update(bytes).digest('hex') !== asset.contentHash
      )
        throw new Error('输入素材格式无效或内容已变化。');
    } else {
      const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/u.exec(original);
      if (!match) return original;
      mime = match[1]!;
      bytes = Buffer.from(match[2]!.replace(/\s/gu, ''), 'base64');
    }
    const maxBytes = mime.startsWith('audio/')
      ? 15 * 1024 * 1024
      : mime === 'video/mp4'
        ? (adapterParts[1] === 'minimax-video' ? 50 : 100) * 1024 * 1024
        : 30 * 1024 * 1024;
    if (!bytes.length || bytes.length > maxBytes) throw new Error('输入媒体文件超过官方大小限制。');
    if (mime === 'video/mp4' && adapterParts[1] === 'seedance-video')
      throw new Error(
        'Seedance 本地参考视频请先保存为供应商素材 ID 或提供公网 URL；图片和声音可直接使用本地文件。',
      );
    mkdirSync(directory, { recursive: true });
    if (lstatSync(join(roots, 'cache')).isSymbolicLink() || lstatSync(directory).isSymbolicLink())
      throw new Error('受控输入目录不能是链接。');
    assertStorageCapacity(directory, bytes.length);
    const extension = (
      {
        'audio/wav': 'wav',
        'audio/mpeg': 'mp3',
        'image/png': 'png',
        'image/jpeg': 'jpg',
        'image/webp': 'webp',
        'video/mp4': 'mp4',
      } as Record<string, string>
    )[mime]!;
    const handle = `cache/media-inputs/${randomUUID()}.${extension}`;
    const path = join(roots, handle);
    if (sourcePath) copyFileSync(sourcePath, path, constants.COPYFILE_EXCL);
    else writeFileSync(path, bytes, { flag: 'wx' });
    paths.push(path);
    if (mime === 'video/mp4' || mime.startsWith('image/')) {
      const executable = [
        join(dirname(process.execPath), 'media', 'ffmpeg', 'ffprobe.exe'),
        resolve('apps/desktop/src-tauri/resources/ffmpeg/ffprobe.exe'),
        resolve('../desktop/src-tauri/resources/ffmpeg/ffprobe.exe'),
      ].find(existsSync);
      if (!executable) throw new Error('随包 ffprobe 不可用，尚未提交生成。');
      const result = spawnSync(
        executable,
        ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path],
        { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 },
      );
      if (result.error || result.status !== 0)
        throw new Error('输入媒体无法完整探测，尚未提交生成。');
      const probe = JSON.parse(result.stdout) as {
        format?: { duration?: string };
        streams?: Array<{
          codec_type: string;
          width?: number;
          height?: number;
          avg_frame_rate?: string;
          duration?: string;
        }>;
      };
      const video = probe.streams?.find((stream) => stream.codec_type === 'video');
      if (!video?.width || !video.height) throw new Error('媒体缺少有效画面。');
      const minimum =
        adapterParts[1] === 'seedance-video'
          ? 300
          : adapterParts[1] === 'minimax-video'
            ? 256
            : 240;
      const maximum =
        mime === 'video/mp4'
          ? 4096
          : adapterParts[1] === 'seedance-video'
            ? 6000
            : adapterParts[1] === 'minimax-video'
              ? 5760
              : 8000;
      const ratio = video.width / video.height;
      if (
        Math.min(video.width, video.height) < minimum ||
        Math.max(video.width, video.height) > maximum ||
        ratio < (adapterParts[1] === 'wan-video' ? 0.125 : 0.4) ||
        ratio > (adapterParts[1] === 'wan-video' ? 8 : 2.5)
      )
        throw new Error('媒体尺寸或比例不符合模型官方要求。');
      if (mime === 'video/mp4') {
        durationMs = Math.round(Number(probe.format?.duration ?? video.duration) * 1000);
        const maxDuration =
          adapterParts[1] === 'seedance-video' && params.modelId?.includes('2-5') ? 30000 : 15000;
        if (!Number.isFinite(durationMs) || durationMs < 1000 || durationMs > maxDuration)
          throw new Error('参考视频时长不符合模型官方要求。');
        const [numerator, denominator] = String(video.avg_frame_rate ?? '0/1')
          .split('/')
          .map(Number);
        const fps = Number(numerator) / Number(denominator);
        if (
          !Number.isFinite(fps) ||
          fps < (adapterParts[1] === 'minimax-video' ? 23.976 : 16) ||
          (adapterParts[1] === 'minimax-video' && fps > 60)
        )
          throw new Error('参考视频帧率不符合模型官方要求。');
        if (params.adapterKey.includes('wan2-7') && durationMs > 10000)
          throw new Error('万相2.7续写输入视频不能超过10秒。');
      }
    }
    references.push({
      type: 'controlled_temporary_file',
      handle,
      contentType: mime,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
      ...(audioReferenceId ? { audioId: audioReferenceId } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(characterDocumentId ? { characterDocumentId, voiceRevision } : {}),
    });
    const uri = `controlled-file://${handle}`;
    replacements.set(original, uri);
    return uri;
  }
  const walk = (value: AdapterParameterValue, key: string): AdapterParameterValue =>
    typeof value === 'string'
      ? ['url', 'images', 'sounds', 'video'].includes(key)
        ? materialize(value)
        : value
      : Array.isArray(value)
        ? value.map((item) => walk(item, key))
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value).map(([child, item]) => [child, walk(item, child)]),
            )
          : value;
  try {
    const parameters = Object.fromEntries(
      Object.entries(params.parameters).map(([key, value]) => [key, walk(value, key)]),
    );
    let totalAudio = 0,
      totalVideo = 0,
      countAudio = 0;
    const visit = (value: AdapterParameterValue): void => {
      if (typeof value === 'string' && value.startsWith('controlled-file://')) {
        const reference = references.find(
          (item) =>
            item.type === 'controlled_temporary_file' &&
            `controlled-file://${item.handle}` === value,
        );
        if (reference?.type === 'controlled_temporary_file') {
          if (reference.contentType.startsWith('audio/')) {
            totalAudio += reference.durationMs ?? 0;
            countAudio++;
          } else if (reference.contentType === 'video/mp4') totalVideo += reference.durationMs ?? 0;
        }
      } else if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') Object.values(value).forEach(visit);
    };
    Object.values(parameters).forEach(visit);
    const limit = contract.inputMediaLimits?.find(
      (limit) => limit.kind === 'reference_audio' || limit.kind === 'driving_audio',
    );
    if (limit && (totalAudio > limit.maxTotalDurationMs || countAudio > limit.maxItems))
      throw new Error('音频数量或合计时长超过所选模型官方限制。');
    const videoLimit = params.modelId?.includes('2-5') ? 30000 : 15000;
    if (totalVideo > videoLimit) throw new Error('参考视频合计时长超出模型限制。');
    if (
      adapterParts[1] === 'wan-video' &&
      totalVideo &&
      Number(parameters.duration ?? 5) > 0 &&
      totalVideo + Number(parameters.duration ?? 5) * 1000 > 30000
    )
      throw new Error('万相输入视频和输出视频合计不能超过30秒。');
    return { parameters, references, paths };
  } catch (error) {
    for (const path of paths) rmSync(path, { force: true });
    throw error;
  }
}
