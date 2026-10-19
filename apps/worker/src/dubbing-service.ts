import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, posix, relative, sep } from 'node:path';
import type Database from 'better-sqlite3';
import {
  DUBBING_CONTRACT_REVISION,
  DUBBING_LIMITS,
  type AudioFileInfo,
  type AudioImportParams,
  type AudioImportResult,
  type CharacterVoiceSaveParams,
  type DubbingBudgetSnapshot,
  type DubbingCueInfo,
  type DubbingCueSaveParams,
  type DubbingJobInfo,
  type DubbingJobStepInfo,
  type DubbingJobSubmitParams,
  type DubbingJobRetryParams,
  type DubbingSceneSnapshot,
  type DubbingTakeGenerateParams,
  type DubbingTakeInfo,
  type VoiceProfileInfo,
  type NativeDubbingPollResult,
  type NativeDubbingSpeechResult,
  type NativeDubbingSubmitResult,
} from '@ai-video/contracts';
import { createRepositories, DubbingRepository } from '@ai-video/persistence';
import { AppSettingsService } from './app-settings-service.js';
import { FfmpegRuntime } from './ffmpeg-runtime.js';
import { NativeProviderRequestError, type NativeProviderBridge } from './native-provider-bridge.js';
import { ProjectService, resolveProjectRelativePath } from './project-service.js';
import { assertStorageCapacity } from './storage-capacity.js';
import { ExecutionPool, mapConcurrent, type ExecutionStage } from './execution-pool.js';
import { assertProjectTaskAdmission } from './task-admission.js';

const ACTIVE_STATUSES = new Set(['pending', 'running', 'interrupted', 'cancelling']);
const SPEECH_MODELS = new Set(['speech-2.8-hd', 'speech-2.8-turbo']);
const EMOTIONS = new Set(['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm']);
const UUID = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;

export class DubbingValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface FrozenCue {
  cue: DubbingCueInfo;
  take: DubbingTakeInfo;
  audio: AudioFileInfo;
  endMs: number;
}
interface SceneInput {
  sourceVideoAssetId: string;
  sourceRelativePath: string;
  sourceContentHash: string;
  durationMs: number;
  providerProfileId?: string;
  model?: string;
  cues: FrozenCue[];
}
interface SpeechInput {
  cue: DubbingCueInfo;
  voice: VoiceProfileInfo;
}
interface RunningJob {
  controller: AbortController;
  sessionId: string;
  done: Promise<void>;
}
export interface DubbingServiceOptions {
  capacity?: ExecutionPool;
  runtime?: FfmpegRuntime;
  native?: Pick<NativeProviderBridge, 'request'>;
  nativeAvailable?: () => boolean;
  pollIntervalMs?: number;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function matchesTake(cue: DubbingCueInfo, take: DubbingTakeInfo): boolean {
  return (
    take.textHash === hash(cue.text) &&
    (take.parameters.emotion ?? 'calm') === (cue.emotion ?? 'calm') &&
    (take.parameters.speakerKind === undefined ||
      take.parameters.speakerKind === cue.speakerKind) &&
    (take.parameters.characterDocumentId === undefined ||
      take.parameters.characterDocumentId === (cue.characterDocumentId ?? null)) &&
    (take.parameters.voiceProfileId === undefined ||
      take.parameters.voiceProfileId === (cue.voiceProfileId ?? null))
  );
}
function requiredId(value: string, label: string): string {
  if (typeof value !== 'string' || !UUID.test(value))
    throw new DubbingValidationError('INVALID_ID', `${label}无效。`);
  return value;
}

/** Resolve both lexical paths and every existing filesystem component. */
export function resolveDubbingFile(root: string, file: string, allowMissing = false): string {
  const candidate = resolveProjectRelativePath(root, file);
  const actualRoot = realpathSync(root);
  let current = root;
  for (const part of relative(root, candidate).split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current)) {
      if (!allowMissing)
        throw new DubbingValidationError('FILE_MISSING', '制作文件不存在，请检查项目完整性。');
      continue;
    }
    if (lstatSync(current).isSymbolicLink())
      throw new DubbingValidationError('UNSAFE_PATH', '制作文件不能通过链接访问。');
    const resolved = realpathSync(current);
    const child = relative(actualRoot, resolved);
    if (child.startsWith(`..${sep}`) || child === '..' || isAbsolute(child))
      throw new DubbingValidationError('UNSAFE_PATH', '制作文件超出当前项目范围。');
  }
  return candidate;
}

async function hashFile(file: string, maxBytes: number): Promise<string> {
  const digest = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    if (size > maxBytes)
      throw new DubbingValidationError('FILE_TOO_LARGE', '媒体文件超过允许大小。');
    digest.update(bytes);
  }
  return digest.digest('hex');
}

function audioMime(file: string): AudioFileInfo['mime'] {
  const fd = openSync(file, 'r');
  const header = Buffer.alloc(16);
  try {
    readSync(fd, header, 0, header.length, 0);
  } finally {
    closeSync(fd);
  }
  const extension = extname(file).toLowerCase();
  if (
    extension === '.wav' &&
    header.toString('ascii', 0, 4) === 'RIFF' &&
    header.toString('ascii', 8, 12) === 'WAVE'
  )
    return 'audio/wav';
  if (
    extension === '.mp3' &&
    (header.toString('ascii', 0, 3) === 'ID3' ||
      (header[0] === 0xff && ((header[1] ?? 0) & 0xe0) === 0xe0))
  )
    return 'audio/mpeg';
  throw new DubbingValidationError('INVALID_AUDIO', '只支持内容完整的 WAV 或 MP3 音频。');
}

function errorDetails(error: unknown): { errorKind: string; error: string } {
  if (error instanceof DubbingValidationError)
    return { errorKind: error.code, error: error.message };
  if (error instanceof NativeProviderRequestError) {
    const code = error.hostError.code;
    const text =
      code === 'REQUEST_NOT_SENT'
        ? '请求尚未发送，请检查连接和密钥。'
        : code === 'CANCELLED'
          ? '制作已取消。'
          : code === 'TIMEOUT' || code === 'INTERRUPTED'
            ? '连接中断，请核对任务状态后重试。'
            : '供应商请求失败，请检查连接、音色或任务限制。';
    return { errorKind: code, error: text };
  }
  const text = error instanceof Error ? error.message : '制作失败。';
  return {
    errorKind: 'PROCESSING_FAILED',
    error: text
      .replace(/https?:\/\/\S+/g, '[媒体地址]')
      .replace(/(?:Bearer|x-api-key)\s+\S+/gi, '[已脱敏]')
      .slice(0, 240),
  };
}

function budgetSnapshot(
  params: DubbingJobSubmitParams['budget'],
  acknowledged: boolean,
  seconds: number,
  count: number,
): DubbingBudgetSnapshot {
  if (acknowledged !== true)
    throw new DubbingValidationError('COST_ACK_REQUIRED', '请先确认本次制作会产生供应商费用。');
  if (
    params?.maxAttempts !== undefined &&
    (!Number.isInteger(params.maxAttempts) || params.maxAttempts < 1 || params.maxAttempts > 3)
  )
    throw new DubbingValidationError('INVALID_BUDGET', '最大付费尝试次数应为 1～3。');
  const stamp = new Date().toISOString();
  if (params?.unitPrice === undefined) {
    if (count > 1)
      throw new DubbingValidationError(
        'UNKNOWN_BATCH_COST',
        '单价未知时，请每次只处理一个口型片段，或先填写每秒单价和预算。',
      );
    return { state: 'unknown', acknowledgedAt: stamp, maxAttempts: 1 };
  }
  if (
    !Number.isFinite(params.unitPrice) ||
    params.unitPrice <= 0 ||
    params.unitPrice > 1_000 ||
    !/^[A-Z]{3}$/.test(params.currency)
  )
    throw new DubbingValidationError('INVALID_BUDGET', '请填写有效的币种和每秒单价。');
  // Integer micro-units are authoritative for the local estimate.
  const micros = Math.ceil(params.unitPrice * 1_000_000);
  const total = Math.ceil(seconds * micros) / 1_000_000;
  if (
    params.maxAmount !== undefined &&
    (!Number.isFinite(params.maxAmount) || params.maxAmount <= 0 || total > params.maxAmount)
  )
    throw new DubbingValidationError('BUDGET_EXCEEDED', '本次估算超过预算，制作未提交。');
  return {
    state: 'estimated',
    currency: params.currency,
    unit: 'second',
    unitPrice: micros / 1_000_000,
    estimatedTotal: total,
    reservedAmount: total,
    maxAmount: params.maxAmount,
    maxAttempts: 1,
    acknowledgedAt: stamp,
    priceRevision: 'user-quote-v1',
  };
}

/** Project-owned phases. Each job keeps its frozen inputs and local timeline. */
export class DubbingService {
  private readonly runtime: FfmpegRuntime;
  private readonly running = new Map<string, RunningJob>();
  private readonly capacity: ExecutionPool;
  private readonly nativeOperations = new Map<string, Map<string, object>>();
  private revision = 0;

  constructor(
    private readonly projects: ProjectService,
    private readonly settings: Pick<AppSettingsService, 'getProfile' | 'listModels'>,
    private readonly options: DubbingServiceOptions = {},
  ) {
    this.runtime = options.runtime ?? new FfmpegRuntime();
    this.capacity = options.capacity ?? new ExecutionPool();
  }

