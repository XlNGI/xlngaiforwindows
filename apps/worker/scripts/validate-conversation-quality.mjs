import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { AgentContextStore } from '@ai-video/persistence';
import { productionBundleFixture } from '../dist/test-fixtures/production-bundle-fixture.js';
import { ProductionBundleService } from '../dist/production-bundle-service.js';
import { checkBundle, candidateId } from '../dist/production-bundle-validation.js';
import { submitTaskReview } from '../dist/agent-task-review.js';
import { ProductionService } from '../dist/production-service.js';
import { unifiedAgentToolRegistry } from '../dist/agent-tool-registry.js';

// Real built services and disposable local projects. This verifies persistence
// and review mechanics; it does not claim model or creative-quality acceptance.
const workerRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const frozen = JSON.parse(
  await readFile(join(workerRoot, 'src/test-fixtures/conversation-quality-20261109.json'), 'utf8'),
);
const results = [];
for (const protocol of ['openai-responses', 'openai-chat-completions']) {
  const f = await productionBundleFixture(protocol);
  const cleanupTarget = resolve(f.root),
    cleanupBase = resolve(tmpdir());
  const cleanupAllowed =
    cleanupTarget.startsWith(cleanupBase + sep) && cleanupTarget.includes('production-bundle-');
  try {
    assert.ok(cleanupAllowed, 'Unexpected validation cleanup path');
    const production = new ProductionService(f.project);
    for (const [sceneIndex, scene] of frozen.scenes.entries()) {
      const saved = f.content.saveScene({
        title: `历史反例场${sceneIndex + 1}`,
        prompt: scene.prompt,
        bindings: scene.bindings,
        timing: scene.timing,
      });
      assert.equal(production.read({ kind: 'scene', id: saved.id }).compiledPrompt, scene.prompt);
      for (const [index, shot] of scene.shots.entries()) {
        const savedShot = f.content.saveShot({
          sceneId: saved.id,
          title: `镜${index + 1}`,
          prompt: shot.prompt,
          bindings: shot.bindings,
          timing: shot.timing,
        });
        assert.equal(
          production.read({ kind: 'shot', id: savedShot.id }).compiledPrompt,
          shot.prompt,
        );
      }
    }
    f.project.access(true, (db, p) => {
      const store = new AgentContextStore(db);
      const state = store.loadTask(p.id, f.task.taskId);
      store.saveTask(p.id, f.prepared.stream.generationId, f.conversation.id, {
        ...state,
        userRequirements: frozen.requirements,
      });
    });
    const part = {
      documents: [],
      scenes: frozen.scenes.map((s, i) => ({
        localKey: s.id,
        title: `反例场${i + 1}`,
        prompt: s.prompt,
        bindings: s.bindings,
        timing: s.timing,
      })),
      shots: frozen.scenes.flatMap((s) =>
        s.shots.map((shot, i) => ({
          localKey: shot.id,
          sceneKey: s.id,
          title: `镜${i + 1}`,
          prompt: shot.prompt,
          bindings: shot.bindings,
          timing: shot.timing,
        })),
      ),
    };
    const service = new ProductionBundleService(f.project, f.content, f.workflow, (value) =>
      unifiedAgentToolRegistry.serializeResult(value),
    );
    const call = (args) =>
      service.execute(args, { ...f.identity, projectSessionId: f.project.currentSessionId() });
    call({ operation: 'begin', estimatedOutputTokens: 10000 });
    call({ operation: 'put', partKey: 'frozen', expectedRevision: 0, part });
    call({
      operation: 'seal',
      expectedRevision: 1,
      manifest: {
        documentKeys: [],
        sceneKeys: part.scenes.map((s) => s.localKey),
        shotKeys: part.shots.map((s) => s.localKey),
        applicability: {
          props: '历史正文反例，仅核验保存与审查机制',
          voices: '历史正文反例，未创作新音色',
        },
      },
    });
    call({ operation: 'source', documentId: f.source.id });
    for (const item of [...part.scenes, ...part.shots])
      call({ operation: 'read', localKey: item.localKey });
    const target = part.shots[0],
      targetId = candidateId(target.localKey);
    f.project.access(true, (db, p) => {
      const pending = checkBundle(db, p.id, f.task.taskId);
      assert.deepEqual(pending.errors, []);
      assert.ok(pending.semanticReview.readyTargetIds.includes(targetId));
      const review = (args) =>
        submitTaskReview(
          db,
          p.id,
          f.task.taskId,
          {
            reviewId: pending.semanticReview.reviewId,
            reviewedTargetIds: [targetId],
            conclusion: 'passed',
            summary: '离线审查机制验证',
            issues: [],
            ...args,
          },
          pending.semanticReview,
        );
      assert.throws(() => review({}), /REQUIREMENT_COVERAGE_REQUIRED/);
      assert.throws(
        () =>
          review({
            requirementAssessments: [
              {
                requirementId: frozen.requirements[1].id,
                requirementQuote: frozen.requirements[1].text,
                targetId,
                verdict: 'satisfied',
                reason: '数值不是正文证据',
                evidence: [
                  {
                    referenceId: targetId,
                    field: 'timing',
                    quote: String(target.timing.estimatedDurationSeconds),
                  },
                ],
              },
            ],
          }),
        /TASK_REVIEW_EVIDENCE_INVALID/,
      );
      const event = review({
        conclusion: 'needs_revision',
        summary: '正文要求仍待修订',
        issues: [
          {
            targetId,
            category: 'requirement',
            description: '需要对照原始要求修订，不能把保存成功当作质量通过',
            evidence: [
              { referenceId: targetId, field: 'prompt', quote: target.prompt.slice(0, 100) },
              {
                referenceId: frozen.requirements[1].id,
                field: 'requirement',
                quote: frozen.requirements[1].text,
              },
            ],
          },
        ],
      });
      new AgentContextStore(db).putResult(
        p.id,
        f.task.taskId,
        'offline-issue',
        'conversation.task.checkpoint',
        JSON.stringify(event),
      );
    });
    assert.throws(() => call({ operation: 'commit', expectedRevision: 1 }), /REVIEW_REQUIRED/);
    const before = f.project.access(
      false,
      (db, p) => checkBundle(db, p.id, f.task.taskId, true).semanticReview,
    );
    assert.equal(before.approved, false);
    assert.equal(before.issues.length, 1);
    f.project.close();
    f.project.open(join(f.root, 'project'));
    const after = f.project.access(
      false,
      (db, p) => checkBundle(db, p.id, f.task.taskId, true).semanticReview,
    );
    assert.equal(after.issues[0].issueId, before.issues[0].issueId);
    assert.equal(after.approved, false);
    assert.equal(f.content.listScenes().length, 4);
    results.push({
      protocol,
      frozenScenes: 4,
      frozenShots: 12,
      promptBytesPreserved: true,
      onlyBindingIR: true,
      timingOnlyProofRejected: true,
      unapprovedCommitRejected: true,
      reopenedIssuePreservesIdentity: true,
    });
  } finally {
    f.project.close();
    if (cleanupAllowed)
      await rm(cleanupTarget, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
console.log(
  JSON.stringify(
    {
      kind: 'built-prompt-binding-mechanism-check',
      providerCalls: 0,
      semanticQualityEvaluation: false,
      results,
    },
    null,
    2,
  ),
);
