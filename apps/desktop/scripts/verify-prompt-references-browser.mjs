import assert from 'node:assert/strict';
/* global document, window */
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, transformWithEsbuild } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidence = resolve(process.argv[2] ?? resolve(root, '../../../.m2-ui-prompt-references'));
const runtimePackages = process.env.PROMPT_BROWSER_NODE_MODULES;
if (!runtimePackages)
  throw new Error('Set PROMPT_BROWSER_NODE_MODULES to the bundled runtime package directory.');
const require = createRequire(import.meta.url);
const { chromium } = require(require.resolve('playwright', { paths: [runtimePackages] }));
const harness = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {PromptReferenceEditor} from '/src/PromptReferenceEditor.tsx';
import {canonicalPromptParameters,promptReferences,updatePromptParameter} from '/src/prompt-references.ts';
import '/src/styles.css';
const image=(color,shape)=>'data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="'+color+'"/>'+shape+'</svg>');
const a={type:'reference_image',url:image('#79748f','<circle cx="32" cy="24" r="12" fill="#f0d4c1"/><path d="M12 64Q12 36 32 36Q52 36 52 64" fill="#292f41"/>')};
const b={type:'reference_image',url:image('#658189','<path d="M0 64L20 12L38 46L50 21L64 64" fill="#223c42"/>')};
const audio={type:'reference_audio',url:'https://example.invalid/voice.wav'};
const adapter={contractId:'cn.qwen.wan3-0-video',contractRevision:3,parameterSchema:{properties:{prompt:{type:'string'},media:{type:'array'}}}};
const initial={prompt:'图片 1 是侠客，图片 2 是雨夜客栈场景参考，音频1 是侠客声音参考。极简主义写实中国武侠电影，真实自然光、真实人体，克制表演，大面积留白，低饱和、高动态范围。\\n镜头跟随她回身，雨丝与发梢上的水珠反射冷光。',media:[a,b,audio]};
function App(){
const [parameters,setParameters]=useState(()=>JSON.parse(localStorage.getItem('prompt-test-draft')??'null')??initial);
const [submitted,setSubmitted]=useState();
const refs=promptReferences(adapter,parameters);
return <main style={{maxWidth:760,margin:'40px auto',padding:24}}>
<h2>提示词 · 素材引用</h2><p>正文中直接引用图片和声音，可插入、删除或移动标签。</p>
<PromptReferenceEditor label="提示词" value={parameters.prompt} references={refs} maxLength={5000} onChange={prompt=>setParameters(current=>({...current,prompt}))}/>
<div style={{display:'flex',gap:12,marginTop:16,flexWrap:'wrap'}}>
<button onClick={()=>setParameters(current=>updatePromptParameter(adapter,current,'media',[current.media[1],current.media[0],...current.media.slice(2)]))}>交换图片</button>
<button onClick={()=>setParameters(current=>updatePromptParameter(adapter,current,'media',current.media.slice(1)))}>移除第一张图片</button>
<button onClick={()=>localStorage.setItem('prompt-test-draft',JSON.stringify(parameters))}>保存草稿</button>
<button onClick={()=>setSubmitted(canonicalPromptParameters(parameters,refs))}>提交生成</button>
</div><output id="parameters" style={{display:'none'}}>{JSON.stringify(parameters)}</output><output id="submitted" style={{display:'none'}}>{JSON.stringify(submitted)}</output>
</main>};createRoot(document.getElementById('root')).render(<App/>);
`;
const server = await createServer({
  root,
  configFile: false,
  esbuild: { jsx: 'automatic' },
  server: { host: '127.0.0.1', port: 0 },
  plugins: [
    {
      name: 'prompt-reference-harness',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== '/__prompt-test.html') return next();
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.end(
            '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/></head><body><div id="root"></div><script type="module" src="/__prompt-test.tsx"></script></body></html>',
          );
        });
      },
      resolveId(id) {
        if (id === '/__prompt-test.tsx') return '\0prompt-test.tsx';
      },
      async load(id) {
        if (id === '\0prompt-test.tsx')
          return (
            await transformWithEsbuild(harness, 'prompt-test.tsx', {
              loader: 'tsx',
              jsx: 'automatic',
            })
          ).code;
      },
    },
  ],
});
let browser;
try {
  await mkdir(evidence, { recursive: true });
  await server.listen();
  const address = server.httpServer.address();
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({
    viewport: { width: 1040, height: 700 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + address.port + '/__prompt-test.html');
  const editor = page.getByRole('textbox', { name: '提示词' });
  await editor.locator('.prompt-reference-chip').first().waitFor();
  assert.equal(await editor.locator('.prompt-reference-chip').count(), 3);
  await page.screenshot({ path: resolve(evidence, 'inline-prompt-wide.png') });
  await page.setViewportSize({ width: 420, height: 720 });
  await page.screenshot({ path: resolve(evidence, 'inline-prompt-narrow.png') });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
  );
  await page.setViewportSize({ width: 1040, height: 700 });
  await editor.getByRole('button', { name: '放大查看图片 1' }).click();
  await page.getByRole('dialog', { name: '图片预览：图片 1' }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  const read = async () => JSON.parse(await page.locator('#parameters').textContent());
  const original = await read();
  await page.getByRole('button', { name: '交换图片' }).click();
  await page.waitForFunction(() =>
    JSON.parse(document.querySelector('#parameters').textContent).prompt.startsWith('图 2'),
  );
  assert.equal((await read()).media[0].url, original.media[1].url);
  assert.equal(
    await editor.locator('.prompt-reference-chip').first().getByRole('img').getAttribute('src'),
    original.media[0].url,
  );
  await page.getByRole('button', { name: '保存草稿' }).click();
  await page.reload();
  await editor.locator('.prompt-reference-chip').first().waitFor();
  assert.equal((await read()).media[0].url, original.media[1].url);
  await page.getByRole('button', { name: '提交生成' }).click();
  const submitted = JSON.parse(await page.locator('#submitted').textContent());
  assert.deepEqual(submitted, await read());
  assert.ok(!JSON.stringify(submitted).includes('data-reference-id'));
  // Real clipboard copy/cut/paste exercises chip text, selection and paragraph handling.
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' END');
  assert.ok((await read()).prompt.endsWith(' END'));
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Control+C');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(copied.includes('图 2'));
  assert.equal(copied, (await read()).prompt);
  await page.keyboard.press('Control+X');
  await page.waitForFunction(
    () => JSON.parse(document.querySelector('#parameters').textContent).prompt === '',
  );
  await page.keyboard.press('Control+V');
  await page.waitForFunction(
    () => document.querySelectorAll('.prompt-reference-input .prompt-reference-chip').length === 3,
  );
  await page.keyboard.press('Control+Z');
  await page.waitForFunction(
    () => JSON.parse(document.querySelector('#parameters').textContent).prompt === '',
  );
  await editor.click();
  await page.keyboard.type('start 图1 end');
  assert.equal((await read()).prompt, 'start 图 1 end');
  // Composition through Chromium's input protocol covers the WebView's IME path.
  await page.keyboard.press('Control+End');
  const cdp = await context.newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: '夜雨', selectionStart: 2, selectionEnd: 2 });
  await cdp.send('Input.insertText', { text: '夜雨' });
  assert.equal((await read()).prompt, 'start 图 1 end夜雨');
  await page.getByRole('button', { name: '插入素材' }).click();
  await page
    .getByRole('group', { name: '选择要引用的素材' })
    .getByRole('button', { name: '音频 1', exact: true })
    .click();
  assert.ok((await read()).prompt.includes('音频1'));
  // A media removal cannot transfer the old number to the remaining image.
  await page.getByRole('button', { name: '移除第一张图片' }).click();
  assert.ok(!(await read()).prompt.includes('图 1'));
  assert.equal(await editor.locator('.prompt-reference-chip.is-image').count(), 0);
  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('a图1b');
  assert.equal((await read()).prompt, 'a图 1b');
  await page.keyboard.press('ArrowLeft');
  await page.evaluate(
    () =>
      new Promise((done) => window.requestAnimationFrame(() => window.requestAnimationFrame(done))),
  );
  await page.keyboard.press('Backspace');
  assert.equal((await read()).prompt, 'ab');
  assert.equal((await read()).media.filter((item) => item.type === 'reference_image').length, 1);
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(evidence, 'verification.json'),
    JSON.stringify(
      {
        passed: true,
        checks: [
          'inline previews',
          'reorder identity',
          'draft reopen',
          'plain submission',
          'copy cut paste undo',
          'caret after token',
          'Chinese IME',
          'insertion',
          'deletion identity',
          'narrow layout',
        ],
        errors,
      },
      null,
      2,
    ),
  );
  process.stdout.write('Prompt reference browser checks passed. Evidence: ' + evidence + '\n');
} finally {
  await browser?.close();
  await server.close();
}
