import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workerDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const validationRoot = await mkdtemp(join(tmpdir(), 'ai-video-dubbing-sidecar-'));
const option = (name) => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  if (!process.argv[index + 1]) throw new Error(`${name} requires a path.`);
  return resolve(process.argv[index + 1]);
};
let executable = option('--worker');
let ffmpegDirectory = option('--ffmpeg');
let child;
let childClosed;
const pending = new Map();
let stderr = '';
let stdout = '';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function requireCondition(value, label) {
  if (!value) throw new Error(label);
}
function rejectPending(error) {
  for (const waiter of pending.values()) waiter.reject(error);
  pending.clear();
}
function request(method, params = {}) {
  const id = randomUUID();
  const message = `${JSON.stringify({ id, protocolVersion: 1, method, params })}\n`;
  if (Buffer.byteLength(message) > 2 * 1024 * 1024)
    throw new Error('Smoke request exceeds the sidecar envelope bound.');
  const response = new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out: ${stderr.slice(-1024)}`));
    }, 30000);
    pending.set(id, {
      resolve: (result) => {
        clearTimeout(timer);
        resolveResult(result);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
  });
  child.stdin.write(message);
  return response.then((result) => {
    if (!result.ok) throw new Error(`${method}: ${result.error?.code} ${result.error?.message}`);
    return result.result;
  });
}
function encode(args) {
  const result = spawnSync(
    join(ffmpegDirectory, 'ffmpeg.exe'),
    ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args],
    { windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024 },
  );
  if (result.error || result.status !== 0)
    throw new Error(
      `FFmpeg smoke fixture failed: ${result.error?.message ?? result.stderr.slice(-1024)}`,
    );
}

async function removeValidationRoot() {
  const cleanupRoot = resolve(validationRoot);
  if (
    !cleanupRoot.startsWith(resolve(tmpdir()) + sep) ||
    !cleanupRoot.includes('ai-video-dubbing-sidecar-')
  )
    throw new Error('Unexpected dubbing validation cleanup path.');
  await rm(cleanupRoot, { recursive: true, force: true, maxRetries: 4, retryDelay: 250 });
}

try {
  if (process.platform !== 'win32') throw new Error('Dubbing sidecar smoke requires Windows.');
  if (!executable) {
    const installation = join(validationRoot, 'installation');
    await mkdir(installation);
    executable = join(installation, 'ai-video-worker.exe');
    await copyFile(
      join(
        workerDirectory,
        '..',
        'desktop',
        'src-tauri',
        'binaries',
        'ai-video-worker-x86_64-pc-windows-msvc.exe',
      ),
      executable,
    );
    ffmpegDirectory = join(installation, 'media', 'ffmpeg');
    await cp(
      join(workerDirectory, '..', 'desktop', 'src-tauri', 'resources', 'ffmpeg'),
      ffmpegDirectory,
      { recursive: true },
    );
  } else {
    ffmpegDirectory ??= join(dirname(executable), 'media', 'ffmpeg');
  }
  const appData = join(validationRoot, 'app-data');
  await mkdir(appData);
  child = spawn(executable, [], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AI_VIDEO_APP_DATA_DIR: appData },
  });
  childClosed = new Promise((resolveResult) => child.once('close', resolveResult));
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) {
      rejectPending(new Error('Sidecar output exceeded its envelope bound.'));
      child.kill();
      return;
    }
    while (stdout.includes('\n')) {
      const boundary = stdout.indexOf('\n');
      const line = stdout.slice(0, boundary);
      stdout = stdout.slice(boundary + 1);
      if (!line) continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        rejectPending(new Error('Sidecar emitted invalid JSON.'));
        child.kill();
        return;
      }
      if (value.kind === 'host.request') {
        // A local compose smoke must never contact a paid provider.
        rejectPending(new Error(`Unexpected native provider request: ${value.method}`));
        child.kill();
        return;
      }
      const waiter = pending.get(value.id);
      if (waiter) {
        pending.delete(value.id);
        waiter.resolve(value);
      }
    }
  });
  child.on('error', (error) => rejectPending(error));
  child.on('exit', (code) =>
    rejectPending(new Error(`Sidecar exited ${code}: ${stderr.slice(-1024)}`)),
  );
  await request('health');
  const engine = await request('dubbing.runtime.get');
  requireCondition(
    engine.available && engine.version?.includes('n8.1.3'),
    'Installed bundled FFmpeg was not resolved.',
  );
  const projectRoot = join(validationRoot, 'project');
  const project = await request('project.create', {
    rootPath: projectRoot,
    name: 'Dubbing packaged smoke',
  });
  requireCondition(
    project.schemaVersion >= 47,
    'Packaged sidecar did not migrate the dubbing schema.',
  );
  const scene = await request('scene.save', { title: '场次配音验证' });
  const character = await request('document.save', {
    kind: 'character',
    title: '固定声音角色',
    contentMarkdown: '# 固定声音角色',
  });
  const setting = await request('document.save', {
    kind: 'scene',
    title: '离线庭院',
    contentMarkdown: '# 离线庭院',
  });
  const structuredPrompt = '司机转身，他没有开口。';
  const bindingProposal = await request('agent.changeSet.create', {
    title: '结构化绑定验证',
    items: [
      {
        entityType: 'scene',
        action: 'update',
        targetId: scene.id,
        expectedRowVersion: scene.rowVersion,
        title: scene.title,
        sceneDocumentId: setting.id,
        videoPrompt: structuredPrompt,
        characterDocumentIds: [character.id],
      },
    ],
  });
  const beforeApproval = (await request('scene.list')).find((item) => item.id === scene.id);
  requireCondition(
    !beforeApproval.videoPrompt && !beforeApproval.characterBindings.length,
    'Proposal changed scene bindings before approval.',
  );
  requireCondition(
    (
      await request('agent.changeSet.apply', {
        changeSetId: bindingProposal.id,
        expectedRowVersion: bindingProposal.rowVersion,
      })
    ).status === 'applied',
    'Structured binding approval failed.',
  );
  const approved = (await request('scene.list')).find((item) => item.id === scene.id);
  requireCondition(
    approved.videoPrompt === structuredPrompt &&
      approved.sceneDocumentId === setting.id &&
      approved.characterBindings[0]?.characterDocumentId === character.id,
    'Structured prompt/scene/cast did not apply together.',
  );
  const cue = await request('dubbing.cue.save', {
    sceneId: scene.id,
    speakerKind: 'character',
    characterDocumentId: character.id,
    text: '离线配音验证。',
    position: 0,
    startMs: 1000,
    lipSync: false,
  });
  const audioInput = join(validationRoot, 'confirmed.wav');
  encode([
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:sample_rate=48000:duration=0.8',
    '-c:a',
    'pcm_s16le',
    audioInput,
  ]);
  const imported = await request('audio.import', {
    sourcePath: audioInput,
    cueId: cue.id,
    expectedRowVersion: cue.rowVersion,
    sceneId: scene.id,
  });
  await request('dubbing.take.adopt', {
    cueId: cue.id,
    takeId: imported.take.id,
    expectedRowVersion: cue.rowVersion,
  });
  const audioSource = await request('audio.mediaSource', { audioId: imported.audio.id });
  requireCondition((await request('audio.list')).length === 1, 'Dedicated audio listing failed.');
  requireCondition(
    audioSource.contentType === 'audio/wav' &&
      hash(await readFile(audioSource.path)) === imported.audio.contentHash,
    'Imported audio source/hash failed.',
  );
  const sample = await request('audio.import', { sourcePath: audioInput, kind: 'reference' });
  const voiceReference = await request('characterVoiceReference.save', {
    characterDocumentId: character.id,
    audioId: sample.audio.id,
    expectedRowVersion: 0,
  });
  const references = await request('characterVoiceReference.list');
  requireCondition(
    references.length === 1 &&
      references[0].versionId === voiceReference.versionId &&
      references[0].characterDocumentId === character.id &&
      references[0].audioId === sample.audio.id &&
      references[0].revision === 1,
    'Role voice reference import/save/list failed through the packaged RPC entrypoint.',
  );
  const currentScene = (await request('scene.list')).find((item) => item.id === scene.id);
  const roleMedia = await request('scene.media.resolve', {
    characterDocumentIds: [character.id],
    voiceVersionIds: [voiceReference.versionId],
  });
  requireCondition(
    roleMedia.characters[0]?.voice?.versionId === voiceReference.versionId &&
      roleMedia.voices[0]?.audioId === sample.audio.id,
    'Scene role media did not resolve a sample imported after binding the character.',
  );
  const disabledPreviewScene = await request('scene.save', {
    title: '独立媒体禁用验证',
    characterBindings: [
      { characterDocumentId: character.id, imageDisabled: true, voiceDisabled: true },
    ],
  });
  requireCondition(
    currentScene?.characterBindings?.some((item) => item.characterDocumentId === character.id),
    'Dialogue speaker was not bound to the scene cast.',
  );
  await request('scene.save', {
    sceneId: scene.id,
    title: scene.title,
    dialogueAudioId: imported.audio.id,
    expectedRowVersion: currentScene.rowVersion,
  });
  await request('project.close');
  const sourceId = randomUUID();
  const sourceRelative = `assets/videos/${sourceId}.mp4`;
  const sourceVideo = join(projectRoot, sourceRelative);
  encode([
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=160x120:r=25:d=4',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=4',
    '-c:v',
    'libopenh264',
    '-b:v',
    '4000000',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    sourceVideo,
  ]);
  const sourceBytes = await readFile(sourceVideo);
  const database = new Database(join(projectRoot, 'project.sqlite'));
  try {
    database.pragma('foreign_keys = ON');
    database
      .prepare(
        'INSERT INTO assets (id,project_id,kind,relative_path,content_hash,size_bytes,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
      )
      .run(
        sourceId,
        project.id,
        'scene-video',
        sourceRelative,
        hash(sourceBytes),
        sourceBytes.length,
        new Date().toISOString(),
        new Date().toISOString(),
      );
  } finally {
    database.close();
  }
  await request('project.open', { rootPath: projectRoot });
  const submitted = await request('dubbing.job.submit', {
    sceneId: scene.id,
    sourceVideoAssetId: sourceId,
    mode: 'compose',
    costAcknowledged: false,
    removeSourceAudioAcknowledged: true,
  });
  let job;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    job = await request('dubbing.job.get', { jobId: submitted.id });
    if (job.status === 'complete') break;
    if (['failed', 'cancelled', 'submission_unknown'].includes(job.status))
      throw new Error(`Packaged composition failed: ${job.errorKind} ${job.error}`);
    await new Promise((resolveResult) => setTimeout(resolveResult, 100));
  }
  requireCondition(
    job?.status === 'complete' && job.outputAssetId,
    'Packaged local compose did not complete.',
  );
  const assets = await request('asset.list');
  requireCondition(
    assets.length === 2 && assets.every((asset) => asset.kind.includes('video')),
    'Dedicated audio entered image/video material assets.',
  );
  const output = assets.find((asset) => asset.id === job.outputAssetId);
  requireCondition(output, 'Composed output was not registered as a new material asset.');
  requireCondition(
    hash(await readFile(join(projectRoot, output.relativePath))) === output.contentHash,
    'Composed output hash failed.',
  );
  requireCondition(
    hash(await readFile(sourceVideo)) === hash(sourceBytes),
    'Source video was overwritten.',
  );
  const taskLog = await request('task.log.list', { kind: 'dubbing', limit: 20 });
  requireCondition(
    taskLog.items.some((item) => item.id === job.id || item.id === `dubbing:${job.id}`),
    'Dubbing job was absent from the task log.',
  );
  await request('dubbing.output.adopt', { jobId: job.id, expectedRowVersion: job.rowVersion });
  const exportRoot = join(validationRoot, 'exported');
  await request('project.export', { destinationRoot: exportRoot });
  await request('project.close');
  await request('project.open', { rootPath: exportRoot });
  const integrity = await request('project.integrity');
  requireCondition(integrity.ok, 'Exported project integrity failed.');
  const exportedReferences = await request('characterVoiceReference.list');
  const exportedPreviewScene = (await request('scene.list')).find(
    (item) => item.id === disabledPreviewScene.id,
  );
  requireCondition(
    exportedPreviewScene?.characterBindings?.[0]?.imageDisabled === true &&
      exportedPreviewScene?.characterBindings?.[0]?.voiceDisabled === true,
    'Exported project lost explicit scene media disabling.',
  );
  requireCondition(
    exportedReferences.length === 1 &&
      exportedReferences[0].versionId === voiceReference.versionId &&
      exportedReferences[0].audioId === sample.audio.id,
    'Exported project lost its role voice reference.',
  );
  const exportedSample = await request('audio.mediaSource', { audioId: sample.audio.id });
  requireCondition(
    hash(await readFile(exportedSample.path)) === sample.audio.contentHash,
    'Exported role voice sample failed playback source/hash verification.',
  );
  const exportedScene = (await request('scene.list')).find((item) => item.id === scene.id);
  requireCondition(
    exportedScene?.dialogueAudioId === imported.audio.id &&
      exportedScene.videoPrompt === structuredPrompt &&
      exportedScene.sceneDocumentId === setting.id &&
      exportedScene.characterBindings?.some((item) => item.characterDocumentId === character.id),
    'Exported scene lost its cast or dialogue binding.',
  );
  const exportedAudio = await request('audio.mediaSource', { audioId: imported.audio.id });
  requireCondition(
    hash(await readFile(exportedAudio.path)) === imported.audio.contentHash,
    'Exported audio failed.',
  );
  requireCondition(
    (await request('dubbing.job.get', { jobId: job.id })).status === 'complete',
    'Exported complete job failed.',
  );
  await request('project.close');
  console.log(
    JSON.stringify(
      {
        validation: 'dubbing-packaged-sidecar',
        bundledFfmpeg: engine.version,
        schemaVersion: integrity.schemaVersion,
        dedicatedAudioStore: true,
        characterVoiceReferenceSavedAndExported: true,
        sceneRoleMediaResolved: true,
        explicitMediaDisabledPersisted: true,
        confirmedAudioAdopted: true,
        localH264Composition: true,
        sourcePreserved: true,
        taskLog: true,
        projectExportAndIntegrity: true,
        sceneCastAndDialoguePreserved: true,
        structuredSceneBindingApplied: true,
        paidRequests: 0,
      },
      null,
      2,
    ),
  );
} finally {
  if (child) {
    child.stdin.end();
    await Promise.race([
      childClosed,
      new Promise((resolveResult) => setTimeout(resolveResult, 3000)),
    ]);
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([
        childClosed,
        new Promise((resolveResult) => setTimeout(resolveResult, 2000)),
      ]);
    }
  }
  await removeValidationRoot();
}
