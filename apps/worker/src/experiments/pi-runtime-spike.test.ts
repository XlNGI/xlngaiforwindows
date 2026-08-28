import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  PI_RUNTIME_SPIKE_CHECKS,
  PI_RUNTIME_SPIKE_VERSION,
  runPiRuntimeSpike,
} from './pi-runtime-spike.js';

function readInstalledVersion(packageName: string): string {
  const manifest = JSON.parse(
    readFileSync(
      new URL(`../../node_modules/${packageName}/package.json`, import.meta.url),
      'utf8',
    ),
  ) as { version: string };
  return manifest.version;
}

describe('Pi low-level Agent runtime feasibility Spike', () => {
  it('passes the isolated fake-provider capability matrix', async () => {
    const report = await runPiRuntimeSpike();

    expect(report).toMatchObject({
      ok: true,
      piVersion: '0.84.3',
      provider: 'faux',
      networkAttempts: 0,
      credentialPayloads: 0,
    });
    expect(report.providerCalls).toBeGreaterThan(0);
    expect(report.checks.map((check) => check.name)).toEqual(PI_RUNTIME_SPIKE_CHECKS);
  });

  it('uses exactly pinned Pi packages', () => {
    expect(readInstalledVersion('@earendil-works/pi-agent-core')).toBe(PI_RUNTIME_SPIKE_VERSION);
    expect(readInstalledVersion('@earendil-works/pi-ai')).toBe(PI_RUNTIME_SPIKE_VERSION);
  });

  it('does not wire the experiment into the production worker entry', () => {
    const productionEntry = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

    expect(productionEntry).not.toContain('pi-runtime-spike');
    expect(productionEntry).not.toContain('@earendil-works/pi-agent-core');
  });
});
