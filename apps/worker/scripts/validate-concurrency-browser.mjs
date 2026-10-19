import { createServer } from 'node:http';
/* global window, localStorage */
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const workerRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const desktopRoot = resolve(workerRoot, '../desktop');
const root = await mkdtemp(join(tmpdir(), 'concurrency-browser-'));
const evidence = resolve(process.argv[2] ?? join(root, 'evidence'));
await mkdir(evidence, { recursive: true });
process.env.AI_VIDEO_APP_DATA_DIR = join(root, 'settings');
const runtimePackages = process.env.CONCURRENCY_BROWSER_NODE_MODULES;
if (!runtimePackages)
  throw new Error('Set CONCURRENCY_BROWSER_NODE_MODULES to the bundled runtime packages.');
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [runtimePackages] }));
const {
  configurePiConversationRuntime,
  handleRequest,
  parseRequest,
  bindWorkerRequest,
  shutdownWorker,
} = await import('../dist/handler.js');
const { NativeProviderBridge } = await import('../dist/native-provider-bridge.js');
const { RequestScheduler } = await import('../dist/request-scheduler.js');
const { AppSettingsService } = await import('../dist/app-settings-service.js');
const { createAppRepositories, openAppDatabase } = await import('@ai-video/persistence');
const streams = [];
const emit = (stream, event) =>
  bridge.handleEnvelope({
    kind: 'host.event',
    requestId: stream.id,
    sequence: stream.sequence++,
    event: { ...event, projectSessionId: stream.params.projectSessionId },
  });
