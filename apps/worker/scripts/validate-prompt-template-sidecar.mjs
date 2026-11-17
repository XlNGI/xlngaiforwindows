import { captureTemplateRequest } from './prompt-template-capture.mjs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { emptyModelCapabilities } from '../dist/provider-registry.js';

// All model responses are supplied over local IPC. No provider is contacted.
const workerRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const executable = resolve(
  workerRoot,
  '../desktop/src-tauri/binaries/ai-video-worker-x86_64-pc-windows-msvc.exe',
);
const temporaryRoot = resolve(tmpdir());
const root = await mkdtemp(join(temporaryRoot, 'prompt-template-sidecar-'));
const reports = [];
try {
  for (const protocol of ['openai-responses', 'openai-chat-completions']) {
    for (const method of ['agent.run', 'agent.generation.prepare']) {
      const directory = join(root, protocol, method);
      const child = spawn(executable, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, AI_VIDEO_APP_DATA_DIR: join(directory, 'app-data') },
      });
      const pending = new Map();
      const streams = [];
      let buffer = '',
        stderr = '',
        hostFailure;
      const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-10000);
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        buffer += chunk;
        while (buffer.includes('\n')) {
          const end = buffer.indexOf('\n');
          const message = JSON.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          if (message.kind === 'host.request') {
            if (message.method !== 'provider.stream.start') {
              hostFailure = new Error(`Unexpected host action: ${message.method}`);
            } else streams.push({ ...message, sequence: 0 });
          } else {
            const response = message.kind === 'worker.response' ? message.payload : message;
            pending.get(response.id)?.(response);
            pending.delete(response.id);
          }
        }
      });
      const rpc = (name, params = {}, scope) =>
        new Promise((resolveResponse, reject) => {
          const id = randomUUID();
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`RPC timeout ${name}: ${stderr}`));
          }, 20000);
          pending.set(id, (response) => {
            clearTimeout(timer);
            response.ok
              ? resolveResponse(response.result)
              : reject(new Error(`${name}: ${JSON.stringify(response.error)}`));
          });
          send({ id, protocolVersion: 1, method: name, params, ...(scope ? { scope } : {}) });
        });
      const poll = async (test) => {
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          if (hostFailure) throw hostFailure;
          const value = await test();
          if (value) return value;
          if (child.exitCode !== null) throw new Error(`Sidecar exited: ${stderr}`);
          await new Promise((done) => setTimeout(done, 25));
        }
        throw new Error(`Scripted runtime timeout: ${stderr}`);
      };
      let current, captureConfig;
      const capture = () =>
        captureTemplateRequest(`ordinary-${protocol}-${method}`, current.params, captureConfig);
      const emit = (event) =>
        send({
          kind: 'host.event',
          requestId: current.requestId,
          sequence: current.sequence++,
          event: { ...event, projectSessionId: current.params.projectSessionId },
        });
      const wire = () => JSON.stringify(current.params);
      const load = async (names, workflow) => {
        const id = randomUUID();
        assert(current.params.tools.some((tool) => tool.name === 'tools.load'));
        emit({
          type: 'tool_call_end',
          call: {
            id,
            name: 'tools.load',
            argumentsJson: JSON.stringify({ names, ...(workflow ? { workflow } : {}) }),
          },
        });
        emit({ type: 'complete', providerResponseId: randomUUID(), finishReason: 'tool_calls' });
        current = await poll(() => streams.shift());
        assert(!Object.hasOwn(current.params, 'promptTemplateSnapshot'));
        const outputs = (current.params.contextTurns ?? []).flatMap((turn) => turn.outputs ?? []);
        const output = outputs.findLast((item) => item.callId === id);
        assert(output, 'Missing actual tools.load receipt');
        assert.equal(JSON.parse(output.output).status, 'tools_loaded');
        if (workflow) captureConfig.purpose = workflow;
        capture();
      };
      try {
        const profile = await rpc('provider.profile.create', {
          name: 'Offline template fixture',
          category: 'llm',
          providerType: 'custom',
          accessType: 'custom',
          protocol,
          baseUrl: 'https://fixture.invalid/v1',
        });
        await rpc('provider.connection.complete', { profileId: profile.id, status: 'ready' });
        const model = await rpc('provider.model.createManual', {
          profileId: profile.id,
          remoteModelId: 'offline-template',
          enabled: true,
          capabilities: { ...emptyModelCapabilities(), text: true, streaming: true, tools: true },
        });
        const projectPath = join(directory, 'project');
        const runtime = await rpc('project.runtime.create', {
          rootPath: projectPath,
          name: 'Template validation',
        });
        const scope = { projectId: runtime.project.id, projectSessionId: runtime.projectSessionId };
        const conversation = await rpc('conversation.create', { scopeType: 'project' }, scope);
        const general = '通用模板独有标记，保留末尾空白  ';
        const video = '视频模板独有标记：本轮机位要求';
        const character = '角色模板不应泄漏标记';
        await rpc(
          'conversation.promptTemplate.save',
          {
            conversationId: conversation.id,
            content: general,
            expectedRowVersion: 0,
            templates: { 'video-prompt': video, 'character-image': character, 'shot-image': '' },
          },
          scope,
        );
        const prompt = '只核对模板传递，不创建资料或生成媒体。';
        const params = {
          conversationId: conversation.id,
          prompt,
          promptTemplateVersion: 1,
          providerProfileId: profile.id,
          modelId: model.id,
          researchMode: 'project_only',
          ...(method === 'agent.generation.prepare' ? { agentMode: 'document' } : {}),
        };
        const prepared = await rpc(method, params, scope);
        // Edits after preparation must not replace this task's frozen template.
        await rpc(
          'conversation.promptTemplate.save',
          {
            conversationId: conversation.id,
            content: '',
            expectedRowVersion: 1,
            templates: { 'video-prompt': '', 'character-image': character, 'shot-image': '' },
          },
          scope,
        );
        const start = async (run) => {
          await rpc(
            'conversation.runtime.start',
            { ...run.stream, taskId: run.agentTaskId, mode: 'document', prompt },
            scope,
          );
          current = await poll(() => streams.shift());
          assert(!Object.hasOwn(current.params, 'promptTemplateSnapshot'));
        };
        const finish = async (run) => {
          emit({ type: 'text_delta', delta: '离线模板传递核对完成。' });
          emit({ type: 'complete', providerResponseId: randomUUID(), finishReason: 'stop' });
          await poll(async () => {
            const detail = await rpc('agent.task.get', { taskId: run.agentTaskId }, scope);
            assert(
              !['failed', 'cancelled'].includes(detail.task.status),
              JSON.stringify(detail.task),
            );
            return detail.task.status === 'completed';
          });
        };
        captureConfig = {
          general: '',
          templates: { 'video-prompt': video, 'character-image': character, 'shot-image': '' },
        };
        await start(prepared);
        capture();
        assert(
          current.params.systemInstruction.includes(
            '先用 prompt.generation.request 声明真实源版本与全部 purposes',
          ),
        );
        assert(!wire().includes(general));
        assert(!wire().includes(video));
        assert(!wire().includes(character));
        await load(['document.submit_draft'], 'video-prompt');
        assert.equal(wire().split(video).length, 2);
        assert(!wire().includes(character));
        await load(['library.read']);
        assert.equal(wire().split(video).length, 2);
        await load(['document.submit_draft'], 'shot-image');
        assert(!wire().includes(video));
        assert(!wire().includes(character));
        await finish(prepared);
        await assert.rejects(rpc(method, params, scope), /ROW_VERSION_CONFLICT/);
        const cleared = await rpc(method, { ...params, promptTemplateVersion: 2 }, scope);
        captureConfig = {
          general: '',
          templates: { 'video-prompt': '', 'character-image': character, 'shot-image': '' },
        };
        await start(cleared);
        capture();
        assert(!wire().includes(general));
        await load(['document.submit_draft'], 'video-prompt');
        assert(!wire().includes(video));
        assert(!wire().includes(character));
        assert(!wire().includes('# 机位、运镜与灯光连续性'));
        await finish(cleared);
        await rpc('project.runtime.unload', scope);
        const db = new Database(join(projectPath, 'project.sqlite'), {
          readonly: true,
          fileMustExist: true,
        });
        try {
          assert.equal(
            db.prepare('SELECT MAX(version) version FROM schema_migrations').get().version,
            80,
          );
          assert.equal(
            db
              .prepare('SELECT content FROM conversation_prompt_templates WHERE conversation_id=?')
              .get(conversation.id).content,
            '',
          );
          const saved = JSON.parse(
            db
              .prepare(
                'SELECT templates_json FROM conversation_prompt_template_variants WHERE conversation_id=?',
              )
              .get(conversation.id).templates_json,
          );
          assert.equal(saved['video-prompt'], '');
          assert.equal(db.prepare('SELECT COUNT(*) n FROM generation_jobs').get().n, 0);
          assert.equal(db.prepare('SELECT COUNT(*) n FROM documents').get().n, 0);
          assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
        } finally {
          db.close();
        }
        reports.push({
          protocol,
          method,
          frozenSnapshot: true,
          generalTemplateRemoved: true,
          scopedIsolation: true,
          clearEffective: true,
          mediaJobs: 0,
          realProviderCalls: 0,
        });
      } finally {
        child.stdin.end();
        await Promise.race([
          new Promise((done) => child.once('exit', done)),
          new Promise((done) => setTimeout(done, 5000)),
        ]);
        if (child.exitCode === null) child.kill();
      }
    }
  }
  console.log(
    JSON.stringify(
      {
        executableSha256: createHash('sha256')
          .update(await readFile(executable))
          .digest('hex'),
        validation: 'offline-scripted-native-host',
        installedInstanceUpdated: false,
        reports,
      },
      null,
      2,
    ),
  );
} finally {
  const target = resolve(root);
  assert(target.startsWith(temporaryRoot + sep) && target.includes('prompt-template-sidecar-'));
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
