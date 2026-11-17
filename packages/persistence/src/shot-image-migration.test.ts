import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { migrateDatabase, getSchemaVersion } from './database.js';
import {
  readShotImage,
  writeShotImage,
  readShotVideoImages,
  writeShotVideoImages,
} from './shot-image.js';
const databases: Database.Database[] = [];
function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.pragma('foreign_keys=ON');
  db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)');
  // Exercise the real v79 -> v80 transaction, without reconstructing unrelated historical migrations.
  db.exec(`INSERT INTO schema_migrations VALUES(79,'old');
    CREATE TABLE projects(id TEXT PRIMARY KEY);CREATE TABLE scenes(id TEXT PRIMARY KEY,project_id TEXT);CREATE TABLE shots(id TEXT PRIMARY KEY,scene_id TEXT,prompt TEXT,row_version INTEGER);
    CREATE TABLE shot_continuity(shot_id TEXT,project_id TEXT,binding_json TEXT,updated_at TEXT);
    CREATE TABLE shot_reference_bindings(shot_id TEXT,project_id TEXT,bindings_json TEXT);
    INSERT INTO projects VALUES('p'),('other');INSERT INTO scenes VALUES('scene','p');INSERT INTO shots VALUES('shot','scene','原视频正文',7);`);
  const binding = {
    imagePrompt: '  原静态正文\n保留空格。  ',
    notes: '构图要求',
    frames: [],
    referenceAssetIds: ['b', 'a'],
    firstFrameAssetId: 'frame',
  };
  db.prepare('INSERT INTO shot_continuity VALUES(?,?,?,?)').run(
    'shot',
    'p',
    JSON.stringify(binding),
    'before',
  );
  db.prepare('INSERT INTO shot_reference_bindings VALUES(?,?,?)').run(
    'shot',
    'p',
    JSON.stringify({ firstFrameAssetId: 'legacy-frame', ignoreSceneBinding: true }),
  );
  return { db, binding };
}
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
it('preserves old bodies and order, surfaces conflicting frame roles and has a single independent image writer', () => {
  const { db, binding } = fixture();
  expect(migrateDatabase(db)).toBe(80);
  expect(readShotImage(db, 'p', 'shot')).toMatchObject({
    prompt: binding.imagePrompt,
    legacyPrompt: binding.imagePrompt,
    purpose: 'composition',
    intent: binding.notes,
    rowVersion: 1,
  });
  const images = readShotVideoImages(db, 'p', 'shot');
  expect(images.selections?.map((i) => i.assetId)).toEqual(['b', 'a', 'legacy-frame', 'frame']);
  expect(images.conflicts).toHaveLength(1);
  const saved = writeShotImage(db, 'p', {
    shotId: 'shot',
    expectedRowVersion: 1,
    sourceToken: 'a'.repeat(64),
    prompt: '独立新图',
    purpose: 'last-frame',
    intent: '',
  });
  expect(saved.legacyPrompt).toBe(binding.imagePrompt);
  expect(db.prepare('SELECT prompt,row_version FROM shots').get()).toEqual({
    prompt: '原视频正文',
    row_version: 7,
  });
  expect(
    JSON.parse(
      (db.prepare('SELECT binding_json FROM shot_continuity').get() as { binding_json: string })
        .binding_json,
    ),
  ).toEqual(binding);
  expect(() =>
    writeShotImage(db, 'p', {
      shotId: 'shot',
      expectedRowVersion: 1,
      sourceToken: 'a'.repeat(64),
      prompt: '覆盖',
      purpose: 'composition',
      intent: '',
    }),
  ).toThrow('已更新');
  expect(() => db.prepare('UPDATE shot_image_prompts SET project_id=?').run('other')).toThrow(
    'project mismatch',
  );
  const adopted = writeShotVideoImages(db, 'p', 'shot', images.rowVersion, []);
  db.prepare('DELETE FROM schema_migrations WHERE version=80').run();
  expect(migrateDatabase(db)).toBe(80);
  expect(readShotImage(db, 'p', 'shot')).toEqual(saved);
  expect(readShotVideoImages(db, 'p', 'shot')).toEqual(adopted);
});
it('rolls the entire migration back on failure and retries without losing old text', () => {
  const { db } = fixture();
  db.exec(
    "CREATE TRIGGER stop_v80 BEFORE INSERT ON schema_migrations WHEN NEW.version=80 BEGIN SELECT RAISE(ABORT,'stop80');END;",
  );
  expect(() => migrateDatabase(db)).toThrow('stop80');
  expect(getSchemaVersion(db)).toBe(79);
  expect(
    db.prepare("SELECT 1 FROM sqlite_master WHERE name='shot_image_prompts'").get(),
  ).toBeUndefined();
  expect(readShotImage(db, 'p', 'shot').prompt).toContain('原静态正文');
  db.exec('DROP TRIGGER stop_v80');
  expect(migrateDatabase(db)).toBe(80);
  expect(migrateDatabase(db)).toBe(80);
});
it('distinguishes a new-shot placeholder from an explicitly confirmed empty video selection', () => {
  const { db } = fixture();
  migrateDatabase(db);
  db.prepare('INSERT INTO shots VALUES(?,?,?,?)').run('new-shot', 'scene', '视频正文', 0);
  expect(readShotVideoImages(db, 'p', 'new-shot')).toEqual({
    shotId: 'new-shot',
    rowVersion: 0,
    conflicts: [],
  });
  const cleared = writeShotVideoImages(db, 'p', 'new-shot', 0, []);
  expect(cleared).toEqual({
    shotId: 'new-shot',
    rowVersion: 1,
    selections: [],
    conflicts: [],
  });
  db.prepare('DELETE FROM schema_migrations WHERE version=80').run();
  migrateDatabase(db);
  expect(readShotVideoImages(db, 'p', 'new-shot')).toEqual(cleared);
});