  private access<T>(
    writable: boolean,
    fn: (repo: DubbingRepository, db: Database.Database) => T,
  ): T {
    return this.projects.access(writable, (db, project) =>
      fn(new DubbingRepository(db, project.id), db),
    );
  }
  private capture(): { root: string; projectId: string; sessionId: string } {
    const project = this.projects.current();
    const sessionId = this.projects.currentSessionId();
    if (!project || !sessionId)
      throw new DubbingValidationError('PROJECT_REQUIRED', '请先打开项目。');
    return { root: project.rootPath, projectId: project.id, sessionId };
  }
  private assertCurrent(sessionId: string, signal?: AbortSignal): void {
    if (signal?.aborted || this.projects.currentSessionId() !== sessionId)
      throw new DubbingValidationError('CANCELLED', '制作已停止或项目已经切换。');
  }

  private nativeOperation<T>(
    stage: ExecutionStage,
    job: DubbingJobInfo,
    operationId: string,
    context: ReturnType<DubbingService['capture']>,
    signal: AbortSignal,
    method: Parameters<NativeProviderBridge['request']>[0],
    params: Record<string, unknown>,
    beforeSend?: () => void,
  ): Promise<T> {
    return this.capacity.run(stage, context.projectId, signal, async () => {
      this.assertCurrent(context.sessionId, signal);
      if (job.deadline && Date.now() >= Date.parse(job.deadline))
        throw new DubbingValidationError('DEADLINE_EXCEEDED', '制作超过等待期限，请重新确认。');
      beforeSend?.();
      const token = {},
        operations = this.nativeOperations.get(job.id) ?? new Map<string, object>();
      this.nativeOperations.set(job.id, operations);
      operations.set(operationId, token);
      const abort = () => {
        void this.options.native
          ?.request(
            'provider.dubbing.cancel',
            {
              operationId,
              ...(typeof params.providerTaskId === 'string'
                ? { providerTaskId: params.providerTaskId }
                : {}),
            },
            5000,
          )
          .catch(() => undefined);
      };
      signal.addEventListener('abort', abort, { once: true });
      try {
        return (await this.options.native!.request(
          method,
          { ...params, operationId },
          12 * 60_000,
        )) as T;
      } finally {
        signal.removeEventListener('abort', abort);
        if (operations.get(operationId) === token) operations.delete(operationId);
        if (!operations.size && this.nativeOperations.get(job.id) === operations)
          this.nativeOperations.delete(job.id);
      }
    });
  }
  private assertSpeakerActive(cue: DubbingCueInfo): void {
    if (!cue.characterDocumentId) return;
    const active = this.access(false, (_repo, database) => {
      const document = createRepositories(database).documents.get(cue.characterDocumentId!);
      return document?.kind === 'character' && document.lifecycleStatus !== 'archived';
    });
    if (!active)
      throw new DubbingValidationError(
        'CHARACTER_ARCHIVED',
        '角色资料已归档或不存在，历史配音仍可播放。',
      );
  }
  private validateConnection(profileId: string, kind: 'speech' | 'lipsync', model: string): void {
    requiredId(profileId, '供应商连接');
    const profile = this.settings.getProfile(profileId);
    const expected =
      kind === 'speech'
        ? {
            providerType: 'minimax-speech',
            protocol: 'minimax-speech',
            baseUrl: 'https://api.minimax.cn',
          }
        : { providerType: 'sync', protocol: 'sync-lipsync', baseUrl: 'https://api.sync.so' };
    if (
      !profile ||
      !profile.enabled ||
      profile.archivedAt ||
      profile.connectionStatus !== 'ready' ||
      profile.accessType !== 'official' ||
      profile.providerType !== expected.providerType ||
      profile.protocol !== expected.protocol ||
      profile.baseUrl !== expected.baseUrl
    )
      throw new DubbingValidationError(
        'PROVIDER_UNAVAILABLE',
        '请在设置中配置并测试对应的官方供应商连接。',
      );
    const selected = this.settings
      .listModels(profileId)
      .find((item) => item.remoteModelId === model && item.enabled && !item.unavailableAt);
    if (
      !selected ||
      !(kind === 'speech' ? selected.capabilities.speechSynthesis : selected.capabilities.lipSync)
    )
      throw new DubbingValidationError(
        'MODEL_UNAVAILABLE',
        '所选制作模型尚未启用，或不具备该能力。',
      );
    if (!(this.options.nativeAvailable?.() ?? Boolean(this.options.native)))
      throw new DubbingValidationError(
        'NATIVE_REQUIRED',
        '供应商制作需要 Windows 桌面应用的安全连接。',
      );
  }

  async runtimeInfo() {
    const info = await this.capacity.run(
      'ffmpeg',
      this.projects.current()?.id ?? 'application',
      undefined,
      () => this.runtime.availability(),
    );
    return {
      available: info.available,
      version: info.version,
      error: info.error,
      nativeAvailable: this.options.nativeAvailable?.() ?? Boolean(this.options.native),
    };
  }
  listVoices(includeArchived = false): VoiceProfileInfo[] {
    return this.access(false, (repo) => repo.listVoices(includeArchived));
  }
  saveVoice(params: CharacterVoiceSaveParams): VoiceProfileInfo {
    requiredId(params.providerProfileId, '供应商连接');
    if (!SPEECH_MODELS.has(params.model))
      throw new DubbingValidationError('INVALID_MODEL', '请选择受支持的 MiniMax Speech 2.8 模型。');
    if (
      typeof params.voiceId !== 'string' ||
      !params.voiceId.trim() ||
      [...params.voiceId].length > 256 ||
      [...params.voiceId].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new DubbingValidationError('INVALID_VOICE', '请填写有效的音色 ID。');
    const profile = this.settings.getProfile(params.providerProfileId);
    if (
      !profile ||
      profile.providerType !== 'minimax-speech' ||
      profile.protocol !== 'minimax-speech' ||
      profile.baseUrl !== 'https://api.minimax.cn' ||
      profile.accessType !== 'official' ||
      profile.archivedAt
    )
      throw new DubbingValidationError('INVALID_PROVIDER', '角色声音需绑定 MiniMax 官方配音连接。');
    if (params.languageBoost)
      throw new DubbingValidationError(
        'UNSUPPORTED_PARAMETER',
        '本版不支持额外语言增强参数，请使用默认语言。',
      );
    const saved = this.access(true, (repo) => repo.saveVoice(params));
    this.revision += 1;
    return saved;
  }
  scene(sceneId: string): DubbingSceneSnapshot {
    requiredId(sceneId, '场次');
    return this.access(false, (repo, db) => {
      const project = this.projects.current()!;
      const scene = createRepositories(db).scenes.get(sceneId);
      if (!scene || scene.projectId !== project.id)
        throw new DubbingValidationError('SCENE_NOT_FOUND', '当前项目中找不到场次。');
      const cues = repo.listCues(sceneId).map((cue) => {
        const takes = cue.takes ?? [];
        const retained = takes.slice(0, 5);
        const selected = takes.find((take) => take.id === cue.selectedTakeId);
        if (selected && !retained.some((take) => take.id === selected.id)) retained.push(selected);
        return { ...cue, takes: retained };
      });
      const audioIds = new Set(cues.flatMap((cue) => cue.takes?.map((take) => take.audioId) ?? []));
      return {
        sceneId,
        voices: repo.listVoices(),
        cues,
        audioFiles: repo.listAudio().filter((audio) => audioIds.has(audio.id)),
        jobs: repo
          .listJobs(sceneId)
          .slice(0, 60)
          .map((job) => this.jobSummary(job)),
      };
    });
  }
  saveCue(params: DubbingCueSaveParams): DubbingCueInfo {
    if (params.emotion && !EMOTIONS.has(params.emotion))
      throw new DubbingValidationError('INVALID_EMOTION', '当前模型不支持所选情绪。');
    if (params.speakerKind === 'narration' && params.lipSync)
      throw new DubbingValidationError('INVALID_SPEAKER', '旁白不需要口型处理。');
    const cue = this.access(true, (repo) => repo.saveCue(params));
    this.revision += 1;
    return cue;
  }
  deleteCue(cueId: string, rowVersion: number) {
    this.access(true, (repo) => repo.deleteCue(cueId, rowVersion));
    this.revision += 1;
    return { deleted: true as const };
  }
  audio(id: string): AudioFileInfo | null {
    return this.access(false, (repo) => repo.getAudio(id) ?? null);
  }
  listAudio(params: { deleted?: 'active' | 'trash'; kind?: AudioFileInfo['kind'] } = {}) {
    return this.access(false, (repo) => repo.listAudio(params));
  }
  audioSource(audioId: string) {
    const audio = this.audio(audioId);
    if (!audio || audio.deletedAt)
      throw new DubbingValidationError('AUDIO_UNAVAILABLE', '音频不存在或已进入回收站。');
    return {
      assetId: audio.id,
      path: resolveDubbingFile(this.capture().root, audio.relativePath),
      contentType: audio.mime,
    };
  }

  private async inspectAudio(path: string, signal?: AbortSignal) {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size <= 0 || stat.size > DUBBING_LIMITS.audioMaxBytes)
      throw new DubbingValidationError(
        'INVALID_AUDIO_SIZE',
        '音频必须为不超过 20 MiB 的有效文件。',
      );
    const mime = audioMime(path);
    const probe = await this.capacity.run('ffmpeg', this.capture().projectId, signal, () =>
      this.runtime.validate(path, signal),
    );
    if (
      !probe.hasAudio ||
      probe.hasVideo ||
      probe.durationMs <= 0 ||
      probe.durationMs > DUBBING_LIMITS.sceneMaxDurationMs ||
      !probe.sampleRate ||
      !probe.channels
    )
      throw new DubbingValidationError('INVALID_AUDIO', '音频格式或时长不符合要求。');
    return {
      mime,
      sizeBytes: stat.size,
      contentHash: await hashFile(path, DUBBING_LIMITS.audioMaxBytes),
      durationMs: Math.round(probe.durationMs),
      sampleRate: probe.sampleRate,
      channels: probe.channels,
    };
  }

