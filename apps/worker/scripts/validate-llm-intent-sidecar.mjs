import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { renderProductionInstruction } from '../../../packages/contracts/dist/index.js';

function productionInstruction(summary, shot = false) {
  return {
    version: 2,
    summary,
    narrative: { purpose: '展示信件线索' },
    storyTime: { timeOfDay: '清晨' },
    location: { description: summary },
    visual: { style: '写实' },
    subjects: [],
    camera: { framing: '中景' },
    ...(shot
      ? {
          stillFrame: summary,
          timing: { estimatedDurationSeconds: 4, rationale: '停顿后发现线索' },
        }
      : {}),
    beats: shot
      ? [{ id: 'beat-1', action: '发现线索', dialogue: [], characterDocumentIds: [] }]
      : [],
    audio: { mode: 'silent' },
    generation: {},
    resources: [],
    continuity: {
      predecessors: [],
      before: [],
      after: [{ key: 'letter', value: 'visible' }],
      locked: [],
      constraints: [],
    },
  };
}

const repository = resolve('.');
const Database = createRequire(join(repository, 'apps/worker/package.json'))('better-sqlite3');
const executable = join(
  repository,
  'apps/desktop/src-tauri/binaries/ai-video-worker-x86_64-pc-windows-msvc.exe',
);
const temporaryRoot = mkdtempSync(join(tmpdir(), 'unicomp-llm-intent-'));
mkdirSync(join(temporaryRoot, 'home'));
const child = spawn(executable, [], {
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    USERPROFILE: join(temporaryRoot, 'home'),
    AI_VIDEO_APP_DATA_DIR: join(temporaryRoot, 'settings'),
  },
});
const waiters = new Map();
let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += chunk;
});
createInterface({ input: child.stdout }).on('line', (line) => {
  const response = JSON.parse(line);
  assert.notEqual(
    response.kind,
    'host.request',
    'This isolated verification must never call a Provider',
  );
  const waiter = waiters.get(response.id);
  if (!waiter) return;
  waiters.delete(response.id);
  clearTimeout(waiter.timer);
  if (response.ok) waiter.resolve(response.result);
  else waiter.reject(new Error(`${waiter.method}: ${JSON.stringify(response.error)}`));
});
child.on('exit', (code) => {
  for (const waiter of waiters.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(new Error(`Worker exited ${code}: ${stderr}`));
  }
  waiters.clear();
});
function request(method, params = {}) {
  const id = randomUUID();
  return new Promise((resolveRequest, reject) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`${method} timed out: ${stderr}`));
    }, 20000);
    waiters.set(id, { method, resolve: resolveRequest, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, protocolVersion: 1, method, params })}\n`);
  });
}
function inspect(rootPath, query, ...params) {
  const db = new Database(join(rootPath, 'project.sqlite'), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return db.prepare(query).all(...params);
  } finally {
    db.close();
  }
}
const results = [];
try {
  for (const protocol of ['openai-responses', 'openai-chat-completions']) {
    const profile = await request('provider.profile.create', {
      name: `Isolated ${protocol}`,
      category: 'llm',
      providerType: 'openai',
      accessType: 'custom',
      protocol,
      baseUrl: 'https://example.invalid/v1',
    });
    await request('provider.connection.complete', { profileId: profile.id, status: 'ready' });
    const model = await request('provider.model.createManual', {
      profileId: profile.id,
      remoteModelId: 'validation-only',
      enabled: true,
      capabilities: {
        text: true,
        streaming: true,
        tools: true,
        vision: false,
        reasoning: false,
        structuredOutput: false,
        embeddings: false,
        imageGeneration: false,
        videoGeneration: false,
      },
    });
    for (const method of ['agent.run', 'agent.generation.prepare']) {
      for (const withHint of [true, false]) {
        const rootPath = join(temporaryRoot, `case-${results.length}`);
        await request('project.create', { rootPath, name: 'LLM 语义验证' });
        const referenceBody = '这是不可自动注入的资料正文，必须按需检索。';
        await request('document.draft.save', {
          title: '故事大纲',
          kind: 'outline',
          contentMarkdown: referenceBody,
        });
        const conversation = await request('conversation.create', { scopeType: 'project' });
        const prompt = '  生成小说的第四章和第五章，先不要发布。  ';
        const prepared = await request(method, {
          conversationId: conversation.id,
          prompt,
          providerProfileId: profile.id,
          modelId: model.id,
          ...(method === 'agent.generation.prepare' ? { agentMode: 'document' } : {}),
          ...(withHint
            ? { novelIntent: { action: 'rewrite_chapter', chapterId: 'stale-ui-hint' } }
            : {}),
        });
        if (method === 'agent.run') assert.equal(prepared.status, 'started');
        assert.equal(prepared.runtimeMode, 'document');
        let runtime = await request('llm.generation.runtime', prepared.stream);
        assert.ok(
          !runtime.tools.some((item) => item.name === 'document.create_draft'),
          'Ordinary sessions cannot bypass destination validation via a legacy draft tool',
        );
        assert.equal(runtime.prompt, prompt);
        assert.ok(
          !JSON.stringify(runtime.context).includes(referenceBody),
          'No reference body injection',
        );
        assert.equal(
          inspect(rootPath, 'SELECT id FROM novel_chapters').length,
          0,
          'No prebuilt chapters',
        );
        assert.equal(
          inspect(rootPath, 'SELECT id FROM agent_pending_intents').length,
          0,
          'No semantic pending intent',
        );
        for (const name of [
          'document.submit_draft',
          'scene.submit_structure',
          'novel.chapter.write_draft',
          'project.structure.get',
          'novel.chapter.list',
          'asset.search',
          'conversation.archive',
          'media.image.prepare',
        ])
          assert.ok(
            runtime.tools.some((tool) => tool.name === name),
            name,
          );
        const execute = async (name, args) => {
          const tool = runtime.tools.find((item) => item.name === name);
          assert.ok(tool, `Current handle for ${name}`);
          await request('agent.providerStep.start', prepared.stream);
          const result = await request('agent.generation.executeTools', {
            ...prepared.stream,
            providerResponseId: randomUUID(),
            calls: [
              {
                id: randomUUID(),
                name,
                authorizationHandle: tool.authorizationHandle,
                argumentsJson: JSON.stringify(args),
              },
            ],
          });
          runtime = await request('llm.generation.runtime', prepared.stream);
          return JSON.parse(result.continuation.outputs[0].output);
        };
        await execute('document.list', {});
        await execute('project.structure.get', {});
        const invalid = await execute('novel.chapter.write_draft', {
          resourceId: 'workspace:novel',
          action: 'create_chapter',
          title: '错误目标',
          contentMarkdown: '不应保存',
          volumeId: 'foreign-volume',
        });
        assert.equal(invalid.status, 'rejected');
        assert.equal(
          inspect(rootPath, 'SELECT id FROM novel_chapters').length,
          0,
          'Failed writes rolled back',
        );
        const fourth = await execute('novel.chapter.write_draft', {
          resourceId: 'workspace:novel',
          action: 'create_chapter',
          title: '第四章 夜行',
          displayLabel: '第四章',
          contentMarkdown: '夜色中的完整第四章正文。',
        });
        assert.equal(fourth.status, 'draft_saved');
        const found = await execute('library.search', {
          query: '第四章',
          sourceTypes: ['novel-chapter'],
        });
        const source = found.sources.find((item) => item.sourceId === fourth.chapterId);
        assert.ok(source, 'New draft can be retrieved before publishing');
        assert.equal(source.status, 'draft');
        const read = await execute('library.read', { sourceHandle: source.sourceHandle });
        assert.ok(read.content.includes('完整第四章正文'));
        const fifth = await execute('novel.chapter.write_draft', {
          resourceId: 'workspace:novel',
          action: 'create_chapter',
          title: '第五章 来客',
          displayLabel: '第五章',
          contentMarkdown: '承接第四章的完整第五章正文。',
        });
        assert.equal(fifth.status, 'draft_saved');
        assert.notEqual(fourth.taskId, fifth.taskId);
        const detail = await request('agent.task.get', { taskId: prepared.agentTaskId });
        assert.equal(detail.target.chapterId, fifth.chapterId);
        assert.equal(detail.documents.length, 2);
        for (const artifact of [fourth, fifth])
          assert.equal(
            (await request('agent.task.get', { taskId: artifact.taskId })).task.status,
            'waiting_review',
          );
        const directory = await execute('project.structure.get', {});
        const documentsBeforeInvalid = inspect(rootPath, 'SELECT id FROM documents').length;
        const tasksBeforeInvalid = inspect(rootPath, 'SELECT id FROM agent_tasks').length;
        assert.ok(directory.resourceMap.resources.some((item) => item.id === 'workspace:novel'));
        assert.ok(
          directory.resourceMap.resources.some((item) => item.id === 'workspace:documents'),
        );
        const outline = {
          title: '《剑开天门》玄幻短篇小说大纲',
          documentKind: 'outline',
          contentMarkdown: '# 大纲\n\n已确定的小说设定。',
        };
        const incomplete = await execute('document.submit_draft', outline);
        assert.equal(
          incomplete.status,
          'rejected',
          'Screenshot call without a destination must fail',
        );
        assert.match(incomplete.error.message, /resourceId/);
        const mismatch = await execute('document.submit_draft', {
          ...outline,
          resourceId: 'workspace:documents',
          bindingRole: 'work-outline',
        });
        assert.equal(mismatch.status, 'rejected', 'Novel binding cannot target the script page');
        assert.equal(
          inspect(rootPath, 'SELECT id FROM documents').length,
          documentsBeforeInvalid,
          'Rejected writes have no document',
        );
        assert.equal(
          inspect(rootPath, 'SELECT id FROM agent_tasks').length,
          tasksBeforeInvalid,
          'Rejected writes have no child task',
        );
        const savedOutline = await execute('document.submit_draft', {
          ...outline,
          resourceId: 'workspace:novel',
          bindingRole: 'work-outline',
        });
        assert.equal(savedOutline.status, 'draft_saved');
        assert.equal(savedOutline.locator.workspace, 'novel');
        assert.equal(savedOutline.locator.documentId, savedOutline.documentId);
        assert.equal(savedOutline.locator.versionId, savedOutline.documentVersionId);
        assert.equal(
          inspect(
            rootPath,
            'SELECT domain_scope FROM document_bindings WHERE document_id = ?',
            savedOutline.documentId,
          )[0].domain_scope,
          'novel',
        );
        assert.equal(
          inspect(rootPath, 'SELECT chapter_id FROM novel_chapter_task_locks').length,
          2,
        );
        assert.equal(inspect(rootPath, 'SELECT id FROM agent_task_confirmations').length, 0);
        const shotsPage = directory.resourceMap.resources.find(
          (item) => item.id === 'workspace:shots',
        );
        assert.equal(shotsPage.writeTool, 'scene.submit_structure');
        const courtyardSetting = await execute('document.submit_draft', {
          resourceId: 'workspace:characters',
          documentKind: 'scene',
          title: '庭院',
          contentMarkdown: '# 庭院\n青石地面的庭院场景提示词',
        });
        const studySetting = await execute('document.submit_draft', {
          resourceId: 'workspace:characters',
          documentKind: 'scene',
          title: '书房',
          contentMarkdown: '# 书房\n木桌和信件的场景提示词',
        });
        assert.equal(courtyardSetting.status, 'draft_saved');
        assert.equal(studySetting.status, 'draft_saved');
        const sceneStructure = {
          resolution: 'resolved',
          episodeTitle: '场次可见性验收',
          scenes: [
            {
              title: '庭院',
              sceneDocumentId: courtyardSetting.documentId,
              characterDocumentIds: [],
              instruction: productionInstruction('庭院'),
              shots: [
                { title: '远景', instruction: productionInstruction('清晨的庭院', true) },
                { title: '近景', instruction: productionInstruction('门上的霜', true) },
              ],
            },
            {
              title: '书房',
              sceneDocumentId: studySetting.documentId,
              characterDocumentIds: [],
              instruction: productionInstruction('书房'),
              shots: [{ title: '信件特写', instruction: productionInstruction('桌上的信', true) }],
            },
          ],
        };
        const wrongPage = await execute('scene.submit_structure', {
          ...sceneStructure,
          resourceId: 'workspace:documents',
        });
        assert.equal(wrongPage.status, 'rejected');
        assert.equal(inspect(rootPath, 'SELECT id FROM agent_change_sets').length, 0);
        const structureProposal = await execute('scene.submit_structure', {
          ...sceneStructure,
          resourceId: 'workspace:shots',
        });
        assert.equal(
          structureProposal.status,
          'scene_structure_saved',
          JSON.stringify(structureProposal),
        );
        assert.equal(structureProposal.locator.workspace, 'shots');
        assert.equal(structureProposal.locator.changeSetId, structureProposal.changeSetId);
        assert.equal(structureProposal.applied, true);
        assert.equal(structureProposal.reviewRequired, false);
        assert.equal(
          (await request('scene.list')).length,
          2,
          'Generated scenes are immediately available as editable drafts',
        );
        const structureDetail = await request('agent.task.get', { taskId: prepared.agentTaskId });
        assert.equal(structureDetail.changeSets[0].changeSetId, structureProposal.changeSetId);
        assert.equal((await request('agent.changeSet.list', { includeTerminal: false })).length, 0);
        const proposals = await request('agent.changeSet.list', { includeTerminal: true });
        const proposal = proposals.find((item) => item.id === structureProposal.changeSetId);
        assert.deepEqual(
          proposal.items
            .filter((item) => item.entityType === 'shot')
            .map((item) => item.parentItemOrdinal),
          [0, 0, 3],
        );
        assert.equal(proposal.status, 'applied');
        const appliedScenes = await request('scene.list');
        assert.equal(appliedScenes.length, 2);
        assert.equal(
          appliedScenes.find((item) => item.title === '庭院').sceneDocumentId,
          courtyardSetting.documentId,
        );
        assert.equal(
          appliedScenes.find((item) => item.title === '书房').sceneDocumentId,
          studySetting.documentId,
        );
        const bindingDirectory = await request('agent.task.get', { taskId: prepared.agentTaskId });
        assert.equal(bindingDirectory.changeSets[0].changeSetId, structureProposal.changeSetId);
        for (const [title, prompts] of [
          ['庭院', ['清晨的庭院', '门上的霜']],
          ['书房', ['桌上的信']],
        ]) {
          const parentScene = appliedScenes.find((item) => item.title === title);
          const shots = await request('shot.list', { sceneId: parentScene.id });
          assert.deepEqual(
            shots.map((item) => item.prompt),
            prompts.map((prompt) =>
              renderProductionInstruction(productionInstruction(prompt, true)),
            ),
          );
        }
        await request('agent.providerStep.start', prepared.stream);
        await request('agent.providerStep.complete', {
          ...prepared.stream,
          providerResponseId: randomUUID(),
          finishReason: 'stop',
        });
        await request('llm.generation.complete', {
          ...prepared.stream,
          content: '两章草稿已保存。',
          finishReason: 'stop',
        });
        assert.equal(
          (await request('agent.task.get', { taskId: prepared.agentTaskId })).task.status,
          'completed',
        );
        results.push({
          protocol,
          method,
          withHint,
          rawPromptPreserved: true,
          prebuiltChapters: 0,
          childDraftTasks: 5,
          reviewLocks: 2,
          confirmations: 0,
          invalidWriteRolledBack: true,
          draftRetrievedOnDemand: true,
          missingDestinationRejected: true,
          mismatchedPageRejected: true,
          novelOutlinePageVerified: true,
          sceneStructureProposalLocated: true,
          sceneStructureAppliedToCorrectParents: true,
          sceneDocumentBindingsPreserved: true,
        });
      }
    }
  }
  await request('project.close');
  const report = { executable, temporaryRoot, providerRequests: 0, cases: results };
  const reportPath = join(temporaryRoot, 'report.json');
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ reportPath, ...report }, null, 2));
} finally {
  if (child.exitCode === null) {
    const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
    child.kill();
    await exited;
  }
}
