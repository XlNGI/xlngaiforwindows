import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { validateProductionIRReferences } from './project-ir-validation.js';

const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(`CREATE TABLE documents(id TEXT, project_id TEXT, kind TEXT, lifecycle_status TEXT,
      current_version_id TEXT, published_version_id TEXT);
    CREATE TABLE document_bindings(document_id TEXT, domain_scope TEXT, status TEXT);
    INSERT INTO documents VALUES ('actual-id','p','character','active','draft-version',NULL);`);
  const validate = (id: string) =>
    validateProductionIRReferences(db, 'p', {
      schemaVersion: 1,
      kind: 'shot',
      prompt: 'existing prompt',
      references: { characterDocumentIds: [id] },
    });
  return { db, validate };
}

it('accepts active draft material IDs and gives a precise repair path for mistyped IDs', () => {
  const f = fixture();
  expect(() => f.validate('actual-id')).not.toThrow();
  expect(() => f.validate('mistyped-id')).toThrow('references.characterDocumentIds');
  expect(() => f.validate('mistyped-id')).toThrow('Active draft and published');
  expect(() => f.validate('mistyped-id')).toThrow('exact documentId and documentKind=character');
  expect(() => f.validate('mistyped-id')).toThrow('Do not remove required references');
  expect(() => f.validate('draft-version')).toThrow();
  expect(() => f.validate('document:actual-id')).toThrow();
  expect(() => f.validate('actual-id')).not.toThrow();
});

it.each([
  "UPDATE documents SET project_id='other'",
  "UPDATE documents SET kind='prop'",
  "UPDATE documents SET lifecycle_status='archived'",
  "INSERT INTO document_bindings VALUES ('actual-id','novel','active')",
])('keeps reference scope/type/lifecycle validation after improving feedback: %s', (mutation) => {
  const f = fixture();
  f.db.exec(mutation);
  expect(() => f.validate('actual-id')).toThrow('not an active character document');
});
