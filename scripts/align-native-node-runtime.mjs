import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptsDirectory);
const workspaceRequire = createRequire(join(repositoryRoot, 'packages/persistence/package.json'));
const betterSqlitePackage = workspaceRequire.resolve('better-sqlite3/package.json');
const betterSqliteDirectory = dirname(betterSqlitePackage);
const prebuildInstall = workspaceRequire.resolve('prebuild-install/bin.js', {
  paths: [betterSqliteDirectory],
});

const result = spawnSync(process.execPath, [prebuildInstall, '--verbose'], {
  cwd: betterSqliteDirectory,
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
