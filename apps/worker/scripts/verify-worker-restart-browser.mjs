/* global window, sessionStorage */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

export async function verifyWorkerRestartBrowser({ root, workerRoot, project, request, restart }) {
  const runtimePackages = process.env.CONCURRENCY_BROWSER_NODE_MODULES;
  if (!runtimePackages) throw new Error('Set CONCURRENCY_BROWSER_NODE_MODULES for Playwright.');
  const require = createRequire(import.meta.url);
  const { chromium } = require(require.resolve('playwright', { paths: [runtimePackages] }));
  const evidence = resolve(process.env.WORKER_RESTART_EVIDENCE ?? join(root, 'evidence'));
  await mkdir(evidence, { recursive: true });
  const staticRoot = resolve(workerRoot, '../desktop/dist');
  const calls = [];
  let restarting;
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      if (incoming.method === 'POST' && incoming.url === '/rpc') {
        const chunks = [];
        for await (const chunk of incoming) chunks.push(chunk);
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        await restarting;
        const response = await request(value.method, value.params, value.scope);
        calls.push({
          method: value.method,
          scope: value.scope,
          ok: response.ok,
          code: response.error?.code,
        });
        outgoing
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ...response, id: value.id }));
        return;
      }
      const url = new URL(incoming.url, 'http://localhost');
      const path = resolve(
        staticRoot,
        url.pathname === '/' ? 'index.html' : `.${decodeURIComponent(url.pathname)}`,
      );
      if (!path.startsWith(staticRoot + sep)) {
        outgoing.writeHead(404).end();
        return;
      }
      const types = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.png': 'image/png',
        '.svg': 'image/svg+xml',
      };
      outgoing
        .writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' })
        .end(await readFile(path));
    })().catch((error) => {
      if (!outgoing.headersSent) outgoing.writeHead(error.code === 'ENOENT' ? 404 : 500);
      outgoing.end();
    });
  });
  let browser;
  const errors = [];
  try {
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({
      executablePath:
        process.env.CONCURRENCY_BROWSER_EXECUTABLE ??
        'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      headless: true,
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript((project) => {
      sessionStorage.setItem(
        'ai-video.project-view',
        JSON.stringify({ projectId: project.id, rootPath: project.rootPath }),
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
              }).then((response) => response.json())
            : command === 'plugin:event|listen'
              ? ++callback
              : command === 'plugin:window|is_maximized'
                ? false
                : null,
      };
      window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
    }, project);
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.getByText(project.name, { exact: true }).first().waitFor();
    async function eventually(check, label) {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise((done) => setTimeout(done, 50));
      }
      throw new Error(`Browser recovery timed out: ${label}`);
    }
    await eventually(
      () => calls.some((call) => call.method === 'project.task.subscribe' && call.ok && call.scope),
      'initial scoped subscription',
    );
    await page.getByRole('textbox', { name: '标题', exact: true }).fill('Browser after restart');
    await page
      .getByRole('textbox', { name: '文档内容', exact: true })
      .fill('Unsaved editor content survives reconnect.');
    const original = calls.find(
      (call) => call.method === 'project.task.subscribe' && call.ok,
    ).scope;
    const before = calls.length;
    restarting = restart();
    await restarting;
    await eventually(
      () => calls.slice(before).some((call) => call.code === 'STALE_SESSION'),
      'real stale epoch rejection',
    );
    await eventually(
      () =>
        calls
          .slice(before)
          .some(
            (call) =>
              call.method === 'project.task.subscribe' &&
              call.ok &&
              call.scope?.projectSessionId !== original.projectSessionId,
          ),
      'subscription with new epoch',
    );
    await page
      .getByText('项目连接已恢复。刚才失败的操作未自动重试，请检查后重新操作。', { exact: true })
      .waitFor();
    const refreshed = calls
      .slice(before)
      .find((call) => call.method === 'project.task.subscribe' && call.ok).scope;
    assert.equal(refreshed.projectId, original.projectId);
    assert.notEqual(refreshed.projectSessionId, original.projectSessionId);
    assert.equal(
      calls.slice(before).filter((call) => call.method === 'project.runtime.attach').length,
      1,
      'Concurrent stale requests must share one recovery.',
    );
    assert.equal(
      calls
        .slice(before)
        .filter(
          (call) => call.method === 'document.save' || call.method.includes('confirmSubmission'),
        ).length,
      0,
      'Recovery must not replay writes or paid submissions.',
    );
    assert.equal(
      await page.getByRole('textbox', { name: '标题', exact: true }).inputValue(),
      'Browser after restart',
    );
    assert.equal(
      await page.getByRole('textbox', { name: '文档内容', exact: true }).inputValue(),
      'Unsaved editor content survives reconnect.',
    );
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await eventually(
      () =>
        calls
          .slice(before)
          .some(
            (call) =>
              ['document.save', 'document.draft.save'].includes(call.method) &&
              call.ok &&
              call.scope?.projectSessionId === refreshed.projectSessionId,
          ),
      'explicit UI draft save',
    );
    const documents = await request('document.list', {}, refreshed);
    assert.equal(
      documents.result.filter((document) => document.title === 'Browser after restart').length,
      1,
    );
    // A late request from the old epoch stays rejected after the view recovered.
    const late = await request(
      'document.save',
      { kind: 'note', title: 'Late old callback', contentMarkdown: 'must not persist' },
      original,
    );
    assert.equal(late.ok, false);
    assert.equal(late.error.code, 'STALE_SESSION');
    const other = await request('project.runtime.create', {
      rootPath: join(root, 'other-project'),
      name: 'Another active project',
    });
    assert.equal(other.ok, true);
    const otherScope = {
      projectId: other.result.project.id,
      projectSessionId: other.result.projectSessionId,
    };
    const currentOther = await request('project.current', {}, otherScope);
    assert.equal(currentOther.result.id, otherScope.projectId);
    await page
      .getByRole('textbox', { name: '文档内容', exact: true })
      .fill('Explicit edit while another project is active.');
    const beforeSave = calls.length;
    await page.getByRole('button', { name: '保存草稿', exact: true }).click();
    await eventually(
      () =>
        calls
          .slice(beforeSave)
          .some(
            (call) =>
              ['document.save', 'document.draft.save'].includes(call.method) &&
              call.ok &&
              call.scope?.projectId === project.id,
          ),
      'isolated save while another project is active',
    );
    assert.equal((await request('document.list', {}, otherScope)).result.length, 0);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: join(evidence, 'worker-restart-recovered.png') });
    await page.getByRole('button', { name: '项目管理操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '关闭项目', exact: true }).click();
    await page.getByText('项目已安全关闭', { exact: true }).waitFor();
    const closed = await request('project.runtime.list');
    assert.equal(
      closed.result.some((runtime) => runtime.project.id === project.id),
      false,
    );
    assert.equal(
      closed.result.some((runtime) => runtime.project.id === otherScope.projectId),
      true,
    );
    await writeFile(
      join(evidence, 'worker-restart-browser.json'),
      JSON.stringify(
        {
          passed: true,
          businessMocks: false,
          transport: 'Browser invoke proxy to real Worker stdio',
          calls: calls.slice(before),
          errors,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      'PASS: real built Desktop in Edge recovered automatically after killing/restarting the real Worker; scoped reads and explicit writes succeed, no automatic write replay.',
    );
  } finally {
    await browser?.close();
    await new Promise((done) => server.close(done));
  }
}
