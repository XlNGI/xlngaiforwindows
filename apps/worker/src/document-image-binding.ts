import type Database from 'better-sqlite3';

/** A locked v77 project can be viewed read-only before its owner upgrades it. */
export function documentImageBindingPredicate(
  db: Database.Database,
  documentExpression: string,
  assetExpression: string,
): string {
  const available = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='document_image_exclusions'")
    .get();
  // Callers pass fixed SQL expressions, never user input.
  return available
    ? `NOT EXISTS (SELECT 1 FROM document_image_exclusions e
        WHERE e.document_id=${documentExpression} AND e.asset_id=${assetExpression})`
    : '1';
}
