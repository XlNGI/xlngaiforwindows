/* global window, document, innerWidth */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// JSDOM cannot measure grid tracks. Run against actual React components in Chromium.
const desktopRoot = fileURLToPath(new URL('../', import.meta.url));
const packages = process.env.SCENE_LAYOUT_BROWSER_NODE_MODULES;
if (!packages) throw new Error('Set SCENE_LAYOUT_BROWSER_NODE_MODULES to the Playwright packages.');
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [packages] }));
const fixtureRoot = await mkdtemp(join(desktopRoot, '.m2-ui-scene-layout-'));
const evidence = process.env.SCENE_LAYOUT_EVIDENCE
  ? resolve(process.env.SCENE_LAYOUT_EVIDENCE)
  : await mkdtemp(join(tmpdir(), 'unicomp-scene-layout-'));
await mkdir(evidence, { recursive: true });

const fixture = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {SceneWorkspace} from '/src/SceneWorkspace';
import {ShotWorkspace} from '/src/ShotWorkspace';
import '/src/styles.css';
const params=new URLSearchParams(location.search);
const count=Number(params.get('cast')??3);
const documents=['二狗','赵德财','王铁蛋','李四','张三','路人','赵家大宅门口'].map((title,i)=>({id:'doc'+i,projectId:'fixture',kind:i<6?'character':'scene',title,scopeType:'project',lifecycleStatus:'active',rowVersion:1,createdAt:'now',updatedAt:'now'}));
const assets=documents.map((d,i)=>({id:'image'+i,projectId:'fixture',kind:d.kind,relativePath:'assets/'+i+'.png',alias:d.title+'参考图',sizeBytes:10,contentHash:'h'+i,createdAt:'now'}));
const scene={id:'scene',projectId:'fixture',title:'第一场',position:0,rowVersion:1,createdAt:'now',updatedAt:'now',sceneDocumentId:'doc6',videoPrompt:'日外，父子在大宅门口对峙。',characterBindings:documents.slice(0,count).map(d=>({characterDocumentId:d.id}))};
window.fixture={documents,assets};
const noop=()=>{};
createRoot(document.getElementById('root')).render(
  <div style={{height:'100vh',display:'flex',flexDirection:'column',padding:16}}>
    <div className="workspace-toolbar"><h1>场次与镜头</h1></div>
    <div className="directory-layout"><aside className="directory-index"><span>第一场</span></aside><div className="directory-pane">
    {params.get('mode')==='shot'?<ShotWorkspace projectId="fixture" shotId="shot" scene={scene} sceneDocumentId="doc6" shotTitle="镜头一" shotPosition={0} shotStatus="草稿" prompt="人物中景" writable assets={[]} documents={documents} storyboardTitle="分镜" storyboardContent="说明" storyboardBusy={false} hasStoryboard onPromptChange={noop} onSavePrompt={noop} onGenerateImage={noop} onGenerateVideo={noop} onStoryboardTitleChange={noop} onStoryboardContentChange={noop} onSaveStoryboard={noop}/>:<SceneWorkspace projectId="fixture" scene={scene} prompt={scene.videoPrompt} bindings={[]} documents={documents} assets={[]} writable onPromptChange={noop} onSave={noop} onGenerateVideo={noop}/>}
    </div></div>
  </div>
);
`;
let server;
let browser;
const report = [];
const errors = [];
try {
  await writeFile(
    join(fixtureRoot, 'index.html'),
    '<!doctype html><html lang="zh"><meta charset="utf-8"><div id="root"></div><script type="module" src="./fixture.tsx"></script></html>',
  );
  await writeFile(join(fixtureRoot, 'fixture.tsx'), fixture);
  server = await createServer({
    root: desktopRoot,
    configFile: join(desktopRoot, 'vite.config.ts'),
    server: { host: '127.0.0.1', port: 0, strictPort: false },
    logLevel: 'error',
  });
  await server.listen();
  const address = server.httpServer.address();
  assert(address && typeof address === 'object');
  browser = await chromium.launch({
    headless: true,
    executablePath:
      process.env.SCENE_LAYOUT_BROWSER_EXECUTABLE ??
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  });
  const page = await browser.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/worker-rpc', async (route) => {
    const request = route.request().postDataJSON();
    const data = await page.evaluate(() => window.fixture);
    let result = [];
    if (request.method === 'scene.media.resolve') {
      await new Promise((done) => setTimeout(done, 50));
      result = {
        assets: data.assets,
        voices: [],
        characters: request.params.characterDocumentIds.map((id) => ({
          characterDocumentId: id,
          defaultImage: data.assets[data.documents.findIndex((d) => d.id === id)],
        })),
      };
    } else if (request.method === 'asset.list')
      result = request.params.sourceDocumentId ? [data.assets[6]] : [];
    else if (['asset.thumbnail', 'asset.mediaSource'].includes(request.method))
      result = {
        assetId: request.params.assetId,
        path: 'D:/fixture.png',
        contentType: 'image/png',
      };
    else if (request.method === 'dubbing.scene.get')
      result = { sceneId: 'scene', cues: [], voices: [], audioFiles: [], jobs: [] };
    else if (request.method === 'dubbing.runtime.get')
      result = { available: true, nativeAvailable: false };
    else if (request.method === 'shot.continuity.get') result = null;
    else
      assert(
        ['audio.list', 'provider.profile.list'].includes(request.method),
        `Unexpected Worker method: ${request.method}`,
      );
    await route.fulfill({
      json: { id: request.id, protocolVersion: request.protocolVersion, ok: true, result },
    });
  });
  await page.route('**/worker-media/**', async (route) => {
    await new Promise((done) => setTimeout(done, 80));
    const wide = route.request().url().includes('image1');
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="${wide ? 960 : 360}" height="${wide ? 360 : 960}"><rect width="100%" height="100%" fill="#537044"/><rect x="8" y="8" width="${wide ? 944 : 344}" height="${wide ? 344 : 944}" fill="none" stroke="#e1d7a0" stroke-width="8"/></svg>`,
    });
  });
  async function check(label, mode) {
    const layout = await page.evaluate((mode) => {
      const workspace = document.querySelector(
        mode === 'scene' ? '.scene-workspace' : '.shot-workspace',
      );
      const rect = (element) => {
        const r = element.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
      };
      const panel = workspace.querySelector('.shot-reference-panel');
      return {
        pageOverflow: document.documentElement.scrollWidth > innerWidth,
        panel: rect(panel),
        blocks: [...workspace.children]
          .filter((e) => e.getBoundingClientRect().height > 0)
          .map(rect),
        cards: [...panel.querySelectorAll('.shot-reference-slot')].map(rect),
        clientHeight: workspace.clientHeight,
        scrollHeight: workspace.scrollHeight,
      };
    }, mode);
    assert.equal(layout.pageOverflow, false, `${label}: horizontal overflow`);
    for (let i = 1; i < layout.blocks.length; i++)
      assert(
        layout.blocks[i].top >= layout.blocks[i - 1].bottom - 1,
        `${label}: adjacent sections overlap`,
      );
    assert(
      layout.cards.every((card) => card.bottom <= layout.panel.bottom + 1),
      `${label}: reference cards overflow their section`,
    );
    for (let i = 0; i < layout.cards.length; i++)
      for (let j = i + 1; j < layout.cards.length; j++) {
        const a = layout.cards[i];
        const b = layout.cards[j];
        assert(
          a.right <= b.left + 1 ||
            b.right <= a.left + 1 ||
            a.bottom <= b.top + 1 ||
            b.bottom <= a.top + 1,
          `${label}: reference cards overlap`,
        );
      }
    assert(layout.scrollHeight > layout.clientHeight, `${label}: missing vertical scroll`);
    report.push({ label, ...layout });
  }
  async function loadReferencePreviews(count) {
    await page.waitForFunction(
      (expected) =>
        document.querySelectorAll('.shot-reference-slot .asset-image-preview').length === expected,
      count,
    );
    // Previews outside the viewport intentionally wait for intersection before loading.
    for (const preview of await page.locator('.shot-reference-slot .asset-image-preview').all()) {
      await preview.scrollIntoViewIfNeeded();
      await preview.locator('img').waitFor();
    }
    await page.waitForFunction(
      (expected) =>
        document.querySelectorAll('.shot-reference-slot img').length === expected &&
        [...document.querySelectorAll('.shot-reference-slot img')].every(
          (img) => img.complete && img.naturalWidth > 0,
        ),
      count,
    );
  }
  for (const mode of ['scene', 'shot'])
    for (const cast of [3, 5])
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 1280, height: 720 },
        { width: 390, height: 844 },
        { width: 1440, height: 600 },
      ]) {
        await page.setViewportSize(viewport);
        const label = `${mode}-${cast}-${viewport.width}x${viewport.height}`;
        await page.goto(
          `http://127.0.0.1:${address.port}/${basename(fixtureRoot)}/?cast=${cast}&mode=${mode}`,
        );
        await loadReferencePreviews(cast + 1);
        await check(label, mode);
        if (mode === 'scene') {
          await page.getByRole('button', { name: '打开配音', exact: true }).click();
          await page
            .getByText('远程配音与口型处理需要桌面应用；可先编辑台词和试听已有结果。', {
              exact: true,
            })
            .waitFor();
          await check(`${label}-dubbing-expanded`, mode);
          await page.getByRole('button', { name: '收起配音', exact: true }).click();
        }
        await page.getByLabel('选择出场角色', { exact: true }).selectOption(`doc${cast}`);
        await page.getByRole('button', { name: '添加角色', exact: true }).click();
        await loadReferencePreviews(cast + 2);
        await check(`${label}-added-character`, mode);
        if (cast === 3) {
          await page
            .getByRole('heading', { name: '参考资料', exact: true })
            .scrollIntoViewIfNeeded();
          await page.screenshot({ path: join(evidence, `${label}.png`) });
          const workspace = page.locator(mode === 'scene' ? '.scene-workspace' : '.shot-workspace');
          await workspace.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          const visibleEnd = await workspace.evaluate((element) => ({
            viewport: element.getBoundingClientRect().bottom,
            content: element.lastElementChild.getBoundingClientRect().bottom,
          }));
          assert(
            visibleEnd.content <= visibleEnd.viewport + 1,
            `${label}: last section cannot be reached by scrolling`,
          );
          await page.screenshot({ path: join(evidence, `${label}-bottom.png`) });
        }
      }
  assert.deepEqual(errors, []);
  await writeFile(
    join(evidence, 'report.json'),
    JSON.stringify({ checks: report.length, report, errors }, null, 2),
  );
  console.log(JSON.stringify({ checks: report.length, evidence, errors }));
} finally {
  await browser?.close();
  await server?.close();
  // Remove only the temporary fixture directory created by this run.
  const child = relative(desktopRoot, fixtureRoot);
  assert(
    !child.startsWith(`..${sep}`) &&
      !child.includes(sep) &&
      child.startsWith('.m2-ui-scene-layout-'),
  );
  await rm(fixtureRoot, { recursive: true, force: true });
}
