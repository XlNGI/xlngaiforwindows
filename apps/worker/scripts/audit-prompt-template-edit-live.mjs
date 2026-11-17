import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

// Read-only audit of the opt-in Native test. Never starts provider/media requests.
const root = resolve(process.argv[2]);
const app = join(root, 'app-data');
const fixture = JSON.parse(readFileSync(join(app, 'template-edit-cases.json'), 'utf8'));
const reports = JSON.parse(readFileSync(join(app, 'template-edit-reports.json'), 'utf8'));
const hash = (text) => createHash('sha256').update(text).digest('hex');
const results = [];
for (const report of reports) {
  const identity = report.identity;
  const taskId = identity.started.agentTaskId;
  const db = new Database(join(identity.projectRoot, 'project.sqlite'), { readonly: true });
  const context = (id) => {
    const row = db
      .prepare(
        'SELECT content FROM agent_context_results WHERE task_id=? AND call_id=? ORDER BY rowid DESC LIMIT 1',
      )
      .get(taskId, id);
    return row ? JSON.parse(row.content) : undefined;
  };
  const expected = fixture.cases.find((item) => item.id === identity.id);
  const frozen = context('prompt-generation:input');
  const input = frozen ? JSON.parse(frozen.input) : undefined;
  const receipt = context('prompt-generation:receipt');
  const saved = context('production-bundle:saved');
  const calls = db
    .prepare(
      'SELECT tool_name,status,error_code,error_message,provider_call_id FROM agent_tool_calls WHERE task_id=? ORDER BY rowid',
    )
    .all(taskId);
  const submitted = calls.findLast(
    (call) => call.tool_name === 'prompt.generation.submit' && call.status === 'succeeded',
  );
  const argumentRow = submitted
    ? db
        .prepare(
          'SELECT arguments_json FROM agent_context_results WHERE task_id=? AND call_id=? AND arguments_json IS NOT NULL ORDER BY rowid DESC LIMIT 1',
        )
        .get(taskId, submitted.provider_call_id)
    : undefined;
  const parsed = argumentRow ? JSON.parse(argumentRow.arguments_json) : undefined;
  const ids = new Map(saved?.objects.map((item) => [item.key, item.id]));
  const resolveBindings = (value) => {
    if (Array.isArray(value)) return value.map(resolveBindings);
    if (value && typeof value === 'object') {
      if (value.localKey) return ids.get(value.localKey);
      if (value.existingId) return value.existingId;
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, resolveBindings(child)]),
      );
    }
    return value;
  };
  const outputs = (parsed?.prompts ?? []).map((prompt) => {
    const id = ids.get(prompt.localKey);
    const stored = db
      .prepare(
        'SELECT d.title,d.kind,v.content_markdown,v.bindings_json,v.state,v.source_task_id FROM documents d JOIN document_versions v ON v.id=d.current_version_id WHERE d.id=?',
      )
      .get(id ?? '__missing__');
    const bindings = stored ? JSON.parse(stored.bindings_json) : undefined;
    return {
      ...prompt,
      id,
      stored,
      exactSavedText: stored?.content_markdown === prompt.prompt,
      exactSavedBindings:
        !!bindings &&
        Object.entries(resolveBindings(prompt.bindings)).every(([key, value]) => {
          try {
            assert.deepEqual(bindings[key], value);
            return true;
          } catch {
            return false;
          }
        }),
    };
  });
  const requests = db
    .prepare(
      "SELECT id,stage,created_at,completed_at,metadata_json FROM llm_provider_requests WHERE generation_id=? AND json_extract(metadata_json,'$.requestKind')='model' ORDER BY rowid",
    )
    .all(identity.started.stream.generationId)
    .map(({ metadata_json, ...row }) => {
      const metadata = JSON.parse(metadata_json);
      return {
        ...row,
        toolName: metadata.toolName,
        modelSelection: metadata.modelSelection,
        inputHash: metadata.inputHash,
        requestBodyHash: metadata.requestBodyHash,
        requestBodyBytes: metadata.requestBodyBytes,
        usage: metadata.usage,
        protocol: metadata.context?.nativeWire?.protocol,
      };
    });
  const source = db
    .prepare(
      'SELECT d.current_version_id,v.content_markdown FROM documents d JOIN document_versions v ON v.id=d.current_version_id WHERE d.id=?',
    )
    .get(identity.source.id);
  const checks = {
    completed: report.generation.status === 'complete' && report.task.task.status === 'completed',
    correctFrozenVersion: input?.templateVersion === identity.templateVersion,
    noGeneralTemplate: !!input && !Object.hasOwn(input, 'generalTemplate'),
    exactScopedTemplates:
      input?.purposeTemplates.length === 3 &&
      ['character-image', 'scene-image', 'prop-image'].every((purpose) =>
        input.purposeTemplates.some(
          (template) =>
            template.purpose === purpose && template.content === expected.templates[purpose],
        ),
      ),
    exactFullSource: !!input?.sources.some(
      (item) =>
        item.documentId === identity.source.id &&
        item.versionId === identity.source.currentVersion.id &&
        item.contentMarkdown === fixture.source,
    ),
    sourceUnchanged:
      source.current_version_id === identity.source.currentVersion.id &&
      source.content_markdown === fixture.source,
    unifiedRequestAndSubmission:
      calls.some((call) => call.tool_name === 'prompt.generation.request') && !!submitted,
    threeRequestedOutputs:
      outputs.length === 3 &&
      ['character', 'location', 'prop'].every((kind) =>
        outputs.some((output) => output.kind === kind),
      ),
    exactSavedText: outputs.length === 3 && outputs.every((output) => output.exactSavedText),
    exactSavedBindings:
      outputs.length === 3 && outputs.every((output) => output.exactSavedBindings),
    draftsOnly: outputs.length === 3 && outputs.every((output) => output.stored?.state === 'draft'),
    independentReadback:
      receipt?.result.businessSaved === true && receipt.result.readbackVerified === true,
    realNativeRequests:
      requests.length > 0 && requests.every((request) => !!request.requestBodyHash),
    noMediaJobs: db.prepare('SELECT COUNT(*) n FROM generation_jobs').get().n === 0,
  };
  const usage = {};
  for (const request of requests)
    for (const [key, value] of Object.entries(request.usage ?? {}))
      if (typeof value === 'number') usage[key] = (usage[key] ?? 0) + value;
  results.push({
    id: identity.id,
    taskId,
    conversationId: identity.conversationId,
    generationId: identity.started.stream.generationId,
    templateVersion: identity.templateVersion,
    elapsedSeconds: report.elapsedSeconds,
    requestCount: requests.length,
    usage,
    checks,
    input,
    calls,
    requests,
    outputs,
  });
  db.close();
}
const audit = {
  model: fixture.modelName,
  protocol: 'openai-chat-completions',
  actualUiClick: false,
  entry: 'agent.run + conversation.runtime.start through Native WorkerState',
  workerSha256: hash(readFileSync(join(root, 'ai-video-worker.exe'))),
  sourceSha256: hash(fixture.source),
  sameConversation: new Set(results.map((result) => result.conversationId)).size === 1,
  templateVersions: results.map((result) => result.templateVersion),
  requestCount: results.reduce((sum, result) => sum + result.requestCount, 0),
  semanticAcceptance:
    'Requires human review of full outputs; automated checks cover transport/storage only.',
  results,
};
writeFileSync(join(root, 'template-edit-audit.json'), JSON.stringify(audit, null, 2));
const markdown = [
  '# 专项约束修改前后：两轮真实模型输出',
  '',
  `模型：${audit.model}；协议：${audit.protocol}；真实模型请求合计：${audit.requestCount}。`,
  '',
  '使用原项目大纲的隔离副本、同一个项目和会话，实际保存专项模板 v1 → v2；未点击真实界面，调用正常 Native/Worker 入口。仅保存草稿。',
  '',
];
for (const result of results) {
  markdown.push(
    `## ${result.id}（模板 v${result.templateVersion}）`,
    '',
    `耗时 ${result.elapsedSeconds.toFixed(1)} 秒，真实模型请求 ${result.requestCount} 次。`,
    '',
    '### 本轮冻结专项模板',
    '',
  );
  for (const template of result.input?.purposeTemplates ?? [])
    markdown.push(`#### ${template.label}`, '', template.content, '');
  markdown.push('### 实际保存的完整正文', '');
  for (const output of result.outputs) markdown.push(`#### ${output.title}`, '', output.prompt, '');
}
writeFileSync(join(root, '两轮真实生成正文.md'), markdown.join('\n'));
console.log(
  JSON.stringify(
    {
      root,
      model: audit.model,
      requestCount: audit.requestCount,
      sameConversation: audit.sameConversation,
      templateVersions: audit.templateVersions,
      results: results.map(({ id, requestCount, usage, checks }) => ({
        id,
        requestCount,
        usage,
        checks,
      })),
    },
    null,
    2,
  ),
);
assert.equal(results.length, 2);
assert(audit.sameConversation);
assert.deepEqual(audit.templateVersions, [1, 2]);
for (const result of results)
  for (const [check, passed] of Object.entries(result.checks))
    assert.equal(passed, true, `${result.id}: ${check}`);