  async importAudio(params: AudioImportParams): Promise<AudioImportResult> {
    const context = this.capture();
    this.access(true, () => undefined);
    if (
      typeof params.sourcePath !== 'string' ||
      !isAbsolute(params.sourcePath) ||
      lstatSync(params.sourcePath).isSymbolicLink()
    )
      throw new DubbingValidationError('INVALID_IMPORT', '请选择本地 WAV 或 MP3 文件。');
    const cue = params.cueId ? this.access(false, (repo) => repo.getCue(params.cueId!)) : undefined;
    if (params.cueId && (!cue || cue.rowVersion !== params.expectedRowVersion))
      throw new DubbingValidationError('CUE_CHANGED', '台词已变化，请重新选择导入位置。');
    if (cue && params.sceneId && cue.sceneId !== params.sceneId)
      throw new DubbingValidationError('CUE_CHANGED', '导入台词与场次不匹配。');
    const directory = resolveDubbingFile(
      context.root,
      join('cache', 'dubbing', `import-${randomUUID()}`),
      true,
    );
    mkdirSync(directory, { recursive: true });
    const staged = join(directory, `input${extname(params.sourcePath).toLowerCase()}`);
    try {
      if (statSync(params.sourcePath).size > DUBBING_LIMITS.audioMaxBytes)
        throw new DubbingValidationError('INVALID_AUDIO_SIZE', '音频不能超过 20 MiB。');
      assertStorageCapacity(directory, statSync(params.sourcePath).size);
      copyFileSync(params.sourcePath, staged, 1);
      const metadata = await this.inspectAudio(staged);
      this.assertCurrent(context.sessionId);
      const result = this.commitAudio(staged, metadata, {
        ...context,
        kind: params.kind ?? 'imported-dialogue',
        name: params.name ?? basename(params.sourcePath),
        cue,
      });
      this.revision += 1;
      return result;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  private commitAudio(
    staged: string,
    metadata: Awaited<ReturnType<DubbingService['inspectAudio']>>,
    input: {
      root: string;
      projectId: string;
      sessionId: string;
      kind: AudioFileInfo['kind'];
      name: string;
      cue?: DubbingCueInfo;
      voice?: VoiceProfileInfo;
      sourceJobId?: string;
    },
  ): AudioImportResult {
    this.assertCurrent(input.sessionId);
    const id = randomUUID();
    const relativePath = posix.join(
      'assets',
      'audio',
      input.kind === 'reference' ? 'reference' : 'dialogue',
      `${id}${metadata.mime === 'audio/wav' ? '.wav' : '.mp3'}`,
    );
    const destination = resolveDubbingFile(input.root, relativePath, true);
    mkdirSync(dirname(destination), { recursive: true });
    assertStorageCapacity(dirname(destination), 0);
    const now = new Date().toISOString();
    const audio: AudioFileInfo = {
      id,
      projectId: input.projectId,
      kind: input.kind,
      name: input.name.slice(0, 120),
      relativePath,
      ...metadata,
      sourceJobId: input.sourceJobId,
      createdAt: now,
    };
    renameSync(staged, destination);
    try {
      return this.access(true, (repo, db) =>
        db.transaction(() => {
          repo.registerAudio(audio);
          let take: DubbingTakeInfo | undefined;
          if (input.cue) {
            const currentCue = repo.getCue(input.cue.id);
            if (!currentCue || currentCue.deletedAt)
              throw new DubbingValidationError('CUE_CHANGED', '原台词已被删除。');
            take = {
              id: randomUUID(),
              projectId: input.projectId,
              cueId: input.cue.id,
              cueRowVersion: input.cue.rowVersion,
              textHash: hash(input.cue.text),
              voiceVersionId: input.voice?.versionId,
              voiceSnapshot: input.voice,
              audioId: audio.id,
              sourceJobId: input.sourceJobId,
              parameters: {
                emotion: input.cue.emotion ?? 'calm',
                speakerKind: input.cue.speakerKind,
                characterDocumentId: input.cue.characterDocumentId ?? null,
                voiceProfileId: input.cue.voiceProfileId ?? null,
                contractRevision: DUBBING_CONTRACT_REVISION,
              },
              createdAt: now,
            };
            repo.addTake(take);
          }
          if (input.sourceJobId) {
            const job = repo.getJob(input.sourceJobId)!;
            if (job.status !== 'running')
              throw new DubbingValidationError('CANCELLED', '配音任务已不再允许提交结果。');
            repo.updateJob(
              job.id,
              {
                status: 'complete',
                outputAudioId: audio.id,
                error: undefined,
                errorKind: undefined,
              },
              job.rowVersion,
            );
          }
          return { audio, take };
        })(),
      );
    } catch (error) {
      rmSync(destination, { force: true });
      throw error;
    }
  }

  adoptTake(cueId: string, takeId: string, rowVersion: number) {
    const adopted = this.access(true, (repo) => {
      const cue = repo.getCue(cueId);
      const take = repo.getTake(takeId);
      if (!cue || !take || !matchesTake(cue, take))
        throw new DubbingValidationError(
          'STALE_TAKE',
          '此配音对应的台词已变化，请重新生成或导入。',
        );
      const audio = repo.getAudio(take.audioId);
      if (!audio || audio.deletedAt)
        throw new DubbingValidationError('AUDIO_UNAVAILABLE', '该配音文件已不可用。');
      resolveDubbingFile(this.capture().root, audio.relativePath);
      return repo.adoptTake(cueId, takeId, rowVersion);
    });
    this.revision += 1;
    return adopted;
  }

  trashAudio(audioId: string) {
    const context = this.capture();
    return this.access(true, (repo) => {
      const audio = repo.getAudio(audioId);
      if (!audio) throw new DubbingValidationError('AUDIO_UNAVAILABLE', '音频不存在。');
      if (audio.deletedAt) return audio;
      if (repo.countAudioReferences(audioId))
        throw new DubbingValidationError(
          'AUDIO_REFERENCED',
          '音频仍被声音、配音版本或任务引用，不能删除。',
        );
      const source = resolveDubbingFile(context.root, audio.relativePath);
      const trashRelative = posix.join('assets', 'audio', '.trash', basename(audio.relativePath));
      const target = resolveDubbingFile(context.root, trashRelative, true);
      mkdirSync(dirname(target), { recursive: true });
      if (existsSync(target)) throw new DubbingValidationError('FILE_CONFLICT', '回收站文件冲突。');
      renameSync(source, target);
      try {
        return repo.trashAudio(audioId, trashRelative);
      } catch (error) {
        renameSync(target, source);
        throw error;
      }
    });
  }
  restoreAudio(audioId: string) {
    const context = this.capture();
    return this.access(true, (repo) => {
      const audio = repo.getAudio(audioId);
      if (!audio) throw new DubbingValidationError('AUDIO_UNAVAILABLE', '音频不存在。');
      if (!audio.deletedAt) return audio;
      const source = resolveDubbingFile(context.root, audio.trashRelativePath!);
      const target = resolveDubbingFile(context.root, audio.relativePath, true);
      if (existsSync(target))
        throw new DubbingValidationError('FILE_CONFLICT', '恢复位置已存在文件。');
      mkdirSync(dirname(target), { recursive: true });
      renameSync(source, target);
      try {
        return repo.restoreAudio(audioId);
      } catch (error) {
        renameSync(target, source);
        throw error;
      }
    });
  }
  purgeAudio(audioId: string, confirm: boolean) {
    if (!confirm) throw new DubbingValidationError('CONFIRM_REQUIRED', '请确认彻底删除音频。');
    const context = this.capture();
    return this.access(true, (repo) => {
      const audio = repo.getAudio(audioId);
      if (!audio?.deletedAt || repo.countAudioReferences(audioId))
        throw new DubbingValidationError('AUDIO_REFERENCED', '只能彻底删除未被引用的回收站音频。');
      const source = resolveDubbingFile(context.root, audio.trashRelativePath!);
      const tomb = `${source}.${randomUUID()}.purging`;
      renameSync(source, tomb);
      try {
        repo.purgeAudio(audioId);
      } catch (error) {
        renameSync(tomb, source);
        throw error;
      }
      rmSync(tomb, { force: true });
      return { purged: true as const };
    });
  }

  listJobs(sceneId?: string) {
    return this.access(false, (repo) => repo.listJobs(sceneId));
  }
  private jobSummary(job: DubbingJobInfo): DubbingJobInfo {
    const cue = (job.inputSnapshot as unknown as Partial<SpeechInput>).cue;
    return {
      ...job,
      inputSnapshot: {
        cueId: cue?.id,
        sourceVideoAssetId: job.sourceVideoAssetId,
        providerProfileId: job.inputSnapshot.providerProfileId,
      },
      steps: (job.steps ?? []).slice(-3).map((step) => ({
        ...step,
        dependencies: step.dependencies.slice(0, DUBBING_LIMITS.jobMaxSteps),
      })),
    };
  }
  listJobSummaries(sceneId?: string) {
    return this.listJobs(sceneId)
      .slice(0, 100)
      .map((job) => this.jobSummary(job));
  }
  getJob(jobId: string) {
    return this.access(false, (repo) => repo.getJob(jobId) ?? null);
  }
  getRevision() {
    return this.revision;
  }
  async inspectIntegrity(): Promise<string[]> {
    const context = this.capture();
    const records = this.access(false, (repo) => ({
      audio: [...repo.listAudio(), ...repo.listAudio({ deleted: 'trash' })],
      jobs: repo.listJobs(),
    }));
    const failures: string[] = [];
    for (const audio of records.audio) {
      try {
        const path = resolveDubbingFile(
          context.root,
          audio.deletedAt ? audio.trashRelativePath! : audio.relativePath,
        );
        if ((await hashFile(path, DUBBING_LIMITS.audioMaxBytes)) !== audio.contentHash)
          throw new Error('hash');
      } catch {
        failures.push(`配音文件不可用或内容变化：${audio.id}`);
      }
      this.assertCurrent(context.sessionId);
    }
    for (const job of records.jobs)
      for (const step of job.steps ?? []) {
        if (!step.resultRelativePath || !step.resultContentHash) continue;
        try {
          if (
            (await hashFile(
              resolveDubbingFile(context.root, step.resultRelativePath),
              MAX_VIDEO_BYTES,
            )) !== step.resultContentHash
          )
            throw new Error('hash');
        } catch {
          failures.push(`口型制作片段不可用或内容变化：${step.id}`);
        }
        this.assertCurrent(context.sessionId);
      }
    const assetIds = new Set(
      records.jobs.flatMap((job) =>
        [job.sourceVideoAssetId, job.outputAssetId].filter((id): id is string => Boolean(id)),
      ),
    );
    for (const assetId of assetIds) {
      const asset = this.access(false, (_repo, database) =>
        createRepositories(database).assets.get(assetId),
      );
      try {
        if (!asset) throw new Error('missing');
        const path = resolveDubbingFile(
          context.root,
          asset.deletedAt ? asset.trashRelativePath! : asset.relativePath,
        );
        if ((await hashFile(path, MAX_VIDEO_BYTES)) !== asset.contentHash) throw new Error('hash');
      } catch {
        failures.push(`配音关联的视频不可用或内容变化：${assetId}`);
      }
      this.assertCurrent(context.sessionId);
    }
    return failures;
  }
  private patchJob(jobId: string, patch: Partial<DubbingJobInfo>) {
    const job = this.access(true, (repo) => {
      const old = repo.getJob(jobId);
      if (!old) throw new Error('制作任务不存在。');
      return repo.updateJob(jobId, patch, old.rowVersion);
    });
    this.revision += 1;
    return job;
  }
  private patchStep(stepId: string, jobId: string, patch: Partial<DubbingJobStepInfo>) {
    return this.access(true, (repo) => {
      const old = repo.listSteps(jobId).find((step) => step.id === stepId);
      if (!old) throw new Error('制作步骤不存在。');
      return repo.updateStep(stepId, patch, old.rowVersion);
    });
  }
  private addJob(
    kind: DubbingJobInfo['kind'],
    sceneId: string,
    inputSnapshot: Record<string, unknown>,
    budget: DubbingBudgetSnapshot,
    sourceVideoAssetId?: string,
    audioIds: string[] = [],
  ): DubbingJobInfo {
    const context = this.capture();
    const now = new Date().toISOString();
    const inputHash = hash(JSON.stringify(inputSnapshot));
    return this.access(true, (repo, database) => {
      const inputs = inputSnapshot as unknown as Partial<SceneInput>;
      for (const item of inputs.cues ?? []) {
        const cue = repo.getCue(item.cue.id);
        if (
          !cue ||
          cue.deletedAt ||
          cue.rowVersion !== item.cue.rowVersion ||
          cue.selectedTakeId !== item.take.id
        )
          throw new DubbingValidationError(
            'CUE_CHANGED',
            '制作准备期间台词或配音版本发生变化，请重新确认。',
          );
      }
      const existing = repo
        .listJobs(sceneId)
        .find(
          (job) =>
            job.inputHash === inputHash &&
            job.kind === kind &&
            (ACTIVE_STATUSES.has(job.status) ||
              job.status === 'submission_unknown' ||
              job.status === 'complete'),
        );
      if (existing) return existing;
      assertProjectTaskAdmission(database);
      const job: DubbingJobInfo = {
        id: randomUUID(),
        projectId: context.projectId,
        sceneId,
        kind,
        status: 'pending',
        planVersion: 1,
        inputHash,
        inputSnapshot,
        budget,
        idempotencyKey: randomUUID(),
        sourceVideoAssetId,
        deadline: new Date(Date.now() + 60 * 60_000).toISOString(),
        rowVersion: 1,
        createdAt: now,
        updatedAt: now,
      };
      repo.addJob(job, audioIds);
      return repo.getJob(job.id)!;
    });
  }
  private ensureStep(
    job: DubbingJobInfo,
    stepKey: string,
    kind: DubbingJobStepInfo['kind'],
    inputHash = hash(`${job.inputHash}:${stepKey}`),
  ): DubbingJobStepInfo {
    return this.access(true, (repo) => {
      const existing = repo
        .listSteps(job.id)
        .filter((step) => step.stepKey === stepKey)
        .sort((a, b) => b.attempt - a.attempt)[0];
      if (existing) return existing;
      const now = new Date().toISOString();
      const step: DubbingJobStepInfo = {
        id: randomUUID(),
        jobId: job.id,
        stepKey,
        kind,
        dependencies: [],
        status: 'pending',
        attempt: 1,
        inputHash,
        idempotencyKey: randomUUID(),
        deadline: job.deadline,
        rowVersion: 1,
        createdAt: now,
        updatedAt: now,
      };
      repo.addStep(step);
      return repo.listSteps(job.id).find((entry) => entry.id === step.id)!;
    });
  }

  generateTake(params: DubbingTakeGenerateParams): DubbingJobInfo {
    if (params.costAcknowledged !== true)
      throw new DubbingValidationError('COST_ACK_REQUIRED', '请确认生成配音会产生费用。');
    const frozen = this.access(true, (repo) => {
      const cue = repo.getCue(params.cueId);
      if (!cue || cue.deletedAt || cue.rowVersion !== params.expectedRowVersion)
        throw new DubbingValidationError('CUE_CHANGED', '台词已变化，请刷新后生成。');
      const voice = cue.voiceProfileId
        ? repo.getVoice(cue.voiceProfileId)
        : cue.characterDocumentId
          ? repo.getVoiceForCharacter(cue.characterDocumentId)
          : undefined;
      if (!voice || voice.archivedAt)
        throw new DubbingValidationError('VOICE_REQUIRED', '请先为说话角色或旁白绑定固定声音。');
      this.assertSpeakerActive(cue);
      if (params.providerProfileId && params.providerProfileId !== voice.providerProfileId)
        throw new DubbingValidationError('VOICE_PROVIDER_MISMATCH', '配音连接与角色声音不匹配。');
      this.validateConnection(voice.providerProfileId, 'speech', voice.model);
      const uncertain = repo.listJobs(cue.sceneId).find((job) => {
        const snapshot = job.inputSnapshot as unknown as SpeechInput;
        return (
          job.kind === 'speech' &&
          (job.status === 'submission_unknown' ||
            job.steps?.some((step) => step.status === 'submission_unknown')) &&
          snapshot.cue?.id === cue.id &&
          snapshot.cue?.text === cue.text &&
          snapshot.voice?.versionId === voice.versionId
        );
      });
      if (uncertain)
        throw new DubbingValidationError(
          'SUBMISSION_UNKNOWN',
          '这条配音的提交结果仍未核实，请先核对供应商记录，勿重复付费生成。',
        );
      if (!params.forceNewTake) {
        const previous = repo.listJobs(cue.sceneId).find((job) => {
          const snapshot = job.inputSnapshot as unknown as SpeechInput;
          return (
            job.kind === 'speech' &&
            job.status === 'complete' &&
            snapshot.cue?.id === cue.id &&
            snapshot.cue?.text === cue.text &&
            snapshot.cue?.emotion === cue.emotion &&
            snapshot.voice?.versionId === voice.versionId
          );
        });
        if (previous) return { previous, cue, voice };
      }
      const plainCue = { ...cue };
      delete plainCue.takes;
      return { cue: plainCue, voice, previous: undefined };
    });
    if (frozen.previous) return frozen.previous;
    const budget = budgetSnapshot(params.budget, params.costAcknowledged, 0, 1);
    if (params.budget?.unitPrice !== undefined)
      throw new DubbingValidationError(
        'INVALID_BUDGET',
        '本版 TTS 按单次确认执行，尚不提供按秒估价。',
      );
    const input = {
      cue: frozen.cue,
      voice: frozen.voice,
      ...(params.forceNewTake ? { requestedTake: randomUUID() } : {}),
    };
    const job = this.addJob('speech', frozen.cue.sceneId, input, budget);
    this.launch(job);
    return job;
  }

  async submit(params: DubbingJobSubmitParams): Promise<DubbingJobInfo> {
    const context = this.capture();
    if (params.removeSourceAudioAcknowledged !== true)
      throw new DubbingValidationError(
        'SOURCE_AUDIO_ACK_REQUIRED',
        '请确认成片使用固定配音，并移除源视频原有声音。',
      );
    if (params.mode !== 'compose' && params.mode !== 'lipsync')
      throw new DubbingValidationError('INVALID_MODE', '制作方式无效。');
    const snapshot = this.access(true, (repo, db) => {
      const source = createRepositories(db).assets.get(params.sourceVideoAssetId);
      if (
        !source ||
        source.projectId !== context.projectId ||
        source.deletedAt ||
        !source.kind.includes('video')
      )
        throw new DubbingValidationError('VIDEO_REQUIRED', '请选择当前项目中可用的视频。');
      const cues = repo.listCues(params.sceneId);
      if (!cues.length)
        throw new DubbingValidationError('CUES_REQUIRED', '请先保存场次台词并确认配音版本。');
      const frozen: FrozenCue[] = cues
        .map((cue) => {
          const take = cue.selectedTakeId ? repo.getTake(cue.selectedTakeId) : undefined;
          const audio = take ? repo.getAudio(take.audioId) : undefined;
          if (!take || !audio || audio.deletedAt || !matchesTake(cue, take))
            throw new DubbingValidationError(
              'TAKE_REQUIRED',
              '每条台词都需要采用与当前文本一致的配音。',
            );
          const plainCue = { ...cue };
          delete plainCue.takes;
          return { cue: plainCue, take, audio, endMs: cue.startMs + audio.durationMs };
        })
        .sort(
          (left, right) =>
            left.cue.startMs - right.cue.startMs || left.cue.position - right.cue.position,
        );
      for (let i = 0; i < frozen.length; i += 1) {
        const current = frozen[i]!;
        if (
          i &&
          current.cue.startMs < frozen[i - 1]!.endMs + (frozen[i - 1]!.cue.trailingPauseMs ?? 0)
        )
          throw new DubbingValidationError('OVERLAPPING_CUES', '台词时间重叠，请调整开始时间。');
        if (
          current.cue.lipSync &&
          (current.cue.speakerKind !== 'character' ||
            !current.cue.visibleSpeaker?.trim() ||
            !current.cue.speakerCoordinates)
        )
          throw new DubbingValidationError(
            'SPEAKER_REQUIRED',
            '口型片段需明确一个可见人物，并选择其画面坐标。',
          );
        if (
          params.mode === 'lipsync' &&
          current.cue.lipSync &&
          current.audio.durationMs > DUBBING_LIMITS.clipMaxDurationMs
        )
          throw new DubbingValidationError('CLIP_TOO_LONG', '单个口型片段不能超过 60 秒。');
      }
      return { source, cues: frozen };
    });
    const sourcePath = resolveDubbingFile(context.root, snapshot.source.relativePath);
    const probe = await this.capacity.run('ffmpeg', context.projectId, undefined, () =>
      this.runtime.probe(sourcePath),
    );
    this.assertCurrent(context.sessionId);
    if (
      !probe.hasVideo ||
      probe.durationMs <= 0 ||
      probe.durationMs > DUBBING_LIMITS.sceneMaxDurationMs
    )
      throw new DubbingValidationError('INVALID_VIDEO', '视频时长需在 10 分钟以内。');
    if (snapshot.cues.some((item) => item.endMs > Math.floor(probe.durationMs)))
      throw new DubbingValidationError(
        'VIDEO_TOO_SHORT',
        '视频长度不足以容纳完整台词，请延长画面或调整开始时间。',
      );
    const sourceHash = await hashFile(sourcePath, MAX_VIDEO_BYTES);
    if (sourceHash !== snapshot.source.contentHash)
      throw new DubbingValidationError(
        'VIDEO_CHANGED',
        '源视频内容发生变化，请执行项目完整性检查。',
      );
    const lipCues =
      params.mode === 'lipsync' ? snapshot.cues.filter((item) => item.cue.lipSync) : [];
    let budget: DubbingBudgetSnapshot = {
      state: 'estimated',
      currency: 'LOCAL',
      unit: 'local-task',
      unitPrice: 0,
      estimatedTotal: 0,
      maxAttempts: 1,
    };
    if (lipCues.length) {
      if (!params.providerProfileId || (params.model ?? 'sync-3') !== 'sync-3')
        throw new DubbingValidationError('PROVIDER_REQUIRED', '请选择 Sync-3 官方口型连接。');
      this.validateConnection(params.providerProfileId, 'lipsync', 'sync-3');
      budget = budgetSnapshot(
        params.budget,
        params.costAcknowledged,
        lipCues.reduce((total, item) => total + item.audio.durationMs / 1_000, 0),
        lipCues.length,
      );
    }
    for (const item of snapshot.cues) {
      const audioPath = resolveDubbingFile(context.root, item.audio.relativePath);
      if ((await hashFile(audioPath, DUBBING_LIMITS.audioMaxBytes)) !== item.audio.contentHash)
        throw new DubbingValidationError('AUDIO_CHANGED', '配音文件发生变化，请重新导入。');
    }
    this.assertCurrent(context.sessionId);
    const input: SceneInput = {
      sourceVideoAssetId: snapshot.source.id,
      sourceRelativePath: snapshot.source.relativePath,
      sourceContentHash: sourceHash,
      durationMs: Math.round(probe.durationMs),
      providerProfileId: lipCues.length ? params.providerProfileId : undefined,
      model: lipCues.length ? 'sync-3' : undefined,
      cues: snapshot.cues,
    };
    if (lipCues.length) {
      const unresolved = this.access(false, (repo) =>
        repo.listJobs(params.sceneId).some((previous) => {
          const old = previous.inputSnapshot as unknown as Partial<SceneInput>;
          return (
            previous.inputHash !== hash(JSON.stringify(input)) &&
            previous.kind === 'lipsync' &&
            old.sourceVideoAssetId === snapshot.source.id &&
            (previous.steps ?? []).some(
              (step) =>
                (step.status === 'submission_unknown' ||
                  (step.status !== 'complete' && Boolean(step.providerTaskId))) &&
                lipCues.some((item) => step.stepKey === `lipsync:${item.cue.id}`),
            )
          );
        }),
      );
      if (unresolved)
        throw new DubbingValidationError(
          'SUBMISSION_UNKNOWN',
          '所选片段已有未完成或待核实的远端任务，请先恢复原任务，勿重复提交。',
        );
    }
    const job = this.addJob(
      lipCues.length ? 'lipsync' : 'compose',
      params.sceneId,
      input as unknown as Record<string, unknown>,
      budget,
      snapshot.source.id,
      snapshot.cues.map((item) => item.audio.id),
    );
    this.launch(job);
    return job;
  }

  private launch(job: DubbingJobInfo): void {
    if (this.running.has(job.id) || !ACTIVE_STATUSES.has(job.status)) return;
    const context = this.capture();
    const controller = new AbortController();
    const done = Promise.resolve()
      .then(async () => {
        this.assertCurrent(context.sessionId, controller.signal);
        if (this.getJob(job.id)?.status === 'cancelled') return;
        if (job.deadline && Date.now() >= Date.parse(job.deadline))
          throw new DubbingValidationError(
            'DEADLINE_EXCEEDED',
            '制作任务已超过授权等待期限，请重新确认。',
          );
        this.patchJob(job.id, { status: 'running', error: undefined, errorKind: undefined });
        if (job.kind === 'speech') await this.runSpeech(job, context, controller.signal);
        else await this.runScene(job, context, controller.signal);
      })
      .catch((error) => {
        if (this.projects.currentSessionId() !== context.sessionId) return;
        const current = this.getJob(job.id);
        if (!current || ['complete', 'cancelled', 'submission_unknown'].includes(current.status))
          return;
        const details = errorDetails(error);
        this.patchJob(job.id, {
          ...details,
          status: controller.signal.aborted ? 'cancelled' : 'failed',
        });
      })
      .finally(() => {
        if (this.running.get(job.id)?.controller === controller) this.running.delete(job.id);
        this.revision += 1;
      });
    this.running.set(job.id, { controller, sessionId: context.sessionId, done });
  }

  private async runSpeech(
    job: DubbingJobInfo,
    context: ReturnType<DubbingService['capture']>,
    signal: AbortSignal,
  ) {
    const input = job.inputSnapshot as unknown as SpeechInput;
    const availability = await this.capacity.run('ffmpeg', context.projectId, signal, () =>
      this.runtime.availability(),
    );
    if (!availability.available)
      throw new DubbingValidationError(
        'MEDIA_RUNTIME_UNAVAILABLE',
        '本地媒体处理工具不可用，尚未提交配音请求。',
      );
    this.assertCurrent(context.sessionId, signal);
    this.validateConnection(input.voice.providerProfileId, 'speech', input.voice.model);
    this.assertSpeakerActive(input.cue);
    const step = this.ensureStep(job, 'speech', 'speech');
    const relativePath = posix.join('cache', 'dubbing', job.id, `${randomUUID()}.mp3`);
    const staged = resolveDubbingFile(context.root, relativePath, true);
    mkdirSync(dirname(staged), { recursive: true });
    assertStorageCapacity(dirname(staged), DUBBING_LIMITS.audioMaxBytes);
    let result: NativeDubbingSpeechResult;
    let submitted = false;
    try {
      if (job.deadline && Date.now() >= Date.parse(job.deadline))
        throw new DubbingValidationError(
          'DEADLINE_EXCEEDED',
          '配音请求未发送：制作已超过等待期限。',
        );
      result = await this.nativeOperation<NativeDubbingSpeechResult>(
        'speech',
        job,
        job.id,
        context,
        signal,
        'provider.dubbing.speech',
        {
          projectRoot: context.root,
          providerProfileId: input.voice.providerProfileId,
          model: input.voice.model,
          voiceId: input.voice.voiceId,
          text: input.cue.text,
          speed: input.voice.speed,
          pitch: input.voice.pitch,
          emotion: input.cue.emotion,
          outputRelativePath: relativePath,
          operationId: job.id,
        },
        () => {
          this.validateConnection(input.voice.providerProfileId, 'speech', input.voice.model);
          this.assertSpeakerActive(input.cue);
          this.patchStep(step.id, job.id, { status: 'running' });
          submitted = true;
        },
      );
      this.assertCurrent(context.sessionId, signal);
      if (
        !result ||
        result.relativePath !== relativePath ||
        result.mime !== 'audio/mpeg' ||
        result.sizeBytes !== statSync(staged).size
      )
        throw new DubbingValidationError('INVALID_PROVIDER_OUTPUT', '配音结果不完整，制作未完成。');
      const metadata = await this.inspectAudio(staged, signal);
      this.assertCurrent(context.sessionId, signal);
      const committed = this.commitAudio(staged, metadata, {
        ...context,
        cue: input.cue,
        voice: input.voice,
        sourceJobId: job.id,
        kind: 'generated-dialogue',
        name: `配音 · ${input.cue.text.slice(0, 24)}`,
      });
      this.patchStep(step.id, job.id, { status: 'complete', resultAudioId: committed.audio.id });
    } catch (error) {
      if (
        submitted &&
        signal.aborted &&
        this.projects.currentSessionId() === context.sessionId &&
        !(
          error instanceof NativeProviderRequestError &&
          ['REQUEST_NOT_SENT', 'INVALID_PARAMETERS', 'METHOD_NOT_FOUND'].includes(
            error.hostError.code,
          )
        )
      )
        this.patchStep(step.id, job.id, {
          status: 'submission_unknown',
          errorKind: 'SUBMISSION_UNKNOWN',
          error: '配音提交中断，结果待核实。',
        });
      if (this.projects.currentSessionId() === context.sessionId && !signal.aborted) {
        const detail = errorDetails(error);
        const unknown =
          error instanceof NativeProviderRequestError &&
          (['TIMEOUT', 'INTERRUPTED', 'SUBMISSION_UNKNOWN', 'INVALID_ENVELOPE'].includes(
            error.hostError.code,
          ) ||
            (error.hostError.providerStatus ?? 0) >= 500 ||
            error.hostError.providerStatus === 408);
        this.patchStep(step.id, job.id, {
          ...detail,
          status: unknown ? 'submission_unknown' : 'failed',
        });
        if (unknown) this.patchJob(job.id, { ...detail, status: 'submission_unknown' });
      }
      throw error;
    } finally {
      rmSync(staged, { force: true });
    }
  }

  private async wait(delay: number, signal: AbortSignal) {
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
        reject(new DubbingValidationError('CANCELLED', '制作已取消。'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', stop);
        resolve();
      }, delay);
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    });
  }

