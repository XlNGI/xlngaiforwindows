import type Database from 'better-sqlite3';

interface LegacyContextSnapshotRow {
  id: string;
  content_json: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function toManifestJson(value: Record<string, unknown>): string {
  const sources = Array.isArray(value.sources)
    ? value.sources.filter(isRecord).map((source) => ({
        id: stringValue(source.id),
        type: stringValue(source.type),
        scopeType: stringValue(source.scopeType),
        scopeId: stringValue(source.scopeId),
        label: stringValue(source.label),
        version: numberValue(source.version),
        versionId: stringValue(source.versionId),
        originalCharacters: numberValue(source.originalCharacters),
        includedCharacters: numberValue(source.includedCharacters),
        truncated: booleanValue(source.truncated),
      }))
    : [];
  return JSON.stringify({
    version: 1,
    projectId: stringValue(value.projectId),
    projectName: stringValue(value.projectName),
    scope: isRecord(value.scope) ? value.scope : undefined,
    estimatedTokens: numberValue(value.estimatedTokens),
    budgetTokens: numberValue(value.budgetTokens),
    sources,
  });
}

export function rewriteLegacyContextSnapshots(database: Database.Database): number {
  const rows = database
    .prepare(
      `SELECT id, content_json FROM context_snapshots
       WHERE purpose = 'llm-generation'`,
    )
    .all() as LegacyContextSnapshotRow[];
  const update = database.prepare('UPDATE context_snapshots SET content_json = ? WHERE id = ?');
  let changed = 0;
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.content_json) as unknown;
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    if (!('rendered' in parsed) && !('systemInstruction' in parsed)) continue;
    update.run(toManifestJson(parsed), row.id);
    changed += 1;
  }
  return changed;
}
