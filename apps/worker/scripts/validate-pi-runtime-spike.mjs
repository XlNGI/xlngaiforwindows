import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const workerDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const esbuild = join(dirname(require.resolve('esbuild/package.json')), 'bin', 'esbuild');
const pkg = join(dirname(require.resolve('@yao-pkg/pkg/package.json')), 'lib-es5', 'bin.js');
const temporaryRoot = realpathSync(tmpdir());
const buildDirectory = mkdtempSync(join(temporaryRoot, 'ai-video-pi-runtime-spike-'));
const bundlePath = join(buildDirectory, 'pi-runtime-spike.cjs');
const executablePath = join(buildDirectory, 'pi-runtime-spike.exe');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertSafeTemporaryDirectory(directory) {
  const resolvedDirectory = resolve(directory);
  const pathFromTemporaryRoot = relative(temporaryRoot, resolvedDirectory);
  assert(
    pathFromTemporaryRoot.length > 0 &&
      !pathFromTemporaryRoot.startsWith('..') &&
      !isAbsolute(pathFromTemporaryRoot),
    `Refusing to clean an unsafe Spike directory: ${resolvedDirectory}`,
  );
}

function runNodeTool(label, script, args, timeoutMs) {
  const startedAt = performance.now();
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: workerDirectory,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    timeout: timeoutMs,
    windowsHide: true,
  });
  const durationMs = performance.now() - startedAt;
  if (result.error || result.status !== 0) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw result.error ?? new Error(`${label} failed with exit code ${String(result.status)}`);
  }
  return { durationMs, stdout: result.stdout, stderr: result.stderr };
}

function readInstalledPackageVersion(packageName) {
  const entry = fileURLToPath(import.meta.resolve(packageName));
  const manifestPath = join(dirname(dirname(entry)), 'package.json');
  return JSON.parse(readFileSync(manifestPath, 'utf8')).version;
}

function createCredentialFreeEnvironment() {
  const allowedKeys = [
    'COMSPEC',
    'NUMBER_OF_PROCESSORS',
    'OS',
    'PATH',
    'PATHEXT',
    'PROCESSOR_ARCHITECTURE',
    'SystemDrive',
    'SystemRoot',
    'TEMP',
    'TMP',
    'WINDIR',
  ];
  const environment = { NO_COLOR: '1', PI_RUNTIME_SPIKE: 'isolated' };
  for (const key of allowedKeys) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
}

try {
  const dependencyVersions = {
    '@earendil-works/pi-agent-core': readInstalledPackageVersion('@earendil-works/pi-agent-core'),
    '@earendil-works/pi-ai': readInstalledPackageVersion('@earendil-works/pi-ai'),
  };
  assert(
    dependencyVersions['@earendil-works/pi-agent-core'] === '0.84.3' &&
      dependencyVersions['@earendil-works/pi-ai'] === '0.84.3',
    `Unexpected Pi dependency versions: ${JSON.stringify(dependencyVersions)}`,
  );

  const bundle = runNodeTool(
    'esbuild',
    esbuild,
    [
      'src/experiments/pi-runtime-spike-entry.ts',
      '--bundle',
      '--platform=node',
      '--format=cjs',
      '--target=node22',
      `--outfile=${bundlePath}`,
      '--log-level=warning',
    ],
    60_000,
  );
  const packaged = runNodeTool(
    'pkg',
    pkg,
    [bundlePath, '--target', 'node22-win-x64', '--output', executablePath],
    300_000,
  );

  const executionStartedAt = performance.now();
  const execution = spawnSync(executablePath, [], {
    cwd: buildDirectory,
    encoding: 'utf8',
    env: createCredentialFreeEnvironment(),
    maxBuffer: 20 * 1024 * 1024,
    timeout: 60_000,
    windowsHide: true,
  });
  const processDurationMs = performance.now() - executionStartedAt;
  if (execution.error || execution.status !== 0) {
    if (execution.stdout) process.stdout.write(execution.stdout);
    if (execution.stderr) process.stderr.write(execution.stderr);
    throw (
      execution.error ??
      new Error(`Spike executable failed with exit code ${String(execution.status)}`)
    );
  }

  const outputLines = execution.stdout.trim().split(/\r?\n/u);
  const spikeReport = JSON.parse(outputLines.at(-1));
  assert(spikeReport.ok === true, `Spike executable returned failure: ${execution.stdout}`);
  assert(spikeReport.piVersion === '0.84.3', 'Spike executable reported the wrong Pi version');
  assert(spikeReport.provider === 'faux', 'Spike executable did not use the faux provider');
  assert(spikeReport.nodeVersion.startsWith('v22.'), 'Spike executable did not run on Node 22');
  assert(spikeReport.networkAttempts === 0, 'Spike executable attempted network access');
  assert(spikeReport.credentialPayloads === 0, 'Spike executable received credential material');
  assert(
    spikeReport.checks.length === 12,
    'Spike executable did not complete every capability check',
  );

  const validationReport = {
    ok: true,
    target: 'node22-win-x64',
    dependencyVersions,
    bundleBytes: statSync(bundlePath).size,
    executableBytes: statSync(executablePath).size,
    bundleBuildMs: bundle.durationMs,
    packageBuildMs: packaged.durationMs,
    processDurationMs,
    startupOverheadApproxMs: Math.max(0, processDurationMs - spikeReport.durationMs),
    runtime: spikeReport,
  };
  process.stdout.write(`${JSON.stringify(validationReport, null, 2)}\n`);
} finally {
  assertSafeTemporaryDirectory(buildDirectory);
  rmSync(buildDirectory, { recursive: true, force: true });
}
