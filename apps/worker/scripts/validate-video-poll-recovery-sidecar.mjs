import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProjectService } from '../dist/project-service.js';
import { VideoGenerationService } from '../dist/video-generation-service.js';

// Offline Native host: the packaged Worker must only query the existing remote ID.
const temporaryRoot = resolve(tmpdir());
const root = await mkdtemp(join(temporaryRoot, 'video-poll-recovery-'));
const rootPath = join(root, 'project');
const projects = new ProjectService({ recentProjectsPath: join(root, 'recent.json') });
projects.create(rootPath, '视频原任务恢复查询验收');
const videos = new VideoGenerationService(projects);
const prepared = videos.prepare({
  adapterKey: 'TEXT_TO_VIDEO:unicompapi:kling-v3-turbo:v1',
  parameters: { prompt: 'fixture', duration: 5, ratio: '16:9' },
  providerRegion: 'unicompapi',
  providerProfileId: '11111111-1111-4111-8111-111111111111',
  modelId: 'kling-v3-turbo',
});
const original = videos.attachTask({
  jobId: prepared.id,
  providerTaskId: `accepted-${randomUUID()}`,
});
videos.fail({
  jobId: original.id,
  failureKind: 'transport',
  message: 'Native Provider error is invalid.',
});
projects.close();
const nativeDirectory = join(temporaryRoot, 'ai-video-workspace-unicompapi');
await mkdir(nativeDirectory, { recursive: true });
const nativePath = join(nativeDirectory, `recovery-fixture-${randomUUID()}.mp4`);
await writeFile(nativePath, Buffer.from('000000106674797069736f6d00000000', 'hex'));
const workerRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const child = spawn(
  resolve(workerRoot, '../desktop/src-tauri/binaries/ai-video-worker-x86_64-pc-windows-msvc.exe'),
  [],
  {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AI_VIDEO_APP_DATA_DIR: join(root, 'app-data') },
  },
);
const exited = once(child, 'exit');
const pending = new Map();
let buffer = '',
  stderr = '',
  polls = 0,
  hostFailure;
const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderr = (stderr + chunk).slice(-10000);
});
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const end = buffer.indexOf('\n');
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (message.kind === 'host.request') {
      try {
        assert.equal(
          message.method,
          'provider.media.poll',
          'Recovery must never submit generation',
        );
        assert.equal(message.params.providerTaskId, original.providerTaskId);
        polls++;
        send({
          kind: 'host.response',
          requestId: message.requestId,
          ok: true,
          result: {
            providerStatus: 200,
            state: 'succeeded',
            providerState: 'completed',
            output: { type: 'native_temporary_file', path: nativePath, contentType: 'video/mp4' },
          },
        });
      } catch (error) {
        hostFailure = error;
        send({
          kind: 'host.response',
          requestId: message.requestId,
          ok: false,
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Offline fixture rejected an unexpected operation',
            retryable: false,
          },
        });
      }
    } else {
      const response = message.kind === 'worker.response' ? message.payload : message;
      pending.get(response.id)?.(response);
      pending.delete(response.id);
    }
  }
});
function rpc(method, params = {}, scope) {
  const id = randomUUID();
  return new Promise((resolveResult, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out: ${stderr}`));
    }, 15000);
    pending.set(id, (response) => {
      clearTimeout(timer);
      if (response.ok) resolveResult(response.result);
      else reject(new Error(`${method}: ${response.error?.message}`));
    });
    send({ id, protocolVersion: 1, method, params, ...(scope ? { scope } : {}) });
  });
}
try {
  let runtime = await rpc('project.runtime.attach', { rootPath });
  let scope = { projectId: runtime.project.id, projectSessionId: runtime.projectSessionId };
  const recovered = await rpc('video.generate.resume', { jobId: original.id }, scope);
  assert.notEqual(recovered.id, original.id);
  assert.equal(recovered.providerTaskId, original.providerTaskId);
  assert.equal(recovered.metadata.pollRecoveryOfJobId, original.id);
  let completed;
  const deadline = Date.now() + 15000;
  do {
    completed = await rpc('video.generate.get', { jobId: recovered.id }, scope);
    if (completed.status === 'succeeded') break;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  } while (Date.now() < deadline);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.results.length, 1);
  assert.equal((await rpc('video.generate.get', { jobId: original.id }, scope)).status, 'failed');
  assert.equal(
    (await rpc('video.generate.resume', { jobId: original.id }, scope)).id,
    recovered.id,
  );
  await rpc('project.runtime.unload', scope);
  runtime = await rpc('project.runtime.attach', { rootPath });
  scope = { projectId: runtime.project.id, projectSessionId: runtime.projectSessionId };
  assert.equal(
    (await rpc('video.generate.resume', { jobId: original.id }, scope)).id,
    recovered.id,
  );
  assert.equal((await rpc('video.generate.list', {}, scope)).length, 2);
  assert.equal((await rpc('asset.list', {}, scope)).length, 1);
  assert.equal((await rpc('project.integrity', {}, scope)).ok, true);
  assert.equal(polls, 1);
  assert.equal(hostFailure, undefined);
  await rpc('project.runtime.unload', scope);
  console.log(
    JSON.stringify({
      originalTaskPreserved: true,
      queryOnly: true,
      polls,
      paidSubmissions: 0,
      assets: 1,
      repeatClickAndReopenIdempotent: true,
      integrity: true,
      realProviderRequests: 0,
    }),
  );
} finally {
  child.kill();
  await exited;
  assert(root.startsWith(`${temporaryRoot}${sep}`));
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
  await rm(nativePath, { force: true });
}