  private async runScene(
    job: DubbingJobInfo,
    context: ReturnType<DubbingService['capture']>,
    signal: AbortSignal,
  ) {
    const input = job.inputSnapshot as unknown as SceneInput;
    const staleUnknown = (job.steps ?? []).some(
      (step) => step.kind === 'lipsync' && step.status === 'submission_unknown',
    );
    if (staleUnknown)
      throw new DubbingValidationError(
        'SUBMISSION_UNKNOWN',
        '至少一个片段的提交待核实，禁止自动重发。',
      );
    const source = resolveDubbingFile(context.root, input.sourceRelativePath);
    if ((await hashFile(source, MAX_VIDEO_BYTES)) !== input.sourceContentHash)
      throw new DubbingValidationError('VIDEO_CHANGED', '源视频内容发生变化。');
    const clipsController = new AbortController();
    const clipSignal = AbortSignal.any([signal, clipsController.signal]);
    const parts = await mapConcurrent(input.cues, 2, async (item) => {
      try {
        this.assertCurrent(context.sessionId, clipSignal);
        const audioPath = resolveDubbingFile(context.root, item.audio.relativePath);
        if ((await hashFile(audioPath, DUBBING_LIMITS.audioMaxBytes)) !== item.audio.contentHash)
          throw new DubbingValidationError('AUDIO_CHANGED', '配音文件内容发生变化。');
        const part = {
          startMs: item.cue.startMs,
          endMs: item.endMs,
          audioPath,
          videoPath: undefined as string | undefined,
        };
        if (job.kind === 'lipsync' && item.cue.lipSync)
          part.videoPath = await this.runLipClip(job, input, item, context, clipSignal);

        return part;
      } catch (error) {
        clipsController.abort(error);
        throw error;
      }
    });
    this.assertCurrent(context.sessionId, signal);
    const composeStep = this.ensureStep(job, 'compose', 'compose');
    this.patchStep(composeStep.id, job.id, { status: 'running' });
    const outputRelative = posix.join('cache', 'dubbing', job.id, `${randomUUID()}.mp4`);
    const output = resolveDubbingFile(context.root, outputRelative, true);
    mkdirSync(dirname(output), { recursive: true });
    try {
      for (const item of input.cues)
        if (
          (await hashFile(
            resolveDubbingFile(context.root, item.audio.relativePath),
            DUBBING_LIMITS.audioMaxBytes,
          )) !== item.audio.contentHash
        )
          throw new DubbingValidationError('AUDIO_CHANGED', '配音在制作期间发生变化，成片未提交。');
      if ((await hashFile(source, MAX_VIDEO_BYTES)) !== input.sourceContentHash)
        throw new DubbingValidationError('VIDEO_CHANGED', '源视频在制作期间发生变化，成片未提交。');
      await this.capacity.run('ffmpeg', context.projectId, signal, () =>
        this.runtime.composeDubbing(source, output, parts, signal),
      );
      this.assertCurrent(context.sessionId, signal);
      const probe = await this.capacity.run('ffmpeg', context.projectId, signal, () =>
        this.runtime.probe(output, signal),
      );
      if (
        !probe.hasAudio ||
        !probe.hasVideo ||
        Math.abs(probe.durationMs - input.durationMs) > 1_000 / (probe.fps ?? 25) + 2
      )
        throw new DubbingValidationError(
          'INVALID_OUTPUT_TIMELINE',
          '成片时间轴与场次不一致，结果未入库。',
        );
      const digest = await hashFile(output, MAX_VIDEO_BYTES);
      this.assertCurrent(context.sessionId, signal);
      const assetId = randomUUID();
      const finalRelative = posix.join('assets', 'videos', `${assetId}.mp4`);
      const final = resolveDubbingFile(context.root, finalRelative, true);
      mkdirSync(dirname(final), { recursive: true });
      const sizeBytes = statSync(output).size;
      renameSync(output, final);
      try {
        this.access(true, (repo, db) =>
          db.transaction(() => {
            const now = new Date().toISOString();
            createRepositories(db).assets.save({
              id: assetId,
              projectId: context.projectId,
              kind: 'scene-video',
              alias: '固定配音成片',
              relativePath: finalRelative,
              contentHash: digest,
              sizeBytes,
              createdAt: now,
              updatedAt: now,
            });
            const current = repo.getJob(job.id)!;
            repo.updateJob(
              job.id,
              {
                status: 'complete',
                outputAssetId: assetId,
                error: undefined,
                errorKind: undefined,
              },
              current.rowVersion,
            );
            const step = repo.listSteps(job.id).find((entry) => entry.id === composeStep.id)!;
            repo.updateStep(
              step.id,
              { status: 'complete', resultAssetId: assetId },
              step.rowVersion,
            );
          })(),
        );
      } catch (error) {
        rmSync(final, { force: true });
        throw error;
      }
    } catch (error) {
      if (this.projects.currentSessionId() === context.sessionId && !signal.aborted)
        this.patchStep(composeStep.id, job.id, { status: 'failed', ...errorDetails(error) });
      throw error;
    } finally {
      rmSync(output, { force: true });
    }
  }

