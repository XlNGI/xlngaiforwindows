import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { checkIntegrity, getSchemaVersion, migrateDatabase } from './database.js';
import { CURRENT_SCHEMA_VERSION } from './schema.js';
import { applyMigrationV78 } from './migration-v78.js';

const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.pragma('foreign_keys=ON');
  migrateDatabase(db);
  db.exec(`
    DROP TABLE document_image_exclusions;
    DELETE FROM schema_migrations WHERE version>=78;
    INSERT INTO projects(id,name,created_at,updated_at) VALUES('p','项目','before','before'),('other','其他','before','before');
    INSERT INTO documents(id,project_id,kind,title,scope_type,created_at,updated_at) VALUES('d','p','character','资料','project','before','before');
    INSERT INTO assets(id,project_id,kind,relative_path,content_hash,size_bytes,created_at) VALUES('a','p','character-image','assets/a.png','hash',1,'before'),('foreign','other','scene-image','assets/b.png','other-hash',1,'before');
    INSERT INTO generation_jobs(id,project_id,adapter_key,status,request_json,task_snapshot_json,created_at,updated_at) VALUES('j','p','local','succeeded','{}','{"sourceDocumentId":"d"}','before','before');
    INSERT INTO generation_results(id,job_id,asset_id,created_at) VALUES('r','j','a','before');
  `);
  return db;
}
it('upgrades v77 without changing existing document, asset or source history and is idempotent', () => {
  const db = fixture();
  const snapshot = () =>
    ['documents', 'assets', 'generation_jobs', 'generation_results'].map((table) =>
      db.prepare(`SELECT * FROM ${table}`).all(),
    );
  const before = snapshot();
  expect(getSchemaVersion(db)).toBe(77);
  expect(migrateDatabase(db)).toBe(CURRENT_SCHEMA_VERSION);
  expect(migrateDatabase(db)).toBe(CURRENT_SCHEMA_VERSION);
  applyMigrationV78(db);
  expect(snapshot()).toEqual(before);
  expect(db.prepare('SELECT * FROM document_image_exclusions').all()).toEqual([]);
  expect(checkIntegrity(db).ok).toBe(true);
});
it('rejects cross-project exclusions and keeps each document/asset pair unique', () => {
  const db = fixture();
  migrateDatabase(db);
  const insert = db.prepare('INSERT INTO document_image_exclusions VALUES(?,?,?,?)');
  expect(() => insert.run('p', 'd', 'foreign', 'now')).toThrow('project mismatch');
  insert.run('p', 'd', 'a', 'now');
  expect(() => insert.run('p', 'd', 'a', 'again')).toThrow('UNIQUE');
  expect(() => db.prepare("UPDATE document_image_exclusions SET project_id='other'").run()).toThrow(
    'project mismatch',
  );
});
it('rolls back the schema and version together on failure and upgrades successfully on retry', () => {
  const db = fixture();
  db.exec(
    "CREATE TRIGGER fail_v78 BEFORE INSERT ON schema_migrations WHEN NEW.version=78 BEGIN SELECT RAISE(ABORT,'v78 failure'); END",
  );
  expect(() => migrateDatabase(db)).toThrow('v78 failure');
  expect(getSchemaVersion(db)).toBe(77);
  expect(
    db.prepare("SELECT 1 FROM sqlite_master WHERE name='document_image_exclusions'").get(),
  ).toBeUndefined();
  expect(db.prepare('SELECT * FROM generation_results').all()).toHaveLength(1);
  db.exec('DROP TRIGGER fail_v78');
  expect(migrateDatabase(db)).toBe(CURRENT_SCHEMA_VERSION);
  expect(checkIntegrity(db).ok).toBe(true);
});
