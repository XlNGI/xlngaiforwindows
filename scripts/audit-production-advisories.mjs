import { readFile, writeFile } from 'node:fs/promises';

// Input: pnpm list -r --prod --depth Infinity --json. This does not read credentials or application data.
const path = process.argv[2];
if (!path) throw new Error('Pass a JSON file from pnpm list -r --prod --depth Infinity --json.');
const projects = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const packages = new Map();
const seen = new Set();
function visit(dependencies) {
  for (const [name, item] of Object.entries(dependencies ?? {})) {
    if (/^\d+\.\d+\.\d+/.test(item.version ?? '')) {
      const key = `${name}@${item.version}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!packages.has(name)) packages.set(name, new Set());
      packages.get(name).add(item.version);
    }
    visit(item.dependencies);
    visit(item.optionalDependencies);
  }
}
for (const project of projects) {
  visit(project.dependencies);
  visit(project.optionalDependencies);
}
if (!packages.size) throw new Error('The production dependency inventory is empty.');
const response = await fetch('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(
    Object.fromEntries([...packages].map(([name, versions]) => [name, [...versions]])),
  ),
  signal: AbortSignal.timeout(30000),
});
if (!response.ok) throw new Error(`npm advisory API HTTP ${response.status}.`);
const advisories = await response.json();
if (!advisories || typeof advisories !== 'object' || Array.isArray(advisories))
  throw new Error('Invalid advisory response.');
const entries = Object.values(advisories).flat();
const high = entries.filter((entry) => entry.severity === 'high' || entry.severity === 'critical');
const report = {
  source: 'npm registry bulk advisory API',
  productionPackageNames: packages.size,
  productionPackageVersions: seen.size,
  advisoryCount: entries.length,
  highOrCriticalCount: high.length,
  advisories,
};
if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(report, null, 2));
process.stdout.write(`${JSON.stringify(report)}\n`);
if (high.length) process.exitCode = 1;
