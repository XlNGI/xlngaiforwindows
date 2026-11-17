import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { getAdapterCatalog } from '@ai-video/generation-adapters';
import { ProjectService } from '../dist/project-service.js';
import { ProductionService } from '../dist/production-service.js';

// Read persisted real-provider evidence; this script never starts a model or media request.
const root = resolve(process.argv[2]);
const app = join(root, 'app-data');
const fixture = JSON.parse(readFileSync(join(app, 'prompt-generation-cases.json'), 'utf8'));
const reports = JSON.parse(readFileSync(join(app, 'unified-live-reports.json'), 'utf8'));
const results = [];
for (const report of reports) {
  const db = new Database(join(report.projectRoot, 'project.sqlite'), { readonly: true });
  const context = (id) => {
    const row = db
      .prepare(
        'SELECT content FROM agent_context_results WHERE call_id=? ORDER BY rowid DESC LIMIT 1',
      )
      .get(id);
    return row ? JSON.parse(row.content) : undefined;
  };
  const frozen = context('prompt-generation:input');
  const input = frozen ? JSON.parse(frozen.input) : undefined;
  if (input) {
    assert.equal(input.sources.length, 1);
    assert.equal(input.sources[0].contentMarkdown, fixture.source);
    assert.equal(input.generalTemplate, fixture.generalTemplate);
    assert(!frozen.input.includes('ISOLATION_SENTINEL_20261117'));
    for (const template of input.purposeTemplates)
      assert.equal(
        template.content,
        template.purpose === 'general' ? '' : (fixture.templates[template.purpose] ?? ''),
      );
  }
  const requests = db
    .prepare(
      "SELECT id,stage,created_at,completed_at,metadata_json FROM llm_provider_requests WHERE json_extract(metadata_json,'$.requestKind')='model' ORDER BY created_at,rowid",
    )
    .all()
    .map(({ metadata_json, ...row }) => ({ ...row, ...JSON.parse(metadata_json) }));
  const calls = db
    .prepare(
      'SELECT tool_name,status,error_message,provider_call_id FROM agent_tool_calls ORDER BY rowid',
    )
    .all();
  const validations = db
    .prepare(
      "SELECT summary FROM agent_task_events WHERE event_type='tool_validation_failed' ORDER BY sequence",
    )
    .all()
    .map((row) => JSON.parse(row.summary));
  const result = {
    id: report.id,
    entry: report.entry,
    status: report.generation.status,
    taskStatus: report.task.task.status,
    elapsedSeconds: report.elapsedSeconds,
    requestCount: requests.length,
    authoringRequests: requests.filter((request) => request.toolName === 'prompt.generation.submit')
      .length,
    requests,
    calls,
    validations,
    purposes: frozen?.purposes,
    fullSourceAndTemplates: !!input,
    unrelatedBodyExcluded: !!input,
    error: report.task.task.errorMessage,
    mediaJobs: db.prepare('SELECT COUNT(*) n FROM generation_jobs').get().n,
  };
  assert.equal(result.mediaJobs, 0);
  const source = db
    .prepare(
      'SELECT d.current_version_id,v.content_markdown FROM documents d JOIN document_versions v ON v.id=d.current_version_id WHERE d.id=?',
    )
    .get(input?.sources[0].documentId ?? '__missing__');
  if (input) {
    assert.equal(source.current_version_id, input.sources[0].versionId);
    assert.equal(source.content_markdown, fixture.source);
  }
  const saved = context('production-bundle:saved');
  if (saved) {
    const success = calls.findLast(
      (call) => call.tool_name === 'prompt.generation.submit' && call.status === 'succeeded',
    );
    assert(success);
    const argumentsRow = db
      .prepare(
        'SELECT arguments_json FROM agent_context_results WHERE call_id=? AND arguments_json IS NOT NULL ORDER BY rowid DESC LIMIT 1',
      )
      .get(success.provider_call_id);
    const args = JSON.parse(argumentsRow.arguments_json);
    const ids = new Map(saved.objects.map((object) => [object.key, object.id]));
    const resolveBindings = (value) => {
      if (Array.isArray(value)) return value.map(resolveBindings);
      if (value && typeof value === 'object') {
        if (value.localKey) {
          assert(ids.has(value.localKey));
          return ids.get(value.localKey);
        }
        if (value.existingId) return value.existingId;
        return Object.fromEntries(
          Object.entries(value).map(([key, child]) => [key, resolveBindings(child)]),
        );
      }
      return value;
    };
    result.outputs = args.prompts.map((prompt) => {
      const id = ids.get(prompt.localKey);
      assert(id, prompt.localKey);
      const stored =
        prompt.kind === 'shot-image'
          ? db
              .prepare('SELECT prompt,bindings_json FROM shot_image_prompts WHERE shot_id=?')
              .get(id)
          : ['scene', 'shot'].includes(prompt.kind)
            ? db
                .prepare(
                  `SELECT ${prompt.kind === 'scene' ? 'video_prompt' : 'prompt'} prompt,bindings_json FROM ${prompt.kind === 'scene' ? 'scenes' : 'shots'} WHERE id=?`,
                )
                .get(id)
            : db
                .prepare(
                  'SELECT v.content_markdown prompt,v.bindings_json FROM documents d JOIN document_versions v ON v.id=d.current_version_id WHERE d.id=?',
                )
                .get(id);
      assert.equal(stored.prompt, prompt.prompt);
      const bindings = JSON.parse(stored.bindings_json);
      for (const [key, value] of Object.entries(resolveBindings(prompt.bindings)))
        assert.deepEqual(bindings[key], value);
      assert(!stored.prompt.includes('ISOLATION_SENTINEL_20261117'));
      return { id, ...prompt, savedBindings: bindings, exactSavedText: true };
    });
    result.exactParsedToSaved = true;
    result.receipt = context('prompt-generation:receipt').result;
    assert.equal(result.receipt.businessSaved, true);
    assert.equal(result.receipt.readbackVerified, true);
    const task = db.prepare('SELECT status,updated_at FROM agent_tasks LIMIT 1').get();
    result.postSaveModelRequests = requests.filter(
      (request) => request.created_at > saved.committedAt,
    ).length;
    assert.equal(result.postSaveModelRequests, 0);
    assert.equal(task.status, 'completed');
    db.close();
    const projects = new ProjectService({
      recentProjectsPath: join(app, `audit-recent-${report.id}.json`),
    });
    try {
      projects.open(report.projectRoot);
      const service = new ProductionService(projects);
      const shot = result.outputs.find((output) => output.kind === 'shot');
      const adapters = getAdapterCatalog().adapters.filter(
        (adapter) => adapter.capability === 'TEXT_TO_VIDEO',
      );
      const first =
        adapters.find((adapter) => adapter.contractId === 'cn.qwen.wan3-0-video') ?? adapters[0];
      const second =
        adapters.find(
          (adapter) => adapter.key !== first.key && adapter.provider !== first.provider,
        ) ?? adapters.find((adapter) => adapter.key !== first.key);
      result.localForms = [first, second].map((adapter) => {
        const compiled = service.compile({
          target: { kind: 'shot', id: shot.id },
          adapterKey: adapter.key,
        });
        assert.equal(compiled.compiledPrompt, shot.prompt);
        assert.equal(compiled.parameters.prompt, shot.prompt);
        return {
          adapterKey: adapter.key,
          exactPrompt: true,
          parameters: compiled.parameters,
          issues: compiled.issues,
        };
      });
    } finally {
      projects.close();
    }
    const after = new Database(join(report.projectRoot, 'project.sqlite'), { readonly: true });
    assert.equal(
      after
        .prepare(
          "SELECT COUNT(*) n FROM llm_provider_requests WHERE json_extract(metadata_json,'$.requestKind')='model'",
        )
        .get().n,
      requests.length,
    );
    assert.equal(after.prepare('SELECT COUNT(*) n FROM generation_jobs').get().n, 0);
    after.close();
    result.formModelRequests = 0;
  } else {
    result.businessObjects =
      db
        .prepare(
          "SELECT COUNT(*) n FROM documents WHERE kind IN ('character','scene','prop','voice')",
        )
        .get().n + db.prepare('SELECT COUNT(*) n FROM scenes').get().n;
    assert.equal(result.businessObjects, 0);
    db.close();
  }
  results.push(result);
}
writeFileSync(join(root, 'final-audit.json'), JSON.stringify({ root, results }, null, 2));
console.log(
  JSON.stringify(
    results.map(
      ({ id, status, requestCount, authoringRequests, exactParsedToSaved, formModelRequests }) => ({
        id,
        status,
        requestCount,
        authoringRequests,
        exactParsedToSaved,
        formModelRequests,
      }),
    ),
    null,
    2,
  ),
);
