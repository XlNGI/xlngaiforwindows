import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { savedProductionReceipts } from './agent-saved-production-receipts.js';

it('pages durable save evidence without prompts, failed calls, read-only stages or cross-project leakage', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE agent_tool_calls(id TEXT,project_id TEXT,task_id TEXT,generation_id TEXT,
      tool_name TEXT,status TEXT,created_at TEXT,completed_at TEXT,result_summary_json TEXT)`);
    const insert = db.prepare('INSERT INTO agent_tool_calls VALUES(?,?,?,?,?,?,?,?,?)');
    for (let i = 0; i < 25; i++)
      insert.run(
        `call-${i.toString().padStart(2, '0')}`,
        'project',
        'task',
        'generation',
        'scene.update_shot_prompts',
        'succeeded',
        'now',
        'now',
        JSON.stringify({
          status: 'shot_prompts_saved',
          executionId: `execution-${i}`,
          changedCount: 30,
          unchangedCount: 0,
          paidRequests: 0,
          shots: Array.from({ length: 30 }, (_, j) => ({
            shotId: `shot-${i}-${j}`,
            sceneId: 'scene',
            rowVersion: 2,
            changed: true,
          })),
          prompt: '正文不进入恢复摘要',
          credentials: '不允许暴露',
        }),
      );
    for (const [id, project, tool, status, result] of [
      [
        'foreign',
        'foreign-project',
        'scene.update_shot_prompts',
        'succeeded',
        '{"status":"shot_prompts_saved","executionId":"foreign"}',
      ],
      [
        'failed',
        'project',
        'scene.update_shot_prompts',
        'failed',
        '{"status":"shot_prompts_saved"}',
      ],
      [
        'read',
        'project',
        'scene.structure.stage',
        'succeeded',
        '{"status":"scene_structure_staging","stageOperation":"get"}',
      ],
      ['malformed', 'project', 'scene.update_shot_prompts', 'succeeded', '{bad-json'],
    ])
      insert.run(id, project, 'task', 'generation', tool, status, 'now', 'now', result);
    const receipts = [];
    let offset = 0;
    for (;;) {
      const page = savedProductionReceipts(db, 'project', { generationId: 'generation' }, offset);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(20 * 1024);
      receipts.push(...page.receipts);
      if (page.nextOffset === undefined) break;
      expect(page.nextOffset).toBeGreaterThan(offset);
      offset = page.nextOffset;
    }
    expect(receipts.map((receipt) => receipt.result.executionId)).toEqual(
      Array.from({ length: 25 }, (_, i) => `execution-${i}`),
    );
    expect(receipts[24]!.result.shots).toEqual(
      Array.from({ length: 30 }, (_, j) => ({
        shotId: `shot-24-${j}`,
        sceneId: 'scene',
        rowVersion: 2,
        changed: true,
      })),
    );
    expect(JSON.stringify(receipts)).not.toContain('正文不进入恢复摘要');
    expect(JSON.stringify(receipts)).not.toContain('不允许暴露');
    expect(savedProductionReceipts(db, 'unknown', { taskId: 'task' }).receipts).toEqual([]);
  } finally {
    db.close();
  }
});
