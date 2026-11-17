import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { productionImagesFromParameters } from '@ai-video/contracts';

function png(red) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, red, 0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Exercise the packaged Worker with an isolated local project; no provider is configured.
const workerRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryRoot = resolve(tmpdir());
const root = await mkdtemp(join(temporaryRoot, 'shot-workspace-sidecar-'));
// Match the installed layout so real local image import can use bundled FFmpeg.
const installation = join(root, 'installation');
await mkdir(installation);
await Promise.all([
  cp(
    resolve(workerRoot, '../desktop/src-tauri/binaries/ai-video-worker-x86_64-pc-windows-msvc.exe'),
    join(installation, 'ai-video-worker.exe'),
  ),
  cp(
    resolve(workerRoot, '../desktop/src-tauri/resources/ffmpeg'),
    join(installation, 'media/ffmpeg'),
    { recursive: true },
  ),
]);
const child = spawn(join(installation, 'ai-video-worker.exe'), [], {
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, AI_VIDEO_APP_DATA_DIR: join(root, 'app-data') },
});
const exited = once(child, 'exit');
const pending = new Map();
let buffer = '',
  stderr = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderr = (stderr + chunk).slice(-10000);
});
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const newline = buffer.indexOf('\n');
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    assert.notEqual(message.kind, 'host.request', 'Local validation must not contact a provider');
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  }
});
function rpc(method, params = {}, scope) {
  const id = randomUUID();
  return new Promise((resolveResult, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out: ${stderr}`));
    }, 15000);
    pending.set(id, (response) => {
      clearTimeout(timeout);
      if (response.ok) resolveResult(response.result);
      else reject(new Error(`${method}: ${response.error?.message}`));
    });
    child.stdin.write(
      `${JSON.stringify({ id, protocolVersion: 1, method, params, ...(scope ? { scope } : {}) })}\n`,
    );
  });
}
try {
  const rootPath = join(root, 'project');
  const runtime = await rpc('project.runtime.create', { rootPath, name: '镜头双正文隔离验收' });
  let scope = { projectId: runtime.project.id, projectSessionId: runtime.projectSessionId };
  assert.equal(runtime.project.schemaVersion, 80);
  const scene = await rpc('scene.save', { title: '首场' }, scope);
  const shot = await rpc(
    'shot.save',
    { sceneId: scene.id, title: '首镜', prompt: '视频从门边走到窗前。' },
    scope,
  );
  const character = await rpc(
    'document.save',
    { kind: 'character', title: '人物', contentMarkdown: '人物资料' },
    scope,
  );
  const setting = await rpc(
    'document.save',
    { kind: 'scene', title: '场景', contentMarkdown: '场景资料' },
    scope,
  );
  const imported = [];
  for (const [index, document] of [character, setting].entries()) {
    const sourcePath = join(root, `reference-${index}.png`);
    await writeFile(sourcePath, png(index * 255));
    const [asset] = await rpc(
      'document.images.import',
      { documentId: document.id, sourcePaths: [sourcePath] },
      scope,
    );
    imported.push(asset);
  }
  await rpc(
    'shot.save',
    {
      shotId: shot.id,
      sceneId: scene.id,
      title: shot.title,
      expectedRowVersion: shot.rowVersion,
      bindings: {
        schemaVersion: 1,
        characterDocumentIds: [character.id],
        sceneDocumentIds: [setting.id],
      },
    },
    scope,
  );
  await rpc(
    'shot.references.save',
    {
      shotId: shot.id,
      referenceBindings: {
        characterBindings: [{ characterDocumentId: character.id, assetId: imported[0].id }],
        sceneBindings: [{ sourceDocumentId: setting.id, assetId: imported[1].id }],
      },
    },
    scope,
  );
  const original = await rpc('shot.image.get', { shotId: shot.id }, scope);
  assert.equal(original.prompt, '');
  assert.deepEqual(
    original.inputImages.map((image) => image.assetId).sort(),
    imported.map((image) => image.id).sort(),
  );
  assert.equal(original.videoImages.selections, undefined);
  const save = {
    shotId: shot.id,
    expectedRowVersion: original.rowVersion,
    sourceToken: original.currentSourceToken,
    prompt: '静态定格在门边抬眼的一瞬。',
    purpose: 'composition',
    intent: '',
    bindings: {
      schemaVersion: 1,
      characterDocumentIds: [],
      sceneDocumentIds: [],
      propDocumentIds: [],
    },
  };
  const saved = await rpc('shot.image.save', save, scope);
  assert.equal(saved.stale, false);
  assert.deepEqual(saved.inputImages, []);
  await assert.rejects(
    rpc('shot.image.save', { ...save, sourceToken: saved.currentSourceToken }, scope),
    /已更新/,
  );
  assert.equal(
    (await rpc('shot.prompt.preview', { shotId: shot.id, kind: 'image' }, scope)).prompt,
    save.prompt,
  );
  const videoPreview = await rpc('shot.prompt.preview', { shotId: shot.id, kind: 'video' }, scope);
  assert.deepEqual(
    videoPreview.inputImages.map((image) => image.assetId).sort(),
    imported.map((image) => image.id).sort(),
  );
  assert(videoPreview.prompt.includes('本段传入2张参考图'));
  const catalog = await rpc('adapter.catalog');
  const adapter = catalog.adapters.find(
    (item) => item.capability === 'REFERENCE_TO_VIDEO' && item.parameterSchema.properties.content,
  );
  assert(adapter);
  const compiled = await rpc(
    'production.compile',
    { target: { kind: 'shot', id: shot.id }, adapterKey: adapter.key },
    scope,
  );
  assert.deepEqual(
    productionImagesFromParameters(adapter, compiled.parameters)
      .map((image) => image.url)
      .sort(),
    imported.map((image) => `project-asset://${image.id}`).sort(),
  );
  await rpc(
    'shot.videoImages.save',
    { shotId: shot.id, expectedRowVersion: 0, selections: [] },
    scope,
  );
  await rpc('project.runtime.unload', scope);
  const reopened = await rpc('project.runtime.attach', { rootPath });
  scope = { projectId: reopened.project.id, projectSessionId: reopened.projectSessionId };
  const restored = await rpc('shot.image.get', { shotId: shot.id }, scope);
  assert.equal(restored.prompt, save.prompt);
  assert.deepEqual(restored.videoImages.selections, []);
  assert.equal(
    (await rpc('shot.prompt.preview', { shotId: shot.id, kind: 'video' }, scope)).prompt,
    shot.prompt,
  );
  assert.equal((await rpc('project.integrity', {}, scope)).ok, true);
  await rpc('project.runtime.unload', scope);
  console.log(
    JSON.stringify({
      schemaVersion: 80,
      independentPrompts: true,
      cas: true,
      explicitEmptyImages: true,
      boundCharacterAndSceneImages: true,
      reopen: true,
      integrity: true,
      providerCalls: 0,
    }),
  );
} finally {
  child.kill();
  await exited;
  assert(root.startsWith(`${temporaryRoot}${sep}`));
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
