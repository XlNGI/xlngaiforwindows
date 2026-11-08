/**
 * Architecture regression probes converted from the 2026-11-06 defect audit.
 * Runs current Worker source against synthetic in-memory/temporary projects only.
 * No provider calls and no user project access. Run from apps/worker:
 *   pnpm exec tsx scripts/audit-agent-business-architecture.ts
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Context } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import type { LlmGenerationRuntimeRequest } from '@ai-video/contracts';
import { AgentContextStore, contextContentHash } from '@ai-video/persistence';
import { saveTaskPlan, assessTaskDeliverables } from '../src/agent-task-deliverables.js';
import {
  taskReviewState,
  submitTaskReview,
  type ReviewManifest,
} from '../src/agent-task-review.js';
import { scriptToMediaCompletionPending } from '../src/production-skill-validation.js';
import { assertNoReadLoop } from '../src/agent-context-budget.js';
import { AgentContextManager } from '../src/agent-context-manager.js';
import { ProjectService } from '../src/project-service.js';

const findings: Array<{ probe: string; observedCurrentBehavior: unknown }> = [];
const at = '2026-11-06T00:00:00.000Z';
function fixture() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE agent_tasks(id TEXT,request_snapshot_json TEXT);
    INSERT INTO agent_tasks VALUES('task','{"productionSkillId":"script-to-media"}');
    CREATE TABLE agent_tool_calls(project_id TEXT,generation_id TEXT,tool_name TEXT,status TEXT,result_summary_json TEXT);
    CREATE TABLE agent_execution_outputs(id TEXT PRIMARY KEY,project_id TEXT,task_id TEXT,plan_key TEXT,tool_name TEXT,quantity INTEGER,created_at TEXT,UNIQUE(project_id,task_id,plan_key));
    CREATE TABLE agent_execution_commits(project_id TEXT,task_id TEXT,operation_key TEXT,receipt_id TEXT,sequence INTEGER);
    CREATE TABLE agent_write_receipts(id TEXT,result_json TEXT);
    CREATE TABLE documents(id TEXT,project_id TEXT,current_version_id TEXT,lifecycle_status TEXT,updated_at TEXT,title TEXT,kind TEXT);
    CREATE TABLE document_versions(id TEXT,document_id TEXT,content_markdown TEXT);
    CREATE TABLE scenes(id TEXT,project_id TEXT,archived_at TEXT);
    INSERT INTO scenes VALUES('scene','project',NULL);
    CREATE TABLE shots(id TEXT,scene_id TEXT,authoring_ir_json TEXT,updated_at TEXT,archived_at TEXT);
    CREATE TABLE agent_context_tasks(project_id TEXT,task_id TEXT,state_json TEXT);
    CREATE TABLE agent_context_checkpoints(project_id TEXT,task_id TEXT,revision INTEGER,state_json TEXT,runtime_json TEXT);
    CREATE TABLE agent_context_results(id TEXT PRIMARY KEY,project_id TEXT,task_id TEXT,call_id TEXT,tool_name TEXT,status TEXT,version INTEGER,content TEXT,content_hash TEXT,arguments_json TEXT,created_at TEXT,UNIQUE(project_id,task_id,call_id,content_hash));
  `);
  const store = new AgentContextStore(db);
  const receipt = (tool: string, value: unknown, generation = 'generation') =>
    db
      .prepare('INSERT INTO agent_tool_calls VALUES(?,?,?,?,?)')
      .run('project', generation, tool, 'succeeded', JSON.stringify(value));
  const result = (tool: string, value: unknown) =>
    store.putResult('project', 'task', crypto.randomUUID(), tool, JSON.stringify(value));
  const plan = (deliverables: unknown[]) => {
    const value = saveTaskPlan(db, 'project', 'generation', deliverables, 'task');
    receipt('conversation.task.checkpoint', value);
    return value;
  };
  const shot = (id: string) => {
    const ir = {
      schemaVersion: 1,
      kind: 'shot',
      prompt: `${id}：人物停步，说“等一下”。`,
      references: { characterDocumentIds: [], sceneDocumentIds: [], propDocumentIds: [] },
      timing: {
        estimatedDurationSeconds: 3,
        rationale: '自然对白',
        beats: [{ kind: 'dialogue', startSeconds: 0, endSeconds: 3, description: '停步对白' }],
      },
    };
    db.prepare('INSERT INTO shots VALUES(?,?,?,?,NULL)').run(id, 'scene', JSON.stringify(ir), at);
    return ir;
  };
  return { db, store, receipt, result, plan, shot };
}

// A: Explicit reuse validates current objects without issuing creation bindings.
{
  const f = fixture();
  try {
    f.shot('shot');
    f.plan([
      {
        key: 'episode',
        intent: 'reuse',
        toolName: 'scene.update_shot_prompts',
        minimumCount: 1,
        targetIds: ['shot'],
      },
    ]);
    const before = assessTaskDeliverables(f.db, 'project', 'generation', 'task')!.pending;
    assert.equal(before[0]!.persistedCount, 1);
    assert.equal(before[0]!.creationBinding, undefined);
    const ir = JSON.parse(
      (
        f.db.prepare("SELECT authoring_ir_json FROM shots WHERE id='shot'").get() as {
          authoring_ir_json: string;
        }
      ).authoring_ir_json,
    ) as unknown;
    f.result('production.read', {
      status: 'read',
      target: { kind: 'shot', id: 'shot' },
      authoringIR: ir,
    });
    const pending = assessTaskDeliverables(f.db, 'project', 'generation', 'task')!.pending;
    assert.deepEqual(pending, []);
    findings.push({
      probe: 'A_existing_target_without_current_write',
      observedCurrentBehavior: pending,
    });
  } finally {
    f.db.close();
  }
}

// B: The contract fixes all eleven targets independently of read history.
{
  const f = fixture();
  try {
    const ids = Array.from({ length: 11 }, (_, i) => `shot-${i + 1}`);
    const irs = ids.map(f.shot);
    f.plan([
      { key: 'episode', toolName: 'scene.update_shot_prompts', minimumCount: 11, targetIds: ids },
    ]);
    f.db
      .prepare(
        "INSERT INTO documents VALUES('source','project','source-v1','active',?,'原文','plan')",
      )
      .run(at);
    f.db.prepare("INSERT INTO document_versions VALUES('source-v1','source','原文任务来源')").run();
    f.result('library.read', {
      status: 'read',
      sourceId: 'source',
      versionId: 'source-v1',
      content: '原文任务来源',
    });
    f.result('production.read', {
      status: 'read',
      target: { kind: 'shot', id: ids[0] },
      view: 'authoring',
      version: contextContentHash(JSON.stringify(irs[0])),
      authoringIR: irs[0],
    });
    const pending = scriptToMediaCompletionPending(f.db, 'project', 'generation', 'task')!;
    const review = pending[0]!.semanticReview as { ready: boolean; reviewScope: string[] };
    assert.equal(review.ready, false);
    assert.deepEqual(new Set(review.reviewScope), new Set(ids));
    findings.push({
      probe: 'B_review_scope_follows_reads_not_declared_targets',
      observedCurrentBehavior: {
        declaredTargets: ids.length,
        reviewReady: review.ready,
        reviewScope: review.reviewScope,
      },
    });
  } finally {
    f.db.close();
  }
}

// C: Upstream changes invalidate dependent coverage.
{
  const f = fixture();
  try {
    const manifest: ReviewManifest = {
      artifacts: [
        { id: 'plan', kind: 'document', version: 'plan-v1', contentHash: 'plan-h1', updatedAt: at },
        { id: 'shot', kind: 'shot', version: 'shot-v1', contentHash: 'shot-h1', updatedAt: at },
      ],
      dependencies: { shot: ['plan'], plan: [] },
      sources: [{ id: 'source', currentVersion: 'source-v1' }],
      requirements: [],
      decisions: [],
    };
    const current = taskReviewState(f.db, 'project', 'task', manifest, true);
    const event = submitTaskReview(
      f.db,
      'project',
      'task',
      {
        reviewId: current.reviewId,
        reviewedTargetIds: current.reviewScope,
        conclusion: 'passed',
        summary: '计划和镜头一致',
        issues: [],
      },
      current,
    );
    f.result('conversation.task.checkpoint', event);
    assert.equal(taskReviewState(f.db, 'project', 'task', manifest, true).approved, true);
    manifest.artifacts[0] = {
      ...manifest.artifacts[0]!,
      version: 'plan-v2',
      contentHash: 'plan-h2',
    };
    const after = taskReviewState(f.db, 'project', 'task', manifest, true);
    assert.deepEqual(after.reviewScope, ['plan', 'shot']);
    findings.push({
      probe: 'C_upstream_artifact_change_keeps_shot_coverage',
      observedCurrentBehavior: {
        changedArtifact: 'plan',
        remainingReviewScope: after.reviewScope,
        shotRequiresReassessment: after.reviewScope.includes('shot'),
      },
    });
  } finally {
    f.db.close();
  }
}

function appendTool(context: Context, toolName: string, value: unknown) {
  const id = crypto.randomUUID();
  context.messages.push(
    fauxAssistantMessage([fauxToolCall(toolName, {}, { id })], { stopReason: 'toolUse' }),
    {
      role: 'toolResult',
      toolName,
      toolCallId: id,
      isError: false,
      timestamp: 1,
      content: [{ type: 'text', text: JSON.stringify(value) }],
    },
  );
}

// D: Accepted distinct reviews advance supervision; replay cannot.
{
  const f = fixture();
  try {
    const manifest: ReviewManifest = {
      artifacts: [1, 2, 3].map((i) => ({
        id: `shot-${i}`,
        kind: 'shot',
        version: 'v1',
        contentHash: `h${i}`,
        updatedAt: at,
      })),
      sources: [{ id: 'source', currentVersion: 'v1' }],
      requirements: [],
      decisions: [],
    };
    const context: Context = { messages: [] };
    for (let i = 0; i < 3; i++) {
      appendTool(context, 'library.read', {
        status: 'read',
        sourceId: 'source',
        versionId: 'v1',
        content: '共同核验来源',
      });
      const state = taskReviewState(f.db, 'project', 'task', manifest, true);
      const event = submitTaskReview(
        f.db,
        'project',
        'task',
        {
          reviewId: state.reviewId,
          reviewedTargetIds: [`shot-${i + 1}`],
          conclusion: 'passed',
          summary: `核验镜头${i + 1}`,
          issues: [],
        },
        state,
      );
      f.result('conversation.task.checkpoint', event);
      appendTool(context, 'conversation.task.checkpoint', event);
    }
    assert.equal(taskReviewState(f.db, 'project', 'task', manifest, true).approved, true);
    assert.doesNotThrow(() => assertNoReadLoop(context));
    appendTool(context, 'library.read', {
      status: 'read',
      sourceId: 'source',
      versionId: 'v1',
      content: '共同核验来源',
    });
    assert.doesNotThrow(() => assertNoReadLoop(context));
    findings.push({
      probe: 'D_review_progress_not_a_supervisor_boundary',
      observedCurrentBehavior: {
        distinctAcceptedReviews: 3,
        identicalSourceReads: 4,
        outcome: 'continued_after_verified_review_progress',
      },
    });
  } finally {
    f.db.close();
  }
}

// E: Explicit model assumptions can be corrected with a durable reason.
{
  const f = fixture();
  try {
    const base = {
      key: 'document',
      toolName: 'document.submit_draft',
      minimumCount: 1,
      origin: 'model_inference',
    };
    f.plan([{ ...base, requiredTexts: ['模型自行推断的逐字要求'] }]);
    assert.doesNotThrow(() =>
      f.plan([{ ...base, revisionReason: '该逐字要求是模型误加，用户没有此要求' }]),
    );
    findings.push({
      probe: 'E_model_assumption_becomes_irrevocable_requirement',
      observedCurrentBehavior: {
        correctionRejected: false,
        provenanceOfRequiredTexts: 'model_inference',
      },
    });
  } finally {
    f.db.close();
  }
}

// F: Relevant recent history can exceed eight turns within the measured model budget.
{
  const directory = mkdtempSync(join(tmpdir(), 'p22-architecture-probe-'));
  const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  try {
    const project = projects.create(join(directory, 'project'), 'Architecture audit fixture');
    const runtime: LlmGenerationRuntimeRequest = {
      generationId: 'generation',
      attemptId: 'attempt',
      projectId: project.id,
      projectSessionId: projects.currentSessionId()!,
      conversationId: 'conversation',
      providerProfileId: 'provider',
      modelId: 'model',
      remoteModelId: 'remote',
      protocol: 'openai-responses',
      baseUrl: 'https://example.invalid/v1',
      systemInstruction: 'Audit fixture',
      context: 'Metadata only',
      prompt: '核验当前任务的不同镜头',
      modelCapabilities: {
        modelId: 'model',
        contextWindow: 1_000_000,
        maxOutputTokens: 4096,
        capabilitySource: 'manual_config',
      },
      inferenceSettings: {
        maxOutputTokens: 4096,
        outputTokenParameter: 'max_output_tokens',
        reasoning: 'provider_default',
      },
    };
    const manager = new AgentContextManager(projects, runtime, 'task', runtime.prompt);
    const context: Context = { messages: [] };
    for (let i = 0; i < 11; i++)
      appendTool(context, 'library.read', {
        status: 'read',
        sourceType: 'document',
        sourceId: `material-${i}`,
        versionId: 'v1',
        content: `资料正文${i}`,
      });
    const prepared = manager.prepare(runtime, context);
    const retained = prepared.request.contextTurns?.length;
    assert.equal(retained, 11);
    const storedResults = projects.access(true, (db) =>
      db
        .prepare(
          "SELECT content FROM agent_context_results WHERE project_id=? AND task_id='task' AND tool_name='library.read'",
        )
        .all(project.id),
    );
    assert.ok(storedResults.length >= 11, 'Full results must remain durable even when omitted.');
    findings.push({
      probe: 'F_history_window_independent_of_model_capacity',
      observedCurrentBehavior: {
        contextWindow: 1_000_000,
        suppliedToolTurns: 11,
        retainedToolTurns: retained,
        completeResultsDurable: storedResults.length >= 11,
      },
    });
  } finally {
    projects.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

console.log(
  JSON.stringify(
    {
      purpose:
        'Regression checks for the six isolated architecture defects; not provider business acceptance.',
      isolation:
        'Synthetic in-memory databases and one disposable project; no provider or user project access.',
      findings,
    },
    null,
    2,
  ),
);
