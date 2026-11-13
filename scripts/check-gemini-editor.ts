// Local Chromium DOM/CSP regression check. No account, Gemini navigation or network requests.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { asset, PACKAGE_ROOT } from '../src/core/paths.ts';
import { spawnCaptured, saveJson } from '../src/core/fsutil.ts';

const exe = process.env.GEMINI_TEST_CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
if (!fs.existsSync(exe)) throw Error('Set GEMINI_TEST_CHROME to a Chromium executable. This check uses an isolated temporary profile.');
const source = fs.readFileSync(asset('node', 'gemini-bridge.cjs'), 'utf8');
const ast = ts.createSourceFile('bridge.cjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declaration = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'pageCommand');
if (!declaration) throw Error('pageCommand not found.');
const originGuard = "location.origin !== 'https://gemini.google.com'";
if (!declaration.getText(ast).includes(originGuard)) throw Error('Expected renderer origin guard not found.');
// Only this fixture substitutes its local origin. The installed guard is unchanged.
const command = declaration.getText(ast).replace(originGuard, "location.protocol !== 'file:'");
const long = Array.from({ length: 600 }, (_, i) => `${i}: dữ liệu giả <tag>&\" — alpha beta gamma delta`).join('\n');
const prompts = ['plain text', 'first\nsecond', 'Xin chào <script>&\"\r\n\r\n  x\t= 2\n',
  'spaces  stay   literal\n\nlast\n\n', '\nleading\n', '  \n\t\nend', long,
  'Emoji 🙂 tiếng Việt\n日本語 العربية <img src=x onerror="globalThis.injected=true">',
  'marker\n' + '漢字🙂<>&\t  '.repeat(8000)];
const root = path.join(PACKAGE_ROOT, '.tmp'); fs.mkdirSync(root, { recursive: true });
const dir = fs.mkdtempSync(path.join(root, 'gemini-editor-'));
const file = path.join(dir, 'fixture.html');
const script = `${command}\n(async () => {
  const editor = document.getElementById('editor'), results = [];
  for (const [index, prompt] of ${JSON.stringify(prompts).replaceAll('<', '\\u003c')}.entries()) {
    editor.replaceChildren();
    const start = performance.now();
    try {
      pageCommand('draft', prompt);
      await new Promise(resolve => setTimeout(resolve, 0));
      const actual = pageCommand('snapshot', {userIds: [], replyIds: []}).draft;
      results.push({index, chars: prompt.length, passed: actual === prompt.replace(/\\r\\n/g, '\\n') && !editor.querySelector('img, script') && !globalThis.injected, elapsedMs: Math.round(performance.now() - start)});
    } catch (error) { results.push({index, passed: false, error: error.message}); }
  }
  document.getElementById('result').textContent = JSON.stringify(results);
})();`;
fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-fixture'; style-src 'unsafe-inline'; require-trusted-types-for 'script'; trusted-types 'none'">
<div id="editor" role="textbox" contenteditable="true" style="white-space:pre-wrap"></div>
<button aria-label="Open mode picker, currently Flash-Lite"></button><pre id="result">pending</pre>
<script nonce="fixture">${script}</script>`);
const result = await spawnCaptured(exe, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--disable-gpu', '--user-data-dir=' + path.join(dir, 'profile'), '--virtual-time-budget=2000', '--dump-dom', pathToFileURL(file).href], { timeoutMs: 30_000 });
fs.writeFileSync(path.join(dir, 'chromium-stderr.log'), result.stderr);
const raw = /<pre id="result">([\s\S]*?)<\/pre>/.exec(result.stdout)?.[1];
let results: any[] | undefined;
try { results = JSON.parse(raw!.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&')); } catch {}
const report = { passed: result.ok && results?.length === prompts.length && results.every(value => value.passed), results, evidence: dir };
saveJson(path.join(dir, 'summary.json'), report);
console.log(JSON.stringify(report));
if (!report.passed) { console.error(result.stderr); process.exitCode = 1; }