  private async runLipClip(
    job: DubbingJobInfo,
    input: SceneInput,
    item: FrozenCue,
    context: ReturnType<DubbingService['capture']>,
    signal: AbortSignal,
  ): Promise<string> {
    this.validateConnection(input.providerProfileId!, 'lipsync', 'sync-3');
    const intervalHash = hash(
      JSON.stringify({
        source: input.sourceContentHash,
        startMs: item.cue.startMs,
        endMs: item.endMs,
        audio: item.audio.contentHash,
        speaker: item.cue.speakerCoordinates,
        profile: input.providerProfileId,
        model: input.model,
        contract: DUBBING_CONTRACT_REVISION,
      }),
    );
    let step = this.ensureStep(job, `lipsync:${item.cue.id}`, 'lipsync', intervalHash);
    if (step.status === 'pending') {
      const reusable = this.access(false, (repo) =>
        repo
          .listJobs()
          .flatMap((previous) => previous.steps ?? [])
          .find(
            (previous) =>
              previous.id !== step.id &&
              previous.kind === 'lipsync' &&
              previous.status === 'complete' &&
              previous.inputHash === intervalHash &&
              previous.resultRelativePath &&
              previous.resultContentHash,
          ),
      );
      if (reusable?.resultRelativePath && reusable.resultContentHash) {
        const reusablePath = resolveDubbingFile(context.root, reusable.resultRelativePath);
        if ((await hashFile(reusablePath, MAX_VIDEO_BYTES)) === reusable.resultContentHash) {
          this.assertCurrent(context.sessionId, signal);
          step = this.patchStep(step.id, job.id, {
            status: 'complete',
            resultRelativePath: reusable.resultRelativePath,
            resultContentHash: reusable.resultContentHash,
          });
        }
      }
    }
    if (step.status === 'complete' && step.resultRelativePath) {
      const saved = resolveDubbingFile(context.root, step.resultRelativePath);
      if (
        !step.resultContentHash ||
        (await hashFile(saved, MAX_VIDEO_BYTES)) !== step.resultContentHash
      )
        throw new DubbingValidationError(
          'LIP_RESULT_CHANGED',
          '已完成口型片段缺失或发生变化，需要明确重新制作。',
        );
      return saved;
    }
    const workRelative = posix.join('cache', 'dubbing', job.id, step.id);
    const directory = resolveDubbingFile(context.root, workRelative, true);
    mkdirSync(directory, { recursive: true });
    assertStorageCapacity(directory, DUBBING_LIMITS.audioMaxBytes);
    const videoRelative = posix.join(workRelative, 'input.mp4');
    const audioRelative = posix.join(workRelative, 'input.wav');
    const video = resolveDubbingFile(context.root, videoRelative, true);
    const audio = resolveDubbingFile(context.root, audioRelative, true);
    let submitStarted = false;
    try {
      if (!step.providerTaskId) {
        if (job.deadline && Date.now() >= Date.parse(job.deadline))
          throw new DubbingValidationError(
            'DEADLINE_EXCEEDED',
            '制作已超过等待期限，口型请求未发送。',
          );
        const clip = await this.capacity.run('ffmpeg', context.projectId, signal, () =>
          this.runtime.extractClip(
            resolveDubbingFile(context.root, input.sourceRelativePath),
            video,
            item.cue.startMs,
            item.endMs,
            signal,
          ),
        );
        await this.capacity.run('ffmpeg', context.projectId, signal, () =>
          this.runtime.convertAudio(
            resolveDubbingFile(context.root, item.audio.relativePath),
            audio,
            signal,
          ),
        );
        this.assertCurrent(context.sessionId, signal);
        if (job.deadline && Date.now() >= Date.parse(job.deadline))
          throw new DubbingValidationError(
            'DEADLINE_EXCEEDED',
            '口型请求未发送：制作已超过等待期限。',
          );
        try {
          const submitted = await this.nativeOperation<NativeDubbingSubmitResult>(
            'lip-sync',
            job,
            step.id,
            context,
            signal,
            'provider.dubbing.submit',
            {
              projectRoot: context.root,
              providerProfileId: input.providerProfileId,
              videoRelativePath: videoRelative,
              audioRelativePath: audioRelative,
              idempotencyKey: step.idempotencyKey,
              speakerCoordinates: item.cue.speakerCoordinates?.map((value, index) =>
                Math.min(
                  (index === 0 ? (clip.width ?? 1) : (clip.height ?? 1)) - 1,
                  Math.round(value * (index === 0 ? (clip.width ?? 1) : (clip.height ?? 1))),
                ),
              ),
              operationId: job.id,
            },
            () => {
              this.validateConnection(input.providerProfileId!, 'lipsync', input.model!);
              step = this.patchStep(step.id, job.id, { status: 'running' });
              submitStarted = true;
            },
          );
          if (
            signal.aborted &&
            this.projects.currentSessionId() === context.sessionId &&
            submitted?.providerTaskId &&
            /^[\w.-]{1,128}$/.test(submitted.providerTaskId)
          ) {
            this.patchStep(step.id, job.id, {
              providerTaskId: submitted.providerTaskId,
              status: 'cancelled',
            });
            this.patchJob(job.id, { providerTaskId: submitted.providerTaskId });
          }
          this.assertCurrent(context.sessionId, signal);
          if (
            !submitted ||
            typeof submitted.providerTaskId !== 'string' ||
            !/^[\w.-]{1,256}$/.test(submitted.providerTaskId)
          )
            throw new DubbingValidationError(
              'SUBMISSION_UNKNOWN',
              '供应商未返回可核对的任务 ID，请人工核对，勿重复提交。',
            );
          step = this.patchStep(step.id, job.id, {
            providerTaskId: submitted.providerTaskId,
            status: 'running',
          });
          this.patchJob(job.id, { providerTaskId: submitted.providerTaskId });
        } catch (error) {
          if (
            signal.aborted &&
            this.projects.currentSessionId() === context.sessionId &&
            error instanceof NativeProviderRequestError &&
            error.hostError.providerTaskId
          ) {
            this.patchStep(step.id, job.id, {
              providerTaskId: error.hostError.providerTaskId,
              status: 'cancelled',
            });
            this.patchJob(job.id, { providerTaskId: error.hostError.providerTaskId });
          }
          if (
            signal.aborted &&
            submitStarted &&
            !this.access(
              false,
              (repo) =>
                repo.listSteps(job.id).find((entry) => entry.id === step.id)?.providerTaskId,
            ) &&
            !(
              error instanceof NativeProviderRequestError &&
              ['REQUEST_NOT_SENT', 'INVALID_PARAMETERS', 'METHOD_NOT_FOUND'].includes(
                error.hostError.code,
              )
            )
          ) {
            this.patchStep(step.id, job.id, {
              status: 'submission_unknown',
              errorKind: 'SUBMISSION_UNKNOWN',
              error: '口型提交中断，结果待核实，禁止自动重发。',
            });
            if (this.getJob(job.id)?.status !== 'cancelled')
              this.patchJob(job.id, {
                status: 'submission_unknown',
                errorKind: 'SUBMISSION_UNKNOWN',
                error: '至少一个口型片段提交结果未知，需核实后继续。',
              });
          }
          this.assertCurrent(context.sessionId, signal);
          const recoverableTaskId =
            error instanceof NativeProviderRequestError
              ? error.hostError.providerTaskId
              : undefined;
          if (recoverableTaskId && /^[\w.-]{1,128}$/.test(recoverableTaskId)) {
            step = this.patchStep(step.id, job.id, {
              providerTaskId: recoverableTaskId,
              status: 'running',
            });
            this.patchJob(job.id, { providerTaskId: recoverableTaskId });
          } else {
            const unknown =
              (error instanceof NativeProviderRequestError &&
                (['TIMEOUT', 'INTERRUPTED', 'SUBMISSION_UNKNOWN', 'INVALID_ENVELOPE'].includes(
                  error.hostError.code,
                ) ||
                  (error.hostError.providerStatus ?? 0) >= 500 ||
                  error.hostError.providerStatus === 408)) ||
              (error instanceof DubbingValidationError && error.code === 'SUBMISSION_UNKNOWN');
            const details = errorDetails(error);
            this.patchStep(step.id, job.id, {
              ...details,
              status: unknown ? 'submission_unknown' : 'failed',
            });
            if (unknown) this.patchJob(job.id, { ...details, status: 'submission_unknown' });
            throw error;
          }
        }
      }
      let failures = 0;
      while (Date.now() < Date.parse(job.deadline!)) {
        this.assertCurrent(context.sessionId, signal);
        const resultRelative = posix.join(workRelative, `result-${randomUUID()}.mp4`);
        const resultPath = resolveDubbingFile(context.root, resultRelative, true);
        assertStorageCapacity(directory, MAX_VIDEO_BYTES);
        let observed: NativeDubbingPollResult;
        try {
          observed = await this.nativeOperation<NativeDubbingPollResult>(
            'lip-sync',
            job,
            step.id,
            context,
            signal,
            'provider.dubbing.poll',
            {
              projectRoot: context.root,
              providerProfileId: input.providerProfileId,
              providerTaskId: step.providerTaskId,
              outputRelativePath: resultRelative,
              operationId: job.id,
            },
          );
          failures = 0;
        } catch (error) {
          this.assertCurrent(context.sessionId, signal);
          if (
            !(error instanceof NativeProviderRequestError) ||
            !(
              [
                'TIMEOUT',
                'INTERRUPTED',
                'PROVIDER_UNAVAILABLE',
                'REQUEST_NOT_SENT',
                'RATE_LIMITED',
              ].includes(error.hostError.code) ||
              (error.hostError.providerStatus ?? 0) >= 500 ||
              error.hostError.providerStatus === 408
            )
          )
            throw error;
          failures += 1;
          await this.wait(
            Math.min(30_000, (this.options.pollIntervalMs ?? 2_000) * 2 ** Math.min(failures, 4)),
            signal,
          );
          continue;
        }
        this.assertCurrent(context.sessionId, signal);
        if (!observed || !['pending', 'running', 'complete', 'failed'].includes(observed.status))
          throw new DubbingValidationError('INVALID_PROVIDER_OUTPUT', '口型服务返回的状态无效。');
        if (observed.status === 'failed')
          throw new DubbingValidationError(
            'REMOTE_TASK_FAILED',
            '口型任务失败，请检查人物、素材和供应商额度。',
          );
        if (observed.status === 'complete') {
          try {
            if (observed.relativePath !== resultRelative)
              throw new DubbingValidationError('INVALID_PROVIDER_OUTPUT', '口型视频结果不完整。');
            const probe = await this.capacity.run('ffmpeg', context.projectId, signal, () =>
              this.runtime.validate(resultPath, signal),
            );
            if (
              !probe.hasVideo ||
              Math.abs(probe.durationMs - item.audio.durationMs) > 1_000 / (probe.fps ?? 25) + 2
            )
              throw new DubbingValidationError(
                'INVALID_OUTPUT_TIMELINE',
                '口型片段改变了配音时长，结果未采用。',
              );
            const digest = await hashFile(resultPath, MAX_VIDEO_BYTES);
            this.assertCurrent(context.sessionId, signal);
            const retainedRelative = posix.join('assets', 'dubbing', job.id, `${step.id}.mp4`);
            const retained = resolveDubbingFile(context.root, retainedRelative, true);
            mkdirSync(dirname(retained), { recursive: true });
            if (existsSync(retained))
              throw new DubbingValidationError('FILE_CONFLICT', '口型片段保存位置冲突。');
            renameSync(resultPath, retained);
            try {
              this.patchStep(step.id, job.id, {
                status: 'complete',
                resultRelativePath: retainedRelative,
                resultContentHash: digest,
              });
            } catch (error) {
              renameSync(retained, resultPath);
              throw error;
            }
            return retained;
          } finally {
            rmSync(resultPath, { force: true });
          }
        }
        await this.wait(this.options.pollIntervalMs ?? 2_000, signal);
      }
      throw new DubbingValidationError(
        'PROVIDER_TIMEOUT',
        '口型任务达到等待期限，请核对供应商状态。',
      );
    } catch (error) {
      if (this.projects.currentSessionId() === context.sessionId && !signal.aborted) {
        const current = this.access(false, (repo) =>
          repo.listSteps(job.id).find((entry) => entry.id === step.id),
        );
        if (current && current.status !== 'submission_unknown' && current.status !== 'complete')
          this.patchStep(step.id, job.id, { status: 'failed', ...errorDetails(error) });
      }
      throw error;
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }

  cancel(jobId: string): DubbingJobInfo {
    const job = this.getJob(jobId);
    if (!job) throw new DubbingValidationError('JOB_NOT_FOUND', '制作任务不存在。');
    if (['complete', 'failed', 'cancelled'].includes(job.status)) return job;
    const activeIds = new Set(this.nativeOperations.get(jobId)?.keys() ?? []);
    const remoteSteps = this.access(false, (repo) =>
      repo
        .listSteps(jobId)
        .filter(
          (step) =>
            step.kind === 'lipsync' &&
            step.providerTaskId &&
            step.status !== 'complete' &&
            step.status !== 'cancelled',
        ),
    );
    this.running.get(jobId)?.controller.abort();
    this.access(true, (repo) => {
      for (const step of repo.listSteps(jobId)) {
        if (step.status !== 'complete' && step.status !== 'cancelled')
          repo.updateStep(
            step.id,
            { status: 'cancelled', errorKind: 'CANCELLED', error: '制作已停止。' },
            step.rowVersion,
          );
      }
    });
    const cancelled = this.patchJob(jobId, {
      status: 'cancelled',
      errorKind: 'CANCELLED',
      error: '制作已取消；远端已产生的费用仍以供应商为准。',
    });
    for (const step of remoteSteps)
      if (!activeIds.has(step.id))
        void this.options.native
          ?.request(
            'provider.dubbing.cancel',
            { operationId: step.id, providerTaskId: step.providerTaskId },
            5000,
          )
          .catch(() => undefined);
    return cancelled;
  }
  async cancelAll(): Promise<void> {
    if (!this.projects.current()) return;
    const active = [...this.running.values()].map((entry) => entry.done);
    for (const job of this.listJobs()) if (ACTIVE_STATUSES.has(job.status)) this.cancel(job.id);
    await Promise.race([
      Promise.allSettled(active),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  recover(): void {
    const project = this.projects.current();
    if (!project || project.mode !== 'read-write') return;
    for (const job of this.listJobs()) {
      if (!ACTIVE_STATUSES.has(job.status)) continue;
      if (job.kind === 'speech') {
        const uncertain = this.access(false, (repo) =>
          repo
            .listSteps(job.id)
            .some(
              (step) =>
                step.kind === 'speech' && ['running', 'submission_unknown'].includes(step.status),
            ),
        );
        this.patchJob(job.id, {
          status: uncertain ? 'submission_unknown' : 'failed',
          errorKind: uncertain ? 'SUBMISSION_UNKNOWN' : 'INTERRUPTED',
          error: uncertain
            ? '配音提交在完成前中断，请先核对供应商记录，不能直接重复生成。'
            : '配音任务在发送前中断，已保存的配音可继续使用；重新生成需再次确认费用。',
        });
      } else {
        const steps = this.access(false, (repo) => repo.listSteps(job.id));
        if (
          steps.some(
            (step) =>
              step.kind === 'lipsync' &&
              (step.status === 'submission_unknown' ||
                (step.status === 'running' && !step.providerTaskId)),
          )
        )
          this.patchJob(job.id, {
            status: 'submission_unknown',
            errorKind: 'SUBMISSION_UNKNOWN',
            error: '提交结果未知，请核对供应商任务，勿直接重新提交。',
          });
        else this.launch(job);
      }
    }
  }
  retry(params: DubbingJobRetryParams): DubbingJobInfo {
    const job = this.getJob(params.jobId);
    if (!job || job.status !== 'failed')
      throw new DubbingValidationError(
        'RETRY_UNAVAILABLE',
        '只有已明确失败的任务可以重试；未知提交需先核对。',
      );
    const allSteps = this.access(false, (repo) => repo.listSteps(job.id));
    if (allSteps.some((step) => step.status === 'submission_unknown'))
      throw new DubbingValidationError('SUBMISSION_UNKNOWN', '存在待核实片段，禁止重复付费提交。');
    const latest = new Map<string, DubbingJobStepInfo>();
    for (const step of allSteps)
      if (!latest.has(step.stepKey) || latest.get(step.stepKey)!.attempt < step.attempt)
        latest.set(step.stepKey, step);
    const steps = [...latest.values()];
    if (steps.some((step) => step.errorKind === 'REMOTE_TASK_FAILED'))
      throw new DubbingValidationError(
        'REMOTE_TASK_FAILED',
        '供应商已确认任务失败，请明确建立新的制作计划；已完成片段仍可保留。',
      );
    if (job.kind === 'speech') {
      if (!params.costAcknowledged)
        throw new DubbingValidationError('COST_ACK_REQUIRED', '重新生成配音需再次确认费用。');
      const input = job.inputSnapshot as unknown as SpeechInput;
      const cue = this.access(false, (repo) => repo.getCue(input.cue.id));
      if (!cue || hash(cue.text) !== hash(input.cue.text))
        throw new DubbingValidationError('STALE_INPUT', '台词已变化，请按当前台词重新制作。');
      return this.generateTake({
        cueId: cue.id,
        expectedRowVersion: cue.rowVersion,
        costAcknowledged: true,
        forceNewTake: true,
      });
    }
    const needsPaidSubmit = steps.some(
      (step) => step.kind === 'lipsync' && step.status !== 'complete' && !step.providerTaskId,
    );
    if (needsPaidSubmit && !params.costAcknowledged)
      throw new DubbingValidationError('COST_ACK_REQUIRED', '重新提交口型任务需再次确认费用。');
    if (needsPaidSubmit)
      throw new DubbingValidationError(
        'ATTEMPT_LIMIT',
        '本次授权只包含一次付费提交，请建立新的制作计划并确认预算。',
      );
    this.access(true, (repo) => {
      for (const step of latest.values()) {
        if (!['failed', 'interrupted'].includes(step.status)) continue;
        const now = new Date().toISOString();
        repo.addStep({
          ...step,
          id: randomUUID(),
          attempt: step.attempt + 1,
          status: 'pending',
          error: undefined,
          errorKind: undefined,
          rowVersion: 1,
          createdAt: now,
          updatedAt: now,
        });
      }
    });
    const pending = this.patchJob(job.id, {
      status: 'pending',
      error: undefined,
      errorKind: undefined,
    });
    this.launch(pending);
    return pending;
  }
  adoptOutput(jobId: string, rowVersion: number) {
    const adopted = this.access(true, (repo, database) => {
      const job = repo.getJob(jobId);
      if (!job || job.status !== 'complete' || !job.outputAssetId)
        throw new DubbingValidationError('OUTPUT_REQUIRED', '成片尚未完整保存。');
      const asset = createRepositories(database).assets.get(job.outputAssetId);
      if (!asset || asset.deletedAt)
        throw new DubbingValidationError('OUTPUT_REQUIRED', '成片已被删除或不可用。');
      resolveDubbingFile(this.capture().root, asset.relativePath);
      return repo.updateJob(jobId, { adoptedAt: new Date().toISOString() }, rowVersion);
    });
    this.revision += 1;
    return adopted;
  }
  assertVideoDeletable(assetId: string, permanent: boolean) {
    const references = this.access(false, (repo) =>
      repo
        .listJobs()
        .filter(
          (job) =>
            job.sourceVideoAssetId === assetId ||
            job.outputAssetId === assetId ||
            job.steps?.some((step) => step.resultAssetId === assetId),
        ),
    );
    if (
      references.some(
        (job) => ACTIVE_STATUSES.has(job.status) || job.status === 'submission_unknown',
      ) ||
      (permanent && references.length)
    )
      throw new DubbingValidationError(
        'VIDEO_REFERENCED',
        '视频仍是配音制作的来源，请保留源视频。',
      );
  }
}
