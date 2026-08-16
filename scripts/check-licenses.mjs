import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const projects = JSON.parse(
  execSync('pnpm list --depth 0 --json', { cwd: root, encoding: 'utf8' }),
);

const missing = [];
const seen = new Set();

function inspectDependency(name, info) {
  if (!info?.path || info.version?.startsWith('link:')) return;
  const key = `${name}@${info.version}`;
  if (seen.has(key)) return;
  seen.add(key);
  let license;
  try {
    const manifest = JSON.parse(readFileSync(join(info.path, 'package.json'), 'utf8'));
    license =
      manifest.license ??
      (Array.isArray(manifest.licenses) ? manifest.licenses.join(', ') : undefined);
  } catch {
    license = undefined;
  }
  if (!license || license === 'UNLICENSED')
    missing.push({ name, version: info.version, path: info.path });
}

for (const project of projects) {
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    for (const [name, info] of Object.entries(project[section] ?? {})) {
      inspectDependency(name, info);
    }
  }
}

if (missing.length > 0) {
  console.error(`Licenses missing for ${missing.length} package(s):`);
  for (const item of missing) console.error(`- ${item.name}@${item.version} (${item.path})`);
  process.exit(1);
}

console.log(`License check passed for ${seen.size} packages.`);
