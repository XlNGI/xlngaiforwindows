import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRepositories, openProjectDatabase } from '@ai-video/persistence';

const workerRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryRoot = resolve(tmpdir());
const root = await mkdtemp(join(temporaryRoot, 'worker-restart-check-'));
async function cleanup() {
  if (!resolve(root).startsWith(temporaryRoot + sep) || !root.includes('worker-restart-check-'))
    throw new Error('Unexpected validation cleanup path.');
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
const source = process.argv.includes('--source');
const expectTimeout = process.argv.includes('--expect-preview-timeout');
let worker;
function start() {
  const executable = source
    ? process.execPath
    : join(workerRoot, '../desktop/src-tauri/binaries/ai-video-worker-x86_64-pc-windows-msvc.exe');
  const child = spawn(executable, source ? [join(workerRoot, 'dist/index.js')] : [], {
    env: { ...process.env, AI_VIDEO_APP_DATA_DIR: join(root, 'settings') },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const pending = new Map();
  let buffer = '';
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-8192);
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    while (buffer.includes('\n')) {
      const end = buffer.indexOf('\n');
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      const response = JSON.parse(line);
      if (response.kind === 'host.request')
        throw new Error('Unexpected external Provider request.');
      const waiter = pending.get(response.id);
      if (!waiter) continue;
      clearTimeout(waiter.timer);
      pending.delete(response.id);
      waiter.resolve(response);
    }
  });
  const closed = new Promise((done) => child.once('close', done));
  child.on('error', (error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  });
  return {
    request(method, params = {}, scope, timeoutMs = 10000) {
      const id = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`No response: ${method}; ${stderr}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(
          JSON.stringify({ id, protocolVersion: 1, method, params, ...(scope ? { scope } : {}) }) +
            '\n',
        );
      });
    },
    async stop() {
      for (const waiter of pending.values()) clearTimeout(waiter.timer);
      child.kill();
      await closed;
    },
  };
}
function ok(response) {
  assert.equal(response.ok, true, response.error?.message);
  return response.result;
}
const scope = (runtime) => ({
  projectId: runtime.project.id,
  projectSessionId: runtime.projectSessionId,
});
try {
  worker = start();
  const created = ok(
    await worker.request('project.runtime.create', {
      rootPath: join(root, 'project'),
      name: 'Restart verification',
    }),
  );
  await worker.request('project.runtime.unload', scope(created));
  const bytes = Buffer.alloc(6 * 1024 * 1024);
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+Xn6pAAAAAElFTkSuQmCC',
    'base64',
  ).copy(bytes);
  await mkdir(join(root, 'project/assets/images'), { recursive: true });
  await writeFile(join(root, 'project/assets/images/large.png'), bytes);
  const database = openProjectDatabase(join(root, 'project/project.sqlite'));
  try {
    createRepositories(database).assets.save({
      id: 'large-reference',
      projectId: created.project.id,
      kind: 'generated-image',
      relativePath: 'assets/images/large.png',
      sizeBytes: bytes.length,
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      createdAt: new Date().toISOString(),
    });
  } finally {
    database.close();
  }
  const before = ok(
    await worker.request('project.runtime.attach', {
      rootPath: created.project.rootPath,
      expectedProjectId: created.project.id,
    }),
  );
  const healthBefore = ok(await worker.request('health'));
  const began = performance.now();
  if (expectTimeout) {
    await assert.rejects(
      worker.request('asset.preview', { assetId: 'large-reference' }, scope(before), 1500),
      /No response/,
    );
    console.log('REPRODUCED: 6 MiB asset.preview produced no IPC reply.');
  } else {
    const preview = await worker.request(
      'asset.preview',
      { assetId: 'large-reference' },
      scope(before),
    );
    assert.equal(preview.ok, false);
    assert.match(preview.error.message, /2 MiB/);
    console.log(
      `PASS: oversized preview returned a correlated error in ${Math.round(performance.now() - began)} ms.`,
    );
  }
  assert.equal(ok(await worker.request('health')).pid, healthBefore.pid);
  assert.deepEqual(ok(await worker.request('document.list', {}, scope(before))), []);
  await worker.stop();
  worker = start();
  const stale = await worker.request(
    'document.save',
    { kind: 'note', title: 'Do not replay', contentMarkdown: 'not accepted' },
    scope(before),
  );
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'STALE_SESSION');
  assert.match(stale.error.message, /Project runtime scope is stale or unavailable/);
  console.log('REPRODUCED: a real Worker process restart rejects the previous runtime scope.');
  const after = ok(
    await worker.request('project.runtime.attach', {
      rootPath: created.project.rootPath,
      expectedProjectId: created.project.id,
    }),
  );
  assert.notEqual(after.projectSessionId, before.projectSessionId);
  assert.deepEqual(ok(await worker.request('document.list', {}, scope(after))), []);
  const saved = ok(
    await worker.request(
      'document.save',
      { kind: 'note', title: 'Explicit new action', contentMarkdown: 'accepted' },
      scope(after),
    ),
  );
  assert.equal(saved.title, 'Explicit new action');
  const documents = ok(await worker.request('document.list', {}, scope(after)));
  assert.equal(documents.length, 1);
  console.log(
    'PASS: reattach obtains a new epoch; reads and explicit writes succeed, rejected writes were not replayed.',
  );
  if (process.argv.includes('--browser')) {
    const { verifyWorkerRestartBrowser } = await import('./verify-worker-restart-browser.mjs');
    await verifyWorkerRestartBrowser({
      root,
      workerRoot,
      project: after.project,
      request: (...args) => worker.request(...args),
      restart: async () => {
        await worker.stop();
        worker = start();
      },
    });
  }
  for (const runtime of ok(await worker.request('project.runtime.list')))
    await worker.request('project.runtime.unload', scope(runtime));
} finally {
  await worker?.stop();
  await cleanup();
}
