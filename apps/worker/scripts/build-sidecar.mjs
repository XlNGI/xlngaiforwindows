import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const workerDirectory = dirname(dirname(fileURLToPath(import.meta.url)));
const sidecarDirectory = join(workerDirectory, 'dist-sidecar');
const sqliteDirectory = dirname(require.resolve('better-sqlite3/package.json'));
const sqliteBinding = join(sqliteDirectory, 'build', 'Release', 'better_sqlite3.node');
const developmentBindingBackup = join(sidecarDirectory, 'better_sqlite3.development.node');
const prebuildInstall = join(dirname(require.resolve('prebuild-install/package.json')), 'bin.js');
const esbuild = join(dirname(require.resolve('esbuild/package.json')), 'bin', 'esbuild');
const pkg = join(dirname(require.resolve('@yao-pkg/pkg/package.json')), 'lib-es5', 'bin.js');
const output = join(
  workerDirectory,
  '..',
  'desktop',
  'src-tauri',
  'binaries',
  'ai-video-worker-x86_64-pc-windows-msvc.exe',
);

function run(script, args, cwd = workerDirectory) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  if (result.error) throw result.error;
  if (process.exitCode) throw new Error(`${script} failed with exit code ${process.exitCode}.`);
}

mkdirSync(sidecarDirectory, { recursive: true });
copyFileSync(sqliteBinding, developmentBindingBackup);

try {
  run(
    prebuildInstall,
    ['--target', '22.23.2', '--runtime', 'node', '--platform', 'win32', '--arch', 'x64', '--force'],
    sqliteDirectory,
  );
  run(esbuild, [
    'src/index.ts',
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--target=node22',
    '--outfile=dist-sidecar/index.cjs',
    '--external:better-sqlite3',
  ]);
  run(pkg, ['dist-sidecar/index.cjs', '--target', 'node22-win-x64', '--output', output]);
} finally {
  copyFileSync(developmentBindingBackup, sqliteBinding);
  rmSync(developmentBindingBackup, { force: true });
}