const bridge = new NativeProviderBridge({
  send(envelope) {
    if (envelope.method === 'provider.stream.start') {
      const stream = { id: envelope.requestId, sequence: 0, params: envelope.params };
      streams.push(stream);
      emit(stream, { type: 'started' });
    } else if (envelope.method === 'provider.stream.cancel') {
      const stream = streams.find((item) => item.id === envelope.params.streamRequestId);
      if (stream) emit(stream, { type: 'cancelled' });
    }
    return Promise.resolve();
  },
});
configurePiConversationRuntime(bridge);
const scope = (runtime) => ({
  projectId: runtime.project.id,
  projectSessionId: runtime.projectSessionId,
});
async function rpc(method, params = {}, runtime) {
  const response = await handleRequest({
    id: crypto.randomUUID(),
    protocolVersion: 1,
    method,
    params,
    ...(runtime ? { scope: scope(runtime) } : {}),
  });
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  return response.result;
}
async function eventually(check, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Timed out: ${label}`);
}
const scheduler = new RequestScheduler();
const staticRoot = join(desktopRoot, 'dist');
const server = createServer((request, response) => {
  void (async () => {
    if (request.method === 'POST' && request.url === '/rpc') {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const parsed = parseRequest(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      const bound = 'ok' in parsed ? undefined : bindWorkerRequest(parsed);
      const result =
        'ok' in parsed ? parsed : await scheduler.run(parsed.method, bound.run, bound.queueKey);
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
      return;
    }
    const url = new URL(request.url, 'http://localhost');
    const path = resolve(
      staticRoot,
      url.pathname === '/' ? 'index.html' : `.${decodeURIComponent(url.pathname)}`,
    );
    if (!path.startsWith(staticRoot + sep)) {
      response.writeHead(404).end();
      return;
    }
    const types = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.png': 'image/png',
    };
    const bytes = await readFile(path);
    response
      .writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' })
      .end(bytes);
  })().catch((error) => {
    if (!response.headersSent) response.writeHead(error.code === 'ENOENT' ? 404 : 500);
    response.end();
  });
});
let browser;
const errors = [];
try {
  const settings = new AppSettingsService();
  const profile = settings.createProfile({
    name: 'Browser Mock LLM',
    category: 'llm',
    providerType: 'openai',
    accessType: 'official',
    protocol: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
  });
  const model = settings.createManualModel({
    profileId: profile.id,
    remoteModelId: 'gpt-4o',
    enabled: true,
    capabilities: {
      text: true,
      vision: false,
      streaming: true,
      reasoning: false,
      tools: true,
      structuredOutput: false,
      embeddings: false,
      imageGeneration: false,
      videoGeneration: false,
    },
  });
  const database = openAppDatabase(join(process.env.AI_VIDEO_APP_DATA_DIR, 'app-settings.sqlite'));
  const repositories = createAppRepositories(database);
  repositories.providerProfiles.save({
    ...repositories.providerProfiles.get(profile.id),
    enabled: true,
    connectionStatus: 'ready',
  });
  database.close();
  settings.close();
  const a = await rpc('project.runtime.create', {
    rootPath: join(root, 'A'),
    name: 'Browser Project A',
  });
  const b = await rpc('project.runtime.create', {
    rootPath: join(root, 'B'),
    name: 'Browser Project B',
  });
  const a1 = await rpc('conversation.create', { scopeType: 'project', title: 'A one' }, a);
  const a2 = await rpc('conversation.create', { scopeType: 'project', title: 'A two' }, a);
  await rpc('conversation.create', { scopeType: 'project', title: 'B one' }, b);
  const archiveA = await rpc(
    'conversation.create',
    { scopeType: 'project', title: 'A confirmation target' },
    a,
  );
  const archiveB = await rpc(
    'conversation.create',
    { scopeType: 'project', title: 'B confirmation target' },
    b,
  );
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath:
      process.env.CONCURRENCY_BROWSER_EXECUTABLE ??
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
  });
  async function windowFor(runtime) {
    await rpc('project.runtime.activate', scope(runtime));
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(
      ({ profileId, modelId }) => {
        localStorage.setItem(
          'ai-video.llm-selection',
          JSON.stringify({ providerProfileId: profileId, modelId }),
        );
        let callback = 0;
        window.isTauri = true;
        window.__TAURI_INTERNALS__ = {
          metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
          transformCallback: () => ++callback,
          unregisterCallback() {},
          convertFileSrc: (path) => path,
          invoke: async (command, args) =>
            command === 'worker_request'
              ? fetch('/rpc', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify(args.request),
                }).then((result) => result.json())
              : command === 'plugin:event|listen'
                ? ++callback
                : command === 'plugin:window|is_maximized'
                  ? false
                  : null,
        };
        window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      },
      { profileId: profile.id, modelId: model.id },
    );
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.getByText(runtime.project.name, { exact: true }).first().waitFor();
    return page;
  }
  const pageA = await windowFor(a);
  const conversationSelect = (page) => page.locator('.conversation-bar select').first();
  const send = async (page, text) => {
    await page.getByLabel('会话消息').fill(text);
    await page.getByTitle('发送消息', { exact: true }).click();
  };
  await conversationSelect(pageA).selectOption(a1.id);
  await send(pageA, 'A first conversation task');
  await eventually(
    () => streams.some((stream) => stream.params.prompt === 'A first conversation task'),
    'A first stream',
  );
  const streamA1 = streams.find((stream) => stream.params.prompt === 'A first conversation task');
  await conversationSelect(pageA).selectOption(a2.id);
  await send(pageA, 'A second conversation task');
  await eventually(
    () => streams.some((stream) => stream.params.prompt === 'A second conversation task'),
    'A second stream overlaps',
  );
  const streamA2 = streams.find((stream) => stream.params.prompt === 'A second conversation task');
  await pageA.getByLabel('发送方式').selectOption('parallel');
  await send(pageA, 'A same conversation parallel task');
  await conversationSelect(pageA).selectOption(a1.id);
  await pageA.getByTitle('停止生成', { exact: true }).click();
  await eventually(
    () => streams.some((stream) => stream.params.prompt === 'A same conversation parallel task'),
    'same-conversation parallel admission',
  );
  await conversationSelect(pageA).selectOption(a2.id);
  const pageB = await windowFor(b);
  await conversationSelect(pageB).selectOption({ label: 'B one' });
  await send(pageB, 'B independent task');
  await eventually(
    () => streams.some((stream) => stream.params.prompt === 'B independent task'),
    'B independent stream',
  );
  const streamB = streams.find((stream) => stream.params.prompt === 'B independent task');
  const tool = (stream, target) => {
    const callId = crypto.randomUUID();
    emit(stream, { type: 'tool_call_start', callId, name: 'conversation.archive' });
    emit(stream, {
      type: 'tool_call_end',
      call: {
        id: callId,
        name: 'conversation.archive',
        argumentsJson: JSON.stringify({ conversationId: target.id }),
      },
    });
    emit(stream, {
      type: 'complete',
      providerResponseId: `response-${stream.id}`,
      finishReason: 'tool_calls',
    });
  };
  tool(streamA2, archiveA);
  tool(streamB, archiveB);
  await pageA.getByRole('dialog', { name: '任务确认' }).waitFor();
  await pageB.getByRole('dialog', { name: '任务确认' }).waitFor();
  await pageA.screenshot({ path: join(evidence, 'window-a-confirmation.png'), fullPage: true });
  await pageB.screenshot({ path: join(evidence, 'window-b-confirmation.png'), fullPage: true });
  await pageA
    .getByRole('dialog', { name: '任务确认' })
    .getByRole('button', { name: '拒绝', exact: true })
    .click();
  assert(
    (await rpc('conversation.runtime.get', { generationId: streamB.params.generationId }, b))
      .confirmation,
    'A decision must not resolve B',
  );
  await pageB
    .getByRole('dialog', { name: '任务确认' })
    .getByRole('button', { name: '批准', exact: true })
    .click();
  await eventually(
    () =>
      streams.filter((stream) => stream.params.generationId === streamB.params.generationId)
        .length === 2,
    'B continuation',
  );
  await pageB.close();
  const latestB = streams
    .filter((stream) => stream.params.generationId === streamB.params.generationId)
    .at(-1);
  emit(latestB, { type: 'text_delta', delta: 'B completed after closing its window' });
  emit(latestB, { type: 'complete', providerResponseId: 'b-finished', finishReason: 'stop' });
  await eventually(
    async () =>
      (await rpc('llm.generation.get', { generationId: streamB.params.generationId }, b)).status ===
      'complete',
    'B completes without observation',
  );
  const beforeReload = streams.length;
  await pageA.reload();
  await pageA.getByText(a.project.name, { exact: true }).first().waitFor();
  await conversationSelect(pageA).selectOption(a2.id);
  await pageA.getByLabel('发送方式').waitFor();
  assert.equal(
    streams.length,
    beforeReload,
    'Reload must attach observations without starting another Provider request',
  );
  const parallel = streams.find(
    (stream) => stream.params.prompt === 'A same conversation parallel task',
  );
  emit(parallel, { type: 'text_delta', delta: 'A parallel branch complete' });
  emit(parallel, {
    type: 'complete',
    providerResponseId: 'a-parallel-finished',
    finishReason: 'stop',
  });
  const a2Continuation = streams
    .filter((stream) => stream.params.generationId === streamA2.params.generationId)
    .at(-1);
  emit(a2Continuation, { type: 'text_delta', delta: 'A separate branch retained' });
  emit(a2Continuation, {
    type: 'complete',
    providerResponseId: 'a-separate-finished',
    finishReason: 'stop',
  });
  await pageA.getByText('A parallel branch complete', { exact: false }).first().waitFor();
  assert.equal(
    (await rpc('llm.generation.get', { generationId: streamA1.params.generationId }, a)).status,
    'cancelled',
  );
  assert.equal(
    (await rpc('llm.generation.get', { generationId: parallel.params.generationId }, a)).status,
    'complete',
  );
  await eventually(
    async () =>
      (await rpc('llm.generation.get', { generationId: streamA2.params.generationId }, a))
        .status === 'complete',
    'A denial still permits final assistant text without tool authority',
  );
  const messagesA = (await rpc('chat.message.list', { conversationId: a2.id }, a)).items;
  assert(
    !messagesA.some((message) => message.content.includes('B completed')),
    'No cross-project output',
  );
  await pageA.screenshot({ path: join(evidence, 'window-a-completed.png'), fullPage: true });
  assert.deepEqual(errors, [], 'No browser page errors');
  const report = {
    passed: true,
    browser: 'headless Windows Edge',
    backend: 'real Worker services with simulated Native Provider',
    windows: 2,
    checks: [
      'cross-conversation overlap',
      'same-conversation parallel tasks',
      'cross-project overlap',
      'independent confirmations',
      'cancel only selected run',
      'window close detaches observation',
      'window-local project recovery on reload',
      'no duplicate Provider start on reload',
      'branch output ownership',
    ],
    providerCalls: streams.length,
  };
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(`${JSON.stringify(report)}\nEvidence: ${evidence}\n`);
} catch (error) {
  process.stderr.write(`${error.stack ?? error}\n`);
  if (browser)
    for (const context of browser.contexts())
      for (const [index, page] of context.pages().entries())
        await page
          .screenshot({
            path: join(evidence, `failure-${context.pages().length}-${index}-${Date.now()}.png`),
            fullPage: true,
          })
          .catch(() => undefined);
  throw error;
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
  for (const runtime of await rpc('project.runtime.list'))
    await rpc('project.runtime.unload', scope(runtime));
  await shutdownWorker();
  assert(root.startsWith(resolve(tmpdir()) + sep) && root.includes('concurrency-browser-'));
  await rm(root, { recursive: true, force: true });
}
