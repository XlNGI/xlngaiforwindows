import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { PRODUCTION_BUNDLE_SKILL_REVISION } from '@ai-video/contracts';
import {
  bundleSubmissionFixture,
  bundleManifest,
} from '../dist/test-fixtures/production-bundle-fixture.js';
import { readbackBundle } from '../dist/production-bundle-service.js';
import { emptyModelCapabilities } from '../dist/provider-registry.js';

// This is an offline, scripted host. It never connects to a model or media provider.
// It exercises the packaged executable, actual Runtime, authorization and SQLite.
const workerRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const executable = join(
  workerRoot,
  '../desktop/src-tauri/binaries/ai-video-worker-x86_64-pc-windows-msvc.exe',
);
const temporaryRoot = resolve(tmpdir());
const root = await mkdtemp(join(temporaryRoot, 'production-bundle-sidecar-'));
const reports = [];
try {
  for (const protocol of ['openai-responses', 'openai-chat-completions']) {
    const started = performance.now(),
      directory = join(root, protocol),
      projectPath = join(directory, 'project');
    const child = spawn(executable, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env, AI_VIDEO_APP_DATA_DIR: join(directory, 'app-data') },
    });
    const pending = new Map(),
      streams = [];
    let buffer = '',
      stderr = '',
      hostFailure;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-10000);
    });
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'),
          line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.kind === 'host.request') {
          if (message.method !== 'provider.stream.start') {
            hostFailure = new Error(`Unexpected host action: ${message.method}`);
            continue;
          }
          streams.push({ ...message, sequence: 0 });
        } else {
          const response = message.kind === 'worker.response' ? message.payload : message;
          pending.get(response.id)?.(response);
          pending.delete(response.id);
        }
      }
    });
    const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
    const rpc = (method, params = {}, scope) =>
      new Promise((resolveResponse, reject) => {
        const id = randomUUID(),
          timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`RPC timeout ${method}: ${stderr}`));
          }, 20000);
        pending.set(id, (response) => {
          clearTimeout(timer);
          response.ok
            ? resolveResponse(response.result)
            : reject(new Error(`${method}: ${JSON.stringify(response.error)}`));
        });
        send({ id, protocolVersion: 1, method, params, ...(scope ? { scope } : {}) });
      });
    const poll = async (test, label) => {
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline) {
        if (hostFailure) throw hostFailure;
        const value = await test();
        if (value) return value;
        if (child.exitCode !== null) throw new Error(`Sidecar exited ${child.exitCode}: ${stderr}`);
        await new Promise((resolveTimer) => setTimeout(resolveTimer, 25));
      }
      throw new Error(`Timeout ${label}: ${stderr}`);
    };
    const emit = (stream, event) =>
      send({
        kind: 'host.event',
        requestId: stream.requestId,
        sequence: stream.sequence++,
        event: { ...event, projectSessionId: stream.params.projectSessionId },
      });
    let current;
    const nextStream = () => poll(() => streams.shift(), 'next scripted model request');
    const call = async (name, args) => {
      assert(
        current.params.tools.some((t) => t.name === name),
        `Missing authorized tool ${name}; available=${current.params.tools.map((t) => t.name).join(',')}`,
      );
      const id = randomUUID();
      emit(current, { type: 'started' });
      emit(current, { type: 'tool_call_start', callId: id, name });
      emit(current, {
        type: 'tool_call_end',
        call: { id, name, argumentsJson: JSON.stringify(args) },
      });
      emit(current, {
        type: 'complete',
        providerResponseId: `fixture-${id}`,
        finishReason: 'tool_calls',
      });
      current = await nextStream();
      const outputs = [
        ...(current.params.continuation?.outputs ?? []),
        ...(current.params.contextTurns ?? []).flatMap((t) => t.outputs ?? []),
      ];
      const output = outputs.findLast((o) => o.callId === id);
      assert(output, `Missing actual tool output ${name}`);
      const result = JSON.parse(output.output);
      assert(!result.error, JSON.stringify(result));
      if (result.externalized || result.status === 'active_skill_included') {
        let offset = 0,
          content = '';
        for (;;) {
          const page = await call('conversation.task.checkpoint', {
            operation: 'result',
            resultId: result.resultId,
            resultOffset: offset,
            resultLimit: 2000,
          });
          assert.equal(page.status, 'task_result_read', JSON.stringify(page));
          content += page.content;
          if (page.nextOffset === null) break;
          offset = page.nextOffset;
        }
        return JSON.parse(content);
      }
      return result;
    };
    try {
      const profile = await rpc('provider.profile.create', {
        name: 'Offline scripted bundle fixture',
        category: 'llm',
        providerType: 'custom',
        accessType: 'custom',
        protocol,
        baseUrl: 'https://fixture.invalid/v1',
      });
      await rpc('provider.connection.complete', { profileId: profile.id, status: 'ready' });
      const model = await rpc('provider.model.createManual', {
        profileId: profile.id,
        remoteModelId: 'bundle-offline-fixture',
        enabled: true,
        capabilities: { ...emptyModelCapabilities(), text: true, streaming: true, tools: true },
      });
      const runtime = await rpc('project.runtime.create', {
        rootPath: projectPath,
        name: 'Isolated bundle validation',
      });
      const scope = { projectId: runtime.project.id, projectSessionId: runtime.projectSessionId };
      const source = await rpc(
        'document.draft.save',
        {
          kind: 'plan',
          title: '剧本',
          contentMarkdown: '主角接听画外客服的电话。客服说“订单正常”。主角说“谢谢”。',
        },
        scope,
      );
      const conversation = await rpc('conversation.create', { scopeType: 'project' }, scope);
      const prepared = await rpc(
        'agent.generation.prepare',
        {
          conversationId: conversation.id,
          prompt: '保存完整提示词和声音绑定。',
          agentMode: 'document',
          providerProfileId: profile.id,
          modelId: model.id,
          researchMode: 'project_only',
          productionSkillId: 'script-to-media',
          productionWorkflowVersion: 2,
          productionRequestedAt: new Date().toISOString(),
          productionSources: [{ documentId: source.id, versionId: source.currentVersion.id }],
        },
        scope,
      );
      await rpc(
        'conversation.runtime.start',
        {
          ...prepared.stream,
          taskId: prepared.agentTaskId,
          mode: 'document',
          prompt: '保存完整提示词和声音绑定。',
        },
        scope,
      );
      current = await nextStream();
      assert(
        !current.params.tools.some((t) =>
          ['document.submit_draft', 'scene.structure.stage', 'image.generate'].includes(t.name),
        ),
      );
      assert(!current.params.tools.some((t) => t.name === 'tools.load'));
      for (const name of ['production.skill.read', 'production.bundle', 'production.bundle.submit'])
        assert(current.params.tools.some((t) => t.name === name));
      const skill = await call('production.skill.read', { skillId: 'script-to-media' });
      assert.equal(skill.revision, PRODUCTION_BUNDLE_SKILL_REVISION, JSON.stringify(skill));
      assert(!current.params.tools.some((t) => t.name === 'production.skill.read'));
      await call('production.bundle', { operation: 'begin', estimatedOutputTokens: 4000 });
      await call('production.bundle', { operation: 'source', documentId: source.id });
      const { part, submission } = bundleSubmissionFixture();
      // Exercise ordered multipart creation in the real packaged Runtime.
      await call('production.bundle.submit', {
        expectedRevision: 0,
        partKey: 'materials',
        prompts: submission.prompts.filter((p) => !['scene', 'shot'].includes(p.kind)),
      });
      await call('production.bundle.submit', {
        expectedRevision: 1,
        partKey: 'shots',
        prompts: submission.prompts.filter((p) => ['scene', 'shot'].includes(p.kind)),
        complete: bundleManifest(part).applicability,
      });
      const targets = [...part.documents, ...part.scenes, ...part.shots];
      const reads = await call('production.bundle', {
        operation: 'read_many',
        expectedRevision: 2,
        items: targets.map((target) => ({ localKey: target.localKey })),
      });
      assert.deepEqual(reads.remaining, []);
      assert.equal(reads.reads.length, targets.length);
      const check = await call('production.bundle', { operation: 'check' });
      assert.equal(check.semanticReview.ready, true);
      assert.equal(check.semanticReview.approved, false);
      // These assessments are synthetic and verify mechanics, not model quality.
      const review = await call('conversation.task.checkpoint', {
        operation: 'review',
        reviewId: check.semanticReview.reviewId,
        reviewedTargetIds: check.semanticReview.reviewScope,
        conclusion: 'passed',
        summary: 'Offline scripted assessment; not real semantic acceptance.',
        issues: [],
        requirementAssessments: [...part.documents, ...part.scenes, ...part.shots].map(
          (target) => ({
            requirementIds: check.semanticReview.requirementIds,
            targetId: `candidate:${target.localKey}`,
            verdict: 'satisfied',
            reason: 'Offline fixture evidence only.',
            evidence: [
              {
                referenceId: `candidate:${target.localKey}`,
                quote: target.contentMarkdown ?? target.prompt ?? target.title,
                field: 'contentMarkdown' in target ? 'contentMarkdown' : 'prompt',
              },
            ],
          }),
        ),
      });
      assert.equal(review.status, 'task_review_recorded');
      const committed = await call('production.bundle', {
        operation: 'commit',
        expectedRevision: 2,
      });
      assert.equal(committed.status, 'bundle_committed');
      assert.equal(committed.readbackVerified, false);
      const replay = await call('production.bundle', { operation: 'commit', expectedRevision: 2 });
      assert.equal(replay.mappingResultId, committed.mappingResultId);
      assert.equal(replay.execution.replayed, true);
      assert.equal((await call('production.bundle', { operation: 'readback' })).verified, true);
      emit(current, { type: 'started' });
      emit(current, { type: 'text_delta', delta: '离线流程验证完成。' });
      emit(current, { type: 'complete', providerResponseId: randomUUID(), finishReason: 'stop' });
      const detail = await poll(async () => {
        const d = await rpc('agent.task.get', { taskId: prepared.agentTaskId }, scope);
        if (['failed', 'cancelled'].includes(d.task.status)) throw new Error(JSON.stringify(d));
        return d.task.status === 'completed' ? d : undefined;
      }, 'natural task completion');
      assert.equal(detail.deliveryReview.state, 'verified');
      assert.equal(detail.documents.length, 6);
      assert(
        detail.savedProductionReceipts.receipts.some((r) => r.result.status === 'bundle_committed'),
      );
      await rpc('project.runtime.unload', scope);
      const db = new Database(join(projectPath, 'project.sqlite'), {
        readonly: true,
        fileMustExist: true,
      });
      try {
        const verified = readbackBundle(db, scope.projectId, prepared.agentTaskId);
        assert.equal(verified.verified, true);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM generation_drafts').get().n, 0);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM generation_jobs').get().n, 0);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM audio_files').get().n, 0);
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
        reports.push({
          protocol,
          taskId: prepared.agentTaskId,
          status: detail.task.status,
          counts: verified.counts,
          timing: detail.deliveryReview.bundle,
          independentReopenReadback: true,
          lostAcknowledgementReplay: true,
          multipart: true,
          mediaJobs: 0,
          paidRequests: 0,
          elapsedMs: performance.now() - started,
        });
      } finally {
        db.close();
      }
    } finally {
      child.stdin.end();
      await Promise.race([
        new Promise((resolveExit) => child.once('exit', resolveExit)),
        new Promise((resolveTimer) => setTimeout(resolveTimer, 5000)),
      ]);
      if (child.exitCode === null) child.kill();
    }
  }
  console.log(
    JSON.stringify(
      {
        executableSha256: createHash('sha256')
          .update(await readFile(executable))
          .digest('hex'),
        validation: 'offline-scripted-native-host',
        realProviderValidation: false,
        installedInstanceUpdated: false,
        reports,
      },
      null,
      2,
    ),
  );
} finally {
  const target = resolve(root);
  assert(target.startsWith(temporaryRoot + sep) && target.includes('production-bundle-sidecar-'));
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
