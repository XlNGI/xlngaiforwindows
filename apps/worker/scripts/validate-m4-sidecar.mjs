import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile } from 'node:fs/promises';
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
const projectRoot = await mkdtemp(join(tmpdir(), 'ai-video-m4-sidecar-'));
const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
let stdoutBuffer = '';
let stderr = '';

child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderr += chunk;
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
    waiter.reject(new Error(`Sidecar exited with code ${code}: ${stderr.trim()}`));
  }
  pending.clear();
});

function request(method, params = {}) {
  const id = randomUUID();
  const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  child.stdin.write(`${JSON.stringify({ id, protocolVersion: 1, method, params })}\n`);
  return response;
}

function requireOk(response, label) {
  if (!response.ok) throw new Error(`${label}: ${response.error?.code} ${response.error?.message}`);
  return response.result;
}

try {
  const project = requireOk(
    await request('project.create', { name: 'M4 Sidecar Validation', rootPath: projectRoot }),
    'project.create',
  );
  const scene = requireOk(await request('scene.save', { title: 'M4 Scene' }), 'scene.save');
  const shot = requireOk(
    await request('shot.save', { sceneId: scene.id, title: 'M4 Shot' }),
    'shot.save',
  );
  const catalog = requireOk(await request('adapter.catalog'), 'adapter.catalog');
  const adapter = requireOk(
    await request('adapter.resolve', {
      capability: 'TEXT_TO_IMAGE',
      provider: 'vidu',
      model: 'viduq2',
    }),
    'adapter.resolve',
  );
  const dramaAdapter = requireOk(
    await request('adapter.resolve', {
      capability: 'REFERENCE_TO_VIDEO',
      provider: 'vidu',
      model: 'viduq3-drama',
      apiVersion: 'v2',
    }),
    'adapter.resolve Q3-Drama',
  );
  if (dramaAdapter.modelLabel !== 'Vidu Q3-Drama') {
    throw new Error('Q3-Drama model label does not match the official product name');
  }
  const dramaParameters = {
    images: ['https://example.com/reference.png'],
    prompt: 'Dialogue scene',
    duration: 8,
    aspect_ratio: '16:9',
    resolution: '1080p',
    audio: true,
  };
  const dramaValid = requireOk(
    await request('adapter.validate', {
      adapterKey: dramaAdapter.key,
      parameters: dramaParameters,
    }),
    'adapter.validate Q3-Drama',
  );
  const dramaInvalid = requireOk(
    await request('adapter.validate', {
      adapterKey: dramaAdapter.key,
      parameters: { ...dramaParameters, duration: 16 },
    }),
    'adapter.validate Q3-Drama duration',
  );
  if (!dramaValid.valid || dramaInvalid.valid) {
    throw new Error('Q3-Drama parameter limits are not enforced');
  }
  const combination = requireOk(
    await request('adapter.validate', {
      adapterKey: 'IMAGE_TO_VIDEO:vidu:vidu2.0:v2',
      parameters: {
        images: ['https://example.com/start.png'],
        duration: 8,
        resolution: '1080p',
        movement_amplitude: 'auto',
      },
    }),
    'adapter.validate',
  );
  if (combination.valid) throw new Error('Invalid duration/resolution combination was accepted');

  const secretMarker = 'M4_SECRET_MUST_NOT_PERSIST';
  const rejected = await request('generation.draft.save', {
    shotId: shot.id,
    adapterKey: adapter.key,
    parameters: {
      prompt: 'Frame',
      aspect_ratio: '16:9',
      resolution: '2K',
      apiKey: secretMarker,
    },
  });
  if (rejected.ok || rejected.error?.code !== 'INVALID_PARAMETERS') {
    throw new Error('Credential-like parameter was not rejected');
  }

  const parameters = { prompt: 'Frame', aspect_ratio: '16:9', resolution: '2K' };
  requireOk(
    await request('generation.draft.save', {
      shotId: shot.id,
      adapterKey: adapter.key,
      parameters,
    }),
    'generation.draft.save',
  );
  const loaded = requireOk(
    await request('generation.draft.get', { shotId: shot.id, adapterKey: adapter.key }),
    'generation.draft.get',
  );
  if (JSON.stringify(loaded.parameters) !== JSON.stringify(parameters)) {
    throw new Error('Persisted draft does not match the saved parameters');
  }
  requireOk(await request('project.close'), 'project.close');

  const database = await readFile(join(projectRoot, 'project.sqlite'));
  if (database.includes(Buffer.from(secretMarker))) {
    throw new Error('Credential-like value was found in project.sqlite');
  }

  console.log(
    JSON.stringify(
      {
        projectId: project.id,
        projectRoot,
        adapterCount: catalog.adapters.length,
        resolvedAdapter: adapter.key,
        resolvedDramaAdapter: dramaAdapter.key,
        q3DramaLimitsVerified: true,
        invalidCombinationRejected: true,
        credentialExcludedFromDatabase: true,
        draftRoundTrip: true,
      },
      null,
      2,
    ),
  );
} finally {
  child.stdin.end();
}
