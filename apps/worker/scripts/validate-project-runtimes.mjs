import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const workerRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const temporaryRoot = resolve(tmpdir());
const root = await mkdtemp(join(temporaryRoot, 'project-runtime-sidecar-'));
const singleProject = process.argv.includes('--single-project');
const executable = join(
  workerRoot,
  '..',
  'desktop',
  'src-tauri',
  'binaries',
  'ai-video-worker-x86_64-pc-windows-msvc.exe',
);
const child = spawn(executable, [], {
  env: {
    ...process.env,
    AI_VIDEO_APP_DATA_DIR: join(root, 'app'),
    AI_VIDEO_TASK_SCHEDULER_ENABLED: singleProject ? '0' : '1',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});
const pending = new Map();
let buffer = '';
let diagnostic = '';
child.stderr.setEncoding('utf8');
child.stderr.on('data', (text) => {
  diagnostic = (diagnostic + text).slice(-8192);
});
child.stdout.setEncoding('utf8');
child.stdout.on('data', (text) => {
  buffer += text;
  while (buffer.includes('\n')) {
    const index = buffer.indexOf('\n');
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const response = JSON.parse(line);
    const waiter = pending.get(response.id);
    if (!waiter) continue;
    clearTimeout(waiter.timer);
    pending.delete(response.id);
    if (response.ok) waiter.resolve(response.result);
    else waiter.reject(new Error(`${response.error?.code}: ${response.error?.message}`));
  }
});
const exited = new Promise((done) => child.once('close', done));
child.once('error', (error) => {
  for (const waiter of pending.values()) waiter.reject(error);
});
function request(method, params = {}, scope) {
  const id = randomUUID();
  return new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Sidecar ${method} timed out. ${diagnostic}`));
    }, 15000);
    pending.set(id, { resolve: resolveResult, reject, timer });
    child.stdin.write(
      `${JSON.stringify({ id, protocolVersion: 1, method, params, ...(scope ? { scope } : {}) })}\n`,
    );
  });
}
const scope = (runtime) => ({
  projectId: runtime.project.id,
  projectSessionId: runtime.projectSessionId,
});
async function cleanupTemporaryProject() {
  const target = resolve(root);
  if (!target.startsWith(temporaryRoot + sep) || !target.includes('project-runtime-sidecar-'))
    throw new Error('Unexpected validation cleanup path.');
  await rm(target, { recursive: true, force: true });
}
try {
  const a = await request('project.create', { rootPath: join(root, 'A'), name: 'A' });
  await request('project.close');
  const b = await request('project.create', { rootPath: join(root, 'B'), name: 'B' });
  await request('project.close');
  const runtimeA = await request('project.runtime.attach', {
    rootPath: a.rootPath,
    expectedProjectId: a.id,
  });
  if (singleProject) {
    await request('project.runtime.activate', scope(runtimeA));
    await request('project.runtime.attach', { rootPath: b.rootPath }).then(
      () => {
        throw new Error('Disabled scheduler accepted a second loaded project.');
      },
      (error) => {
        if (!error.message.includes('capacity')) throw error;
      },
    );
    if ((await request('project.runtime.list')).length !== 1)
      throw new Error('Disabled scheduler did not retain the single-project limit.');
    await request('project.runtime.unload', scope(runtimeA));
    process.stdout.write('Single-project compatibility Sidecar round trip passed.\n');
  } else {
    const runtimeB = await request('project.runtime.attach', {
      rootPath: b.rootPath,
      expectedProjectId: b.id,
    });
    await request('project.runtime.activate', scope(runtimeB));
    await Promise.all([
      request(
        'document.save',
        { kind: 'note', title: 'Only A', contentMarkdown: 'A' },
        scope(runtimeA),
      ),
      request(
        'document.save',
        { kind: 'note', title: 'Only B', contentMarkdown: 'B' },
        scope(runtimeB),
      ),
    ]);
    const docsA = await request('document.list', {}, scope(runtimeA));
    const docsB = await request('document.list', {}, scope(runtimeB));
    if (
      docsA.length !== 1 ||
      docsA[0].title !== 'Only A' ||
      docsB.length !== 1 ||
      docsB[0].title !== 'Only B'
    )
      throw new Error('Sidecar routed documents to the wrong project.');
    await request('project.runtime.unload', scope(runtimeA));
    const reopened = await request('project.runtime.attach', { rootPath: a.rootPath });
    if (reopened.projectSessionId === runtimeA.projectSessionId)
      throw new Error('Runtime epoch was reused.');
    await request('document.list', {}, scope(runtimeA)).then(
      () => {
        throw new Error('Stale runtime was accepted.');
      },
      (error) => {
        if (!error.message.startsWith('STALE_SESSION:')) throw error;
      },
    );
    if ((await request('project.current')).id !== b.id)
      throw new Error('A unload changed B activation.');
    await request('project.runtime.unload', scope(reopened));
    await request('project.runtime.unload', scope(runtimeB));
    process.stdout.write('Multi-project packaged Sidecar round trip passed.\n');
  }
} finally {
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  child.kill();
  await exited;
  await cleanupTemporaryProject();
}
