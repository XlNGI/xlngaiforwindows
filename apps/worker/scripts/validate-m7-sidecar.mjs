import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workerDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const executable = join(
  workerDirectory,
  '..',
  'desktop',
  'src-tauri',
  'binaries',
  'ai-video-worker-x86_64-pc-windows-msvc.exe',
);
const validationRoot = await mkdtemp(join(tmpdir(), 'ai-video-m7-sidecar-'));
const projectRoot = join(validationRoot, 'sample-project');
const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let stdoutBuffer = '';
let stderrTail = '';

child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderrTail = (stderrTail + chunk).slice(-16 * 1024);
});
child.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk;
  while (stdoutBuffer.includes('\n')) {
    const newline = stdoutBuffer.indexOf('\n');
    const line = stdoutBuffer.slice(0, newline);
    stdoutBuffer = stdoutBuffer.slice(newline + 1);
    if (!line) continue;
    const response = JSON.parse(line);
    const waiter = pending.get(response.id);
    if (waiter) {
      pending.delete(response.id);
      waiter.resolve(response);
    }
  }
});
child.on('exit', (code) => {
  for (const waiter of pending.values()) {
    waiter.reject(new Error(`Sidecar exited with code ${code}: ${stderrTail.trim()}`));
  }
  pending.clear();
});

function waitForResponse(id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for Sidecar response ${id}: ${stderrTail.trim()}`));
    }, 10_000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
  });
}

function request(method, params = {}) {
  const id = randomUUID();
  const response = waitForResponse(id);
  child.stdin.write(`${JSON.stringify({ id, protocolVersion: 1, method, params })}\n`);
  return response;
}

function malformedRequest() {
  const response = waitForResponse('unknown');
  child.stdin.write('{not-valid-json}\n');
  return response;
}

function requireOk(response, label) {
  if (!response.ok) throw new Error(`${label}: ${response.error?.code} ${response.error?.message}`);
  return response.result;
}

try {
  const malformed = await malformedRequest();
  if (malformed.ok || malformed.error?.code !== 'INVALID_REQUEST') {
    throw new Error('Malformed JSON did not produce a bounded protocol error');
  }
  requireOk(await request('health'), 'health after malformed JSON');
  const project = requireOk(
    await request('project.createSample', { rootPath: projectRoot, name: 'M7 Sample' }),
    'project.createSample',
  );
  const documents = requireOk(await request('document.list'), 'document.list');
  if (documents.length !== 5) throw new Error('Sample project did not contain five documents');

  await writeFile(join(projectRoot, 'cache', 'validation.bin'), Buffer.alloc(4_096));
  const cacheBefore = requireOk(await request('maintenance.cache.inspect'), 'cache.inspect');
  if (cacheBefore.fileCount !== 1 || cacheBefore.sizeBytes !== 4_096) {
    throw new Error('Cache inspection returned an unexpected summary');
  }
  const cleared = requireOk(await request('maintenance.cache.clear'), 'cache.clear');
  if (cleared.removedFiles !== 1 || cleared.freedBytes !== 4_096) {
    throw new Error('Cache cleanup returned an unexpected summary');
  }

  await malformedRequest();
  const diagnostics = requireOk(
    await request('maintenance.diagnostics.export'),
    'diagnostics.export',
  );
  const manifest = await readFile(join(diagnostics.path, 'manifest.json'), 'utf8');
  const report = await readFile(join(diagnostics.path, 'report.json'), 'utf8');
  const packageText = `${manifest}\n${report}`;
  for (const forbidden of [
    projectRoot,
    'authorization:',
    'bearer ',
    'api_key',
    'data:image',
    'https://',
  ]) {
    if (packageText.toLowerCase().includes(forbidden.toLowerCase())) {
      throw new Error(`Diagnostic package contains forbidden content: ${forbidden}`);
    }
  }
  const integrity = requireOk(await request('project.integrity'), 'project.integrity');
  if (!integrity.ok) throw new Error(`Sample project integrity failed: ${integrity.messages}`);
  requireOk(await request('project.close'), 'project.close');

  console.log(
    JSON.stringify(
      {
        projectId: project.id,
        malformedJsonRecovery: true,
        offlineSampleProject: true,
        sampleDocumentCount: documents.length,
        cacheBoundaryVerified: true,
        diagnosticPackageFiles: diagnostics.fileCount,
        diagnosticRedactionVerified: true,
        integrityVerified: true,
      },
      null,
      2,
    ),
  );
} finally {
  child.stdin.end();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode === null) child.kill();
  await rm(validationRoot, { recursive: true, force: true });
}
