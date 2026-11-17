import { captureTemplateRequest } from './prompt-template-capture.mjs';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { PRODUCTION_BUNDLE_SKILL_REVISION } from '@ai-video/contracts';
import { bundleSubmissionFixture } from '../dist/test-fixtures/production-bundle-fixture.js';
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
    const spawnChild = () =>
      spawn(executable, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, AI_VIDEO_APP_DATA_DIR: join(directory, 'app-data') },
      });
    let child = spawnChild();
    const pending = new Map(),
      streams = [];
    let buffer = '',
      stderr = '',
      hostFailure;
    const attachChild = () => {
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
    };
    attachChild();
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
    let current, captureConfig;
    const capture = () =>
      captureTemplateRequest(`bundle-${protocol}`, current.params, captureConfig);
    const nextStream = () => poll(() => streams.shift(), 'next scripted model request');
    const call = async (name, args, allowFailure = false) => {
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
      if (args.operation === 'purpose') captureConfig.purpose = args.purpose;
      capture();
      const outputs = [
        ...(current.params.continuation?.outputs ?? []),
        ...(current.params.contextTurns ?? []).flatMap((t) => t.outputs ?? []),
      ];
      const output = outputs.findLast((o) => o.callId === id);
      assert(output, `Missing actual tool output ${name}`);
      if (allowFailure) return output.output;
      const result = JSON.parse(output.output);
      assert(!result.error, JSON.stringify(result));
      if (
        result.externalized ||
        ['active_skill_included', 'active_skill_reference'].includes(result.status)
      ) {
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
      let scope = { projectId: runtime.project.id, projectSessionId: runtime.projectSessionId };
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
      const bundleTemplates = {
        'character-image': '整包角色用户模板标记',
        'scene-image': '整包场景用户模板标记',
        'prop-image': '整包道具用户模板标记',
        'video-prompt': '整包视频用户模板标记',
        'shot-image': '整包不应带入静态图模板标记',
      };
      await rpc(
        'conversation.promptTemplate.save',
        {
          conversationId: conversation.id,
          content: '',
          templates: bundleTemplates,
          expectedRowVersion: 0,
        },
        scope,
      );
      const prepared = await rpc(
        'agent.generation.prepare',
        {
          conversationId: conversation.id,
          prompt: '保存完整提示词和声音绑定。',
          promptTemplateVersion: 1,
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
      if (current.params.requiredTool === 'prompt.generation.submit') {
        // New tasks use the managed contract. The historical serial verifier
        // below remains usable when explicitly checking an older executable.
        const first = JSON.parse(current.params.prompt);
        assert.equal(
          first.frozenInput.sources[0].contentMarkdown,
          source.currentVersion.contentMarkdown,
        );
        assert(!Object.hasOwn(first.frozenInput, 'generalTemplate'));
        assert.deepEqual(
          current.params.tools.map((t) => t.name),
          ['prompt.generation.submit'],
        );
        assert.equal(current.params.toolCallMode, 'single');
        assert(!current.params.contextTurns?.length);
        for (const purpose of ['character-image', 'scene-image', 'prop-image', 'video-prompt'])
          assert(
            first.frozenInput.purposeTemplates.some(
              (t) => t.purpose === purpose && t.content === bundleTemplates[purpose],
            ),
          );
        assert(!current.params.prompt.includes(bundleTemplates['shot-image']));
        await rpc(
          'conversation.promptTemplate.save',
          {
            conversationId: conversation.id,
            content: '执行期间的新通用模板不得替换快照',
            templates: { ...bundleTemplates, 'scene-image': '新场景模板不得替换快照' },
            expectedRowVersion: 1,
          },
          scope,
        );
        const exited = new Promise((done) => child.once('exit', done));
        child.kill();
        await exited;
        streams.length = 0;
        buffer = '';
        stderr = '';
        child = spawnChild();
        attachChild();
        const attached = await rpc('project.runtime.attach', {
          rootPath: projectPath,
          recoverOnStartup: true,
        });
        scope = { projectId: attached.project.id, projectSessionId: attached.projectSessionId };
        current = await nextStream();
        assert.equal(JSON.parse(current.params.prompt).requestHash, first.requestHash);
        assert(!current.params.prompt.includes('新场景模板不得替换快照'));
        assert.equal(current.params.generationId, prepared.stream.generationId);
        const prompts = bundleSubmissionFixture().submission.prompts.map((p) => ({
          ...p,
          bindings: p.bindings ?? { schemaVersion: 1 },
        }));
        const submit = (objects) => {
          const id = randomUUID();
          emit(current, { type: 'started' });
          emit(current, { type: 'tool_call_start', callId: id, name: 'prompt.generation.submit' });
          emit(current, {
            type: 'tool_call_end',
            call: {
              id,
              name: 'prompt.generation.submit',
              argumentsJson: JSON.stringify({ requestHash: first.requestHash, prompts: objects }),
            },
          });
          emit(current, {
            type: 'complete',
            providerResponseId: `managed-${id}`,
            finishReason: 'tool_calls',
          });
        };
        const invalid = structuredClone(prompts);
        invalid.find((p) => p.kind === 'shot').bindings.propDocumentIds = [
          { localKey: 'missing-prop' },
        ];
        submit(invalid);
        current = await nextStream();
        assert.equal(current.params.requiredTool, 'prompt.generation.submit');
        assert(current.params.prompt.includes('missing-prop'));
        assert(current.params.prompt.includes('PROMPT_GENERATION_STRUCTURE_REQUIRED'));
        const inspect = new Database(join(projectPath, 'project.sqlite'), {
          readonly: true,
          fileMustExist: true,
        });
        try {
          assert.equal(inspect.prepare('SELECT COUNT(*) n FROM scenes').get().n, 0);
          assert.equal(inspect.prepare('SELECT COUNT(*) n FROM documents').get().n, 1);
        } finally {
          inspect.close();
        }
        submit(prompts);
        const detail = await poll(async () => {
          const d = await rpc('agent.task.get', { taskId: prepared.agentTaskId }, scope);
          if (['failed', 'cancelled'].includes(d.task.status)) throw new Error(JSON.stringify(d));
          return d.task.status === 'completed' ? d : undefined;
        }, 'managed natural completion without model finalization');
        assert.equal(detail.deliveryReview.bundle.businessSaved, true);
        assert.equal(detail.deliveryReview.bundle.readbackVerified, true);
        assert.equal(streams.length, 0, 'Successful save must not issue a final model request.');
        await rpc('project.runtime.unload', scope);
        const db = new Database(join(projectPath, 'project.sqlite'), {
          readonly: true,
          fileMustExist: true,
        });
        try {
          const verified = readbackBundle(db, scope.projectId, prepared.agentTaskId);
          assert.equal(verified.verified, true);
          assert.equal(db.prepare('SELECT COUNT(*) n FROM documents').get().n, 7);
          assert.equal(db.prepare('SELECT COUNT(*) n FROM scenes').get().n, 1);
          assert.equal(db.prepare('SELECT COUNT(*) n FROM shots').get().n, 1);
          assert.equal(db.prepare('SELECT COUNT(*) n FROM generation_jobs').get().n, 0);
          assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
          reports.push({
            protocol,
            taskId: prepared.agentTaskId,
            status: detail.task.status,
            counts: verified.counts,
            managedGeneration: true,
            fullSourcesAndTemplates: true,
            processRestartWithFrozenInput: true,
            atomicStructuralRepair: true,
            noModelFinalizationRequest: true,
            independentReopenReadback: true,
            mediaJobs: 0,
            paidRequests: 0,
            elapsedMs: performance.now() - started,
          });
        } finally {
          db.close();
        }
        continue;
      }
      captureConfig = { general: '', templates: bundleTemplates };
      capture();
      const initialWire = JSON.stringify(current.params);
      for (const kind of ['character-image', 'scene-image', 'prop-image', 'video-prompt'])
        assert(!initialWire.includes(bundleTemplates[kind]));
      assert(!initialWire.includes(bundleTemplates['shot-image']));
      assert(!Object.hasOwn(current.params, 'promptTemplateSnapshot'));
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
      const { submission } = bundleSubmissionFixture();
      // Same task and candidate set; every writing round uses exactly one purpose.
      let stageVersion = 0,
        candidateRevision = 0;
      for (const [purpose, kinds] of [
        ['character-image', ['character']],
        ['scene-image', ['location']],
        ['prop-image', ['prop']],
        ['general', ['voice', 'plan']],
      ]) {
        await call('production.bundle', {
          operation: 'purpose',
          purpose,
          expectedStageVersion: stageVersion++,
          stageKey: `phase:${purpose}`,
        });
        if (purpose === 'scene-image') {
          await rpc(
            'conversation.promptTemplate.save',
            {
              conversationId: conversation.id,
              content: '执行期间的新通用模板不得替换快照',
              templates: { ...bundleTemplates, 'scene-image': '新场景模板不得替换快照' },
              expectedRowVersion: 1,
            },
            scope,
          );
          const exited = new Promise((done) => child.once('exit', done));
          child.kill();
          await exited;
          streams.length = 0;
          buffer = '';
          stderr = '';
          child = spawnChild();
          attachChild();
          const attached = await rpc('project.runtime.attach', {
            rootPath: projectPath,
            recoverOnStartup: true,
          });
          scope = { projectId: attached.project.id, projectSessionId: attached.projectSessionId };
          current = await nextStream();
          capture();
          assert.equal(current.params.generationId, prepared.stream.generationId);
          assert(!JSON.stringify(current.params).includes('新场景模板不得替换快照'));
        }
        const texts = [
          current.params.prompt,
          ...current.params.contextTurns.flatMap((t) => t.userMessages ?? []),
        ].join('\n');
        for (const [kind, text] of Object.entries(bundleTemplates))
          assert.equal(texts.split(text).length, kind === purpose ? 2 : 1);
        await call('production.bundle.submit', {
          expectedRevision: candidateRevision++,
          partKey: `materials:${purpose}`,
          prompts: submission.prompts.filter((p) => kinds.includes(p.kind)),
        });
      }
      // History must contain reusable same-tool argument references, not fake tool payloads.
      const historicalSubmissions = current.params.contextTurns
        .flatMap((t) => t.calls)
        .filter((c) => c.name === 'production.bundle.submit');
      assert(historicalSubmissions.length > 0);
      for (const historical of historicalSubmissions) {
        const args = JSON.parse(historical.argumentsJson);
        assert(args.preparedArguments?.resultId);
        assert(!Object.hasOwn(args, 'archivedArguments'));
      }
      const inspectArchive = () => {
        const db = new Database(join(projectPath, 'project.sqlite'), {
          readonly: true,
          fileMustExist: true,
        });
        try {
          return {
            receiptId: db
              .prepare(
                "SELECT id FROM agent_context_results WHERE task_id=? AND tool_name='production.bundle.submission' ORDER BY created_at DESC LIMIT 1",
              )
              .get(prepared.agentTaskId).id,
            preparedCount: db
              .prepare(
                "SELECT COUNT(*) n FROM agent_context_results WHERE task_id=? AND call_id LIKE 'prepared:%'",
              )
              .get(prepared.agentTaskId).n,
          };
        } finally {
          db.close();
        }
      };
      const beforeArchive = inspectArchive();
      const archiveRejection = await call(
        'production.bundle.submit',
        {
          archivedArguments: true,
          resultId: beforeArchive.receiptId,
          read: {
            tool: 'conversation.task.checkpoint',
            operation: 'result',
            resultId: beforeArchive.receiptId,
            resultView: 'arguments',
          },
        },
        true,
      );
      assert(archiveRejection.includes('ARCHIVED_ARGUMENTS_NOT_EXECUTABLE'));
      assert(archiveRejection.includes('content'));
      assert(!archiveRejection.includes('Arguments retained'));
      assert.equal(inspectArchive().preparedCount, beforeArchive.preparedCount);
      await call('production.bundle', { operation: 'state' });
      await call('production.bundle', {
        operation: 'purpose',
        purpose: 'video-prompt',
        expectedStageVersion: stageVersion++,
        stageKey: 'phase:video',
      });
      const finalSubmission = {
        expectedRevision: candidateRevision++,
        partKey: 'shots',
        prompts: submission.prompts.filter((p) => ['scene', 'shot'].includes(p.kind)),
        complete: true,
      };
      const invalid = structuredClone(finalSubmission);
      invalid.prompts.find((p) => p.kind === 'shot').bindings.propDocumentIds = [
        { localKey: 'missing-prop' },
      ];
      const blocked = await call('production.bundle.submit', invalid);
      assert.equal(blocked.businessSaved, false);
      await call('production.bundle', {
        operation: 'purpose',
        purpose: 'shot-image',
        expectedStageVersion: stageVersion++,
        stageKey: 'phase:static',
      });
      const shot = finalSubmission.prompts.find((p) => p.kind === 'shot');
      const staticText = '本镜独立静态图：空房间与门把手。哈哈110\n\n';
      await call('production.bundle.submit', {
        expectedRevision: candidateRevision++,
        partKey: 'static',
        prompts: [
          {
            kind: 'shot-image',
            localKey: shot.localKey,
            title: shot.title,
            prompt: staticText,
            imagePurpose: 'composition',
            intent: '只表现静态构图',
            bindings: {
              schemaVersion: 1,
              characterDocumentIds: [],
              sceneDocumentIds: [{ localKey: 'room' }],
              propDocumentIds: [],
            },
          },
        ],
      });
      await call('production.bundle', {
        operation: 'purpose',
        purpose: 'video-prompt',
        expectedStageVersion: stageVersion++,
        stageKey: 'phase:video-repair',
      });
      const repairedSubmission = {
        expectedRevision: candidateRevision,
        partKey: 'repair-shot',
        prompts: finalSubmission.prompts.filter((p) => p.kind === 'shot'),
      };
      const committed = await call('production.bundle.submit', repairedSubmission);
      assert.equal(committed.status, 'bundle_readback_verified', JSON.stringify(committed));
      assert.equal(committed.verified, true);
      assert.equal(committed.businessSaved, true);
      assert.equal(committed.readbackVerified, true);
      assert.equal(committed.objectCount, 8);
      assert.equal(committed.shotImageCount, 1);
      assert.deepEqual(committed.counts, {
        character: 2,
        voice: 2,
        prop: 1,
        scene: 1,
        shot: 1,
        plan: 0,
        storyScene: 1,
      });
      // Replay the final submission after a lost acknowledgement without duplicating objects.
      const replay = await call('production.bundle.submit', repairedSubmission);
      assert.equal(replay.status, 'bundle_readback_verified', JSON.stringify(replay));
      assert.equal(replay.verified, true);
      assert.equal(replay.mappingResultId, committed.mappingResultId);
      const readback = await call('production.bundle', { operation: 'readback' });
      assert.equal(readback.verified, true);
      assert.equal(readback.shotImageCount, 1);
      const savedObjects = await call('production.bundle', { operation: 'saved' });
      assert.equal(savedObjects.shotImageCount, 1);
      assert(
        savedObjects.objects.some(
          (item) => item.kind === 'shot' && item.shotImage?.read?.tool === 'shot.image.read',
        ),
      );
      emit(current, { type: 'started' });
      emit(current, { type: 'text_delta', delta: '离线流程验证完成。' });
      emit(current, { type: 'complete', providerResponseId: randomUUID(), finishReason: 'stop' });
      const detail = await poll(async () => {
        const d = await rpc('agent.task.get', { taskId: prepared.agentTaskId }, scope);
        if (['failed', 'cancelled'].includes(d.task.status)) throw new Error(JSON.stringify(d));
        return d.task.status === 'completed' ? d : undefined;
      }, 'natural task completion');
      assert.equal(detail.deliveryReview.state, 'unverified');
      assert.equal(detail.deliveryReview.bundle.businessSaved, true);
      assert.equal(detail.deliveryReview.bundle.readbackVerified, true);
      assert.equal(detail.documents.length, 6);
      await rpc('project.runtime.unload', scope);
      const db = new Database(join(projectPath, 'project.sqlite'), {
        readonly: true,
        fileMustExist: true,
      });
      try {
        const verified = readbackBundle(db, scope.projectId, prepared.agentTaskId);
        assert.equal(verified.verified, true);
        assert.deepEqual(verified.counts, committed.counts);
        const receipts = db
          .prepare(
            `SELECT r.result_json FROM agent_execution_commits c
             JOIN agent_write_receipts r ON r.id=c.receipt_id
             WHERE c.project_id=? AND c.task_id=? AND c.operation_key='production-bundle:commit'`,
          )
          .all(scope.projectId, prepared.agentTaskId);
        assert.equal(receipts.length, 1);
        const receipt = JSON.parse(receipts[0].result_json);
        assert.equal(receipt.status, 'bundle_committed');
        assert.equal(receipt.mappingResultId, committed.mappingResultId);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM documents').get().n, 7);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM scenes').get().n, 1);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM shots').get().n, 1);
        assert.equal(db.prepare('SELECT prompt FROM shot_image_prompts').get().prompt, staticText);
        assert.equal(db.prepare('SELECT prompt FROM shots').get().prompt, shot.prompt);
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
          processRestartWithFrozenPurpose: true,
          structuralRepair: true,
          archivedPointerRejectedWithoutPoisoningRetry: true,
          reusableHistoricalArguments: true,
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
