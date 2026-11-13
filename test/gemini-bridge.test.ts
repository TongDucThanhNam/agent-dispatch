import { test, expect } from 'bun:test';
import { digest, readArchive, patchArchive } from '../src/workers/gemini/archive.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { asset } from '../src/core/paths.ts';
import { patchGeminiQuietStartup, prepareGeminiBridge, installGeminiBridge } from '../src/workers/gemini/bridge.ts';
import { startGeminiBackground } from '../src/workers/gemini/desktop.ts';
import { rmTree } from './helpers.ts';

function fixture() {
  const json = Buffer.from(JSON.stringify({ files: { 'keep.txt': { size: 4, offset: '0' }, src: { files: {
    'main.js': { size: 4, offset: '4', executable: true }, 'native.node': { size: 20, unpacked: true, integrity: { hash: 'keep' } },
  } } } }));
  const head = Buffer.alloc(16 + Math.ceil(json.length / 4) * 4);
  head.writeUInt32LE(4, 0); head.writeUInt32LE(head.length - 8, 4); head.writeUInt32LE(head.length - 12, 8);
  head.writeUInt32LE(json.length, 12); json.copy(head, 16);
  return Buffer.concat([head, Buffer.from('keepmain')]);
}
test('ASAR append patch preserves unrelated files, unpacked metadata and executable bit', () => {
  const original = fixture(), patched = patchArchive(original, { 'src/main.js': 'new main\n', 'src/bridge.cjs': 'Tiếng Việt' });
  const before = readArchive(original), after = readArchive(patched);
  expect(after.read('keep.txt')).toEqual(before.read('keep.txt'));
  expect(after.entry('src/native.node')).toEqual(before.entry('src/native.node'));
  expect(after.entry('src/main.js').executable).toBe(true);
  expect(after.read('src/main.js').toString()).toBe('new main\n');
  expect(after.entry('src/bridge.cjs').integrity.hash).toBe(digest(after.read('src/bridge.cjs')));
  expect(before.read('src/main.js').toString()).toBe('main');
  expect(() => after.read('src/native.node')).toThrow('packed');
  expect(() => patchArchive(original, { '../outside': 'bad' })).toThrow('path');
  expect(() => readArchive(original.subarray(0, 20))).toThrow('header');
});

test('installer preparation bundles the shared safety module and dry-run leaves a synthetic app byte-identical', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-gemini-install-'));
  const exe = path.join(dir, 'Gemini.exe'), archivePath = path.join(dir, 'resources/app.asar');
  fs.mkdirSync(path.dirname(archivePath));
  const binary = Buffer.concat([Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'), Buffer.from([1, 6, 48, 48, 48, 48, 48, 48])]);
  const original = patchArchive(fixture(), { 'package.json': JSON.stringify({ name: 'gemini', main: 'src/main.js', version: '1.18.0' }),
    'src/main.js': 'new electron.BaseWindow({title:"Gemini",show:true}); // gemini:notify-turn-lifecycle https://gemini.google.com' });
  fs.writeFileSync(exe, binary); fs.writeFileSync(archivePath, original);
  try {
    const plan = prepareGeminiBridge(exe), archive = readArchive(plan.patched);
    expect(archive.read('src/gemini-safety.cjs')).toEqual(fs.readFileSync(asset('node', 'gemini-safety.cjs')));
    expect(archive.read('src/agent_dispatch_bridge.cjs')).toEqual(fs.readFileSync(asset('node', 'gemini-bridge.cjs')));
    expect(archive.read('keep.txt').toString()).toBe('keep');
    expect((await installGeminiBridge(exe, true)).dryRun).toBe(true);
    expect(fs.readFileSync(archivePath)).toEqual(original); expect(fs.readFileSync(exe)).toEqual(binary);
  } finally { rmTree(dir); }
});

function runtimeFixture(electron: any = {}, extra: any = {}) {
  const listeners = new Map(), require = createRequire(import.meta.url);
  const sandbox: any = { Buffer, URL, process, setTimeout, clearTimeout, console, ...extra,
    require: (name: string) => name === 'electron' ? {
      app: { whenReady: () => new Promise(() => {}), on() {} },
      ipcMain: { on: (name, handler) => listeners.set(name, handler) },
      ...electron,
    } : name === './gemini-safety.cjs' ? require(asset('node', 'gemini-safety.cjs')) : require(name) };
  vm.runInNewContext(fs.readFileSync(asset('node', 'gemini-bridge.cjs'), 'utf8') + `\n;globalThis.testApi = {
    matchesUserTurn, completedReply, handle, token, selectModel, menuItem, createWorker,
    configure: () => { server = { address: () => ({port:12345}) }; },
    markSeen: id => seen.add(id),
    setActive: value => { active=value; },
    cleanup: () => disposeWorker(),
    retain: sessionId => retainWorker(sessionId),
    contextFor: wc => commandContexts.get(wc),
    resources: () => ({ cleanupWarnings, lastCleanupMs, workerOpen: !!worker, workerIdle: !!worker?.idle, turns: worker?.turns ?? 0, selecting }),
  };`, sandbox);
  sandbox.testApi.configure(); return sandbox.testApi;
}

test('Gemini ownership accepts only the exact prompt or its observed accessibility duplicate', () => {
  const api = runtimeFixture(), prompt = 'Một dòng\nDòng thứ hai';
  expect(api.matchesUserTurn(prompt, prompt)).toBe(true);
  expect(api.matchesUserTurn('Bạn đã nói ' + prompt + '\n\n' + prompt, prompt)).toBe(true);
  expect(api.matchesUserTurn('an unrelated message\n' + prompt, prompt)).toBe(false);
  expect(api.completedReply({text:'partial',busy:'true',complete:true})).toBe(false);
  expect(api.completedReply({text:'quiet but unfinished',busy:'false',complete:false})).toBe(false);
  expect(api.completedReply({text:'',busy:'false',complete:true})).toBe(false);
  expect(api.completedReply({text:'done',busy:'false',complete:true})).toBe(true);
});

test('Gemini --hide starts hidden at construction and leaves normal manual launches unchanged', () => {
  const original='new electron.BaseWindow({title:"Gemini",show:!0}); new electron.BaseWindow({title:"Other",show:true});';
  const patched=patchGeminiQuietStartup(original);
  for(const hidden of [false,true]){
    const windows:any[]=[];
    vm.runInNewContext(patched,{process:{argv:hidden?['Gemini.exe','--hide']:['Gemini.exe']},electron:{BaseWindow:class{constructor(opts){windows.push(opts);}}}});
    expect(windows.map(w=>w.show)).toEqual([!hidden,true]);
  }
  expect(()=>patchGeminiQuietStartup('new e.BaseWindow({title:"Other",show:true})')).toThrow('Unsupported');
  expect(()=>patchGeminiQuietStartup(original+original)).toThrow('Unsupported');
});

test('quiet startup reuses the live bridge and never relaunches an unready running app', async () => {
  let spawns=0;
  const spawn=()=>{spawns++;throw Error('Unexpected activation.');};
  expect(await startGeminiBackground({}, {probe:async()=>({ready:true,capabilities:['non-activating-window']}),spawn})).toMatchObject({ready:true,started:false});
  await expect(startGeminiBackground({}, {probe:async()=>{throw Error('unready');},prepare:()=>({unchanged:true,exe:'C:/Gemini/Gemini.exe'}),
    processes:async()=>[{exe:'C:/Gemini/Gemini.exe'}],spawn})).rejects.toThrow('will not be relaunched or focused');
  expect(spawns).toBe(0);
});

test('cold quiet startup uses the verified real executable with --hide, not the activating launcher', async () => {
  let probes=0, invocation:any;
  const result=await startGeminiBackground({}, {probe:async()=>{if(++probes===1)throw Error('not running');return{ready:true,capabilities:['non-activating-window']};},
    prepare:()=>({unchanged:true,exe:'C:/Gemini/app-1.18.0/Gemini.exe'}),processes:async()=>[{exe:'C:/Gemini/app-1.18.0/GeminiAppLauncher.exe'}],readManifest:()=>({pid:123}),
    spawn:(...args)=>{invocation=args;return{pid:123,once(){},unref(){}};}});
  expect(result).toMatchObject({ready:true,started:true});
  expect(invocation[0]).toBe('C:/Gemini/app-1.18.0/Gemini.exe');
  expect(invocation[1]).toEqual(['--hide']);
  expect(invocation[2]).toMatchObject({windowsHide:true,shell:false,detached:true,stdio:'ignore'});
});

test('selection uses a hidden non-focusable worker and never opens menus in the main view', async () => {
  const windows:any[]=[];let destroyed=false;
  const source={isDestroyed:()=>false,getURL:()=> 'https://gemini.google.com/app',getLastWebPreferences:()=>({preload:'preload.js'}),session:{},getUserAgent:()=> 'Gemini',
    executeJavaScript:()=>{throw Error('Main view must not be touched.');}};
  const wc={isDestroyed:()=>destroyed,getURL:()=> 'https://gemini.google.com/app',setUserAgent(){},setWindowOpenHandler(){},on(){},loadURL:async()=>{},
    debugger:{attach(){},sendCommand:async()=>{}},isOffscreen:()=>true,setFrameRate(){},startPainting(){},stopPainting(){},close(){destroyed=true;},executeJavaScript:async(code:string)=>{
      const [action]=JSON.parse('['+code.slice(code.lastIndexOf('})(')+3,-1)+']');
      if(action==='snapshot')return{ready:true,users:[],replies:[]};
      return{items:[{text:'4 Argon',selected:true}]};
    }};
  const api=runtimeFixture({webContents:{getAllWebContents:()=>[source]},BaseWindow:class{
    constructor(opts){windows.push(opts);}contentView={addChildView(){}};isFocusable(){return false;}isVisible(){return false;}isDestroyed(){return destroyed;}destroy(){destroyed=true;}
  },WebContentsView:class{webContents=wc;setBounds(){}}});
  let result:any;
  await api.handle({method:'GET',url:'/selection',headers:{host:'127.0.0.1:12345','x-agent-dispatch-token':api.token}},
    {writeHead:code=>{expect(code).toBe(200);},end:text=>{result=JSON.parse(text);}});
  expect(windows).toHaveLength(1);expect(windows[0]).toMatchObject({show:false,focusable:false,skipTaskbar:true});
  expect(result.background).toBe(true);expect(destroyed).toBe(true);
});

test('resume readiness accepts an idle user-only chat, but waits for the requested history', async () => {
  const target = 'https://gemini.google.com/app/1234567890abcdef';
  let reads = 0;
  const source = { isDestroyed: () => false, getURL: () => 'https://gemini.google.com/app',
    getLastWebPreferences: () => ({}), session: {}, getUserAgent: () => 'Gemini' };
  const wc = { isDestroyed: () => false, getURL: () => target, setUserAgent() {}, setWindowOpenHandler() {}, on() {}, loadURL: async () => {},
    debugger: { attach() {}, sendCommand: async () => {} }, isOffscreen: () => true, setFrameRate() {}, startPainting() {}, close() {},
    executeJavaScript: async () => ({ ready: true, url: ++reads === 1 ? 'https://gemini.google.com/app' : target,
      users: reads === 2 ? [] : [{ id: 'user-query-content-old' }], replies: [] }) };
  const api = runtimeFixture({ webContents: { getAllWebContents: () => [source] }, BaseWindow: class {
    contentView = { addChildView() {} }; isFocusable() { return false; } isVisible() { return false; } isDestroyed() { return false; } destroy() {}
  }, WebContentsView: class { webContents = wc; setBounds() {} } });
  const result = await api.createWorker(target);
  expect(reads).toBe(3); expect(result.snapshot.users).toHaveLength(1); expect(result.snapshot.replies).toEqual([]);
});

function backgroundRuntime(overrides: any = {}) {
  const calls: any[] = [], loads: string[] = [], listeners = new Map<string, any>();
  let destroyed = false;
  let currentURL = 'https://gemini.google.com/app';
  const source = { isDestroyed: () => false, getURL: () => 'https://gemini.google.com/app',
    getLastWebPreferences: () => ({}), session: {}, getUserAgent: () => 'Gemini' };
  const wc = { isDestroyed: () => destroyed, getURL: () => currentURL, setUserAgent() {}, setWindowOpenHandler() {},
    on: (name, callback) => listeners.set(name, callback), loadURL: async (url: string) => { calls.push('load'); loads.push(url); await overrides.load?.({ url, listeners, calls }); currentURL = url; },
    debugger: { attach() {}, isAttached: () => true, sendCommand: async (name: string) => { calls.push(name); await overrides.debug?.(name); } },
    isOffscreen: () => true, setFrameRate: fps => calls.push(['fps', fps]), startPainting: () => calls.push('paint'), stopPainting: () => calls.push('stop-paint'),
    close: () => { calls.push('close'); if (overrides.closeThrows) throw Error('Synthetic close failure.'); destroyed = true; },
    executeJavaScript: async () => ({ ready: true, url: currentURL, users: currentURL.includes('/app/') ? [{ id: 'user-query-content-old' }] : [], replies: [] }) };
  const api = runtimeFixture({ webContents: { getAllWebContents: () => [source] }, BaseWindow: class {
    contentView = { addChildView() {} }; isFocusable() { return false; } isVisible() { return false; } isDestroyed() { return false; }
    destroy() { calls.push('destroy-window'); }
  }, WebContentsView: class { webContents = { ...wc }; constructor() { destroyed = false; } setBounds() {} } }, overrides.extra);
  return { api, calls, loads, wc };
}

test('one transient pre-send navigation failure is retried, with action/stage diagnostics', async () => {
  let loads = 0;
  const state = backgroundRuntime({ load: () => { if (++loads === 1) throw Object.assign(Error('ERR_FAILED (-2) loading test'), { code: 'ERR_FAILED', errno: -2 }); } });
  const events: any[] = [];
  await state.api.createWorker('https://gemini.google.com/app', { stage: 'readiness', deadline: Date.now() + 60_000,
    res: { destroyed: false, write: line => events.push(JSON.parse(line)) } });
  expect(loads).toBe(2);
  expect(events.filter(event => event.action === 'navigate').map(event => event.outcome)).toEqual(['read-retry', 'ok']);
  await state.api.cleanup();
});

test('worker uses bounded low-rate painting and garbage-collects only its own renderer before close', async () => {
  const state = backgroundRuntime();
  await state.api.createWorker('https://gemini.google.com/app');
  expect(state.calls).toContainEqual(['fps', 5]);
  await state.api.cleanup();
  expect(state.calls.slice(-5)).toEqual(['stop-paint', 'load', 'HeapProfiler.collectGarbage', 'close', 'destroy-window']);
  expect(state.api.resources()).toMatchObject({ cleanupWarnings: 0, workerOpen: false });
});

test('blocked authentication redirects and repeated navigation failures never loop or send', async () => {
  for (const blocked of [false, true]) {
    let loads = 0;
    const state = backgroundRuntime({ load: ({ listeners }) => {
      loads++;
      if (blocked) listeners.get('will-redirect')({ preventDefault() {} }, 'https://accounts.google.com/login');
      throw Object.assign(Error('ERR_FAILED (-2) loading test'), { code: 'ERR_FAILED', errno: -2 });
    } });
    await expect(state.api.createWorker('https://gemini.google.com/app')).rejects.toThrow(blocked ? 'trusted origin' : 'navigation failed');
    expect(loads).toBe(blocked ? 1 : 2);
    expect(state.calls.includes('paint')).toBe(false);
    await state.api.cleanup();
  }
});

test('cancelled preparation starts no navigation, and close failure still destroys the native window', async () => {
  const cancelled = backgroundRuntime();
  await expect(cancelled.api.createWorker('https://gemini.google.com/app', { cancel: true })).rejects.toThrow('cancelled');
  expect(cancelled.calls).toEqual([]);
  const broken = backgroundRuntime({ closeThrows: true });
  await broken.api.createWorker('https://gemini.google.com/app'); await broken.api.cleanup();
  expect(broken.calls.at(-1)).toBe('destroy-window');
  expect(broken.api.resources()).toMatchObject({ cleanupWarnings: 1, workerOpen: false });
});

test('cancellation interrupts an unresolved load and suppresses a scheduled navigation retry', async () => {
  for (const transient of [false, true]) {
    const context = { cancel: false, deadline: Date.now() + 60_000, res: { destroyed: false, write() {} } };
    let loads = 0;
    const state = backgroundRuntime({ load: () => {
      loads++; setTimeout(() => { context.cancel = true; }, 20);
      if (transient) throw Object.assign(Error('ERR_FAILED (-2) loading test'), { code: 'ERR_FAILED' });
      return new Promise(() => {});
    } });
    const started = Date.now();
    await expect(state.api.createWorker('https://gemini.google.com/app', context)).rejects.toThrow('cancelled');
    expect(loads).toBe(1); expect(Date.now() - started).toBeLessThan(1500);
    await state.api.cleanup(); expect(state.api.resources().workerOpen).toBe(false);
  }
});

test('an unresponsive renderer collector cannot hold the bridge worker lock indefinitely', async () => {
  const state = backgroundRuntime({ debug: name => name === 'HeapProfiler.collectGarbage' ? new Promise(() => {}) : undefined });
  await state.api.createWorker('https://gemini.google.com/app');
  const started = Date.now(); await state.api.cleanup();
  expect(Date.now() - started).toBeLessThan(4500);
  expect(state.api.resources()).toMatchObject({ cleanupWarnings: 1, workerOpen: false });
  expect(state.calls.at(-1)).toBe('destroy-window');
});

test('only the same explicit conversation reuses an idle worker, without retaining old run contexts', async () => {
  const state = backgroundRuntime(), target = 'https://gemini.google.com/app/1234567890abcdef';
  const context = () => ({ deadline: Date.now() + 60_000, res: { destroyed: false, write() {} } });
  const first = await state.api.createWorker(target, context());
  await state.api.retain('gemini_1234567890abcdef');
  expect(state.api.contextFor(first.wc)).toBeUndefined();
  expect(state.api.resources()).toMatchObject({ workerOpen: true, workerIdle: true, turns: 1 });
  const nextContext = context(), next = await state.api.createWorker(target, nextContext);
  expect(next.wc).toBe(first.wc); expect(state.loads).toEqual([target]);
  expect(state.api.contextFor(next.wc)).toBe(nextContext);
  await state.api.retain('gemini_1234567890abcdef');
  const fresh = await state.api.createWorker('https://gemini.google.com/app', context());
  expect(fresh.wc).not.toBe(first.wc);
  expect(state.loads).toEqual([target, 'about:blank', 'https://gemini.google.com/app']);
  await state.api.cleanup(); expect(state.api.resources().workerOpen).toBe(false);
});

test('idle expiry serializes cleanup and releases its cached worker without a model request', async () => {
  let expire!: () => void;
  const idleTimer = { unref() {} };
  const state = backgroundRuntime({ extra: {
    setTimeout: (callback, ms) => { if (ms === 30_000) { expire = callback; return idleTimer; } return setTimeout(callback, ms); },
    clearTimeout: timer => { if (timer !== idleTimer) clearTimeout(timer); },
  } });
  await state.api.createWorker('https://gemini.google.com/app/1234567890abcdef');
  await state.api.retain('gemini_1234567890abcdef');
  expire(); expect(state.api.resources().selecting).toBe(true);
  for (let i = 0; i < 100 && state.api.resources().selecting; i++) await Bun.sleep(1);
  expect(state.api.resources()).toMatchObject({ workerOpen: false, selecting: false, cleanupWarnings: 0 });
  expect(state.loads.at(-1)).toBe('about:blank');
});

test('a retained renderer is rotated after 32 confirmed leases instead of growing without a bound', async () => {
  const state = backgroundRuntime(), target = 'https://gemini.google.com/app/1234567890abcdef';
  let last: any;
  for (let i = 0; i < 32; i++) {
    last = await state.api.createWorker(target);
    await state.api.retain('gemini_1234567890abcdef');
  }
  expect(state.loads).toEqual([target]); expect(state.api.resources().turns).toBe(32);
  const rotated = await state.api.createWorker(target);
  expect(rotated.wc).not.toBe(last.wc);
  expect(state.loads).toEqual([target, 'about:blank', target]);
  await state.api.cleanup();
});

test('Gemini selects and reads back model plus thinking level, never trusting only the toolbar label', async () => {
  const api = runtimeFixture();
  let model='3.8 Flash', effort='Thấp', submenu=false;
  const actions:string[]=[];
  const wc = { isDestroyed:()=>false, getURL:()=> 'https://gemini.google.com/app', executeJavaScript:async(code:string)=>{
    const [action,value]=JSON.parse('['+code.slice(code.lastIndexOf('})(')+3,-1)+']');
    actions.push(action+':'+value);
    if(action==='status')return{model:'Argon Cao'};
    if(action==='menu-click'){
      if(value==='4 Argon'){model=value;submenu=false;}
      if(value==='Cấp độ tư duy')submenu=true;
      if(value==='Cao'){effort=value;submenu=false;}
    }
    if(action==='menu-close')submenu=false;
    return {items: submenu ? ['Thấp','Cao'].map(text=>({text,selected:text===effort})) :
      ['3.8 Flash','4 Argon','Cấp độ tư duy'].map(text=>({text,selected:text===model}))};
  }};
  expect(await api.selectModel(wc,'4 Argon','high')).toMatchObject({model:'4 Argon',effort:'high',effortLabel:'Cao',verified:true});
  expect(actions).toContain('menu-click:4 Argon');expect(actions).toContain('menu-click:Cao');
  expect(actions.filter(a=>a==='menu-click:Cấp độ tư duy')).toHaveLength(2);
  await expect(api.selectModel(wc,'Missing model','high')).rejects.toThrow('unavailable');
  expect(actions.some(a=>a.startsWith('send:'))).toBe(false);
  expect(()=>api.menuItem({items:[{text:'4 Argon Preview',selected:true}]},'4 Argon')).toThrow('unavailable');
});

test('Gemini secondary launches cannot overwrite the primary bridge manifest', async () => {
  const require = createRequire(import.meta.url);let ready:()=>void;
  vm.runInNewContext(fs.readFileSync(asset('node','gemini-bridge.cjs'),'utf8'),{Buffer,URL,process,setTimeout,clearTimeout,console,
    require:(name:string)=>name==='electron'?{app:{whenReady:()=>({then:fn=>{ready=fn;}}),hasSingleInstanceLock:()=>false,on(){}},ipcMain:{on(){}}}:
      name==='node:fs'?{mkdirSync(){throw Error('Secondary attempted to create a bridge directory.');}}:name==='./gemini-safety.cjs'?require(asset('node','gemini-safety.cjs')):require(name)});
  expect(()=>ready!()).not.toThrow();
});

test('Gemini bridge rejects browser origins, bad tokens, duplicate submissions and wrong stop ownership', async () => {
  const api = runtimeFixture();
  async function call(url, data, extra = {}) {
    const req = {method:'POST',url,headers:{host:'127.0.0.1:12345','x-agent-dispatch-token':api.token,...extra},
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(data)); }};
    let code = 0, body = '';
    await api.handle(req, {writeHead: n => {code=n;},end: s => {body=s;}});
    return {code,body:JSON.parse(body)};
  }
  expect((await call('/stop',{}, {origin:'https://gemini.google.com'})).code).toBe(403);
  expect((await call('/stop',{}, {'x-agent-dispatch-token':'x'.repeat(64)})).code).toBe(403);
  expect((await call('/stop',{}, {'x-agent-dispatch-token':'ế'.repeat(64)})).code).toBe(403);
  expect((await call('/eval',{})).code).toBe(404);
  const id='a'.repeat(32); api.markSeen(id);
  expect((await call('/run',{requestId:id,prompt:'once',model:'Flash',timeoutSeconds:30})).code).toBe(409);
  const unsafe = await call('/run', { requestId: 'c'.repeat(32), prompt: 'Authorization: Bearer synthetic', model: '4 Argon', effort: 'high', timeoutSeconds: 30 });
  expect(unsafe.code).toBe(400); expect(unsafe.body.error).toContain('[REDACTED]'); expect(unsafe.body.error).not.toContain('synthetic');
  const email = await call('/run', { requestId: 'd'.repeat(32), prompt: 'fixture@example.invalid', model: '4 Argon', effort: 'high', timeoutSeconds: 30 });
  expect(email.code).toBe(400); expect(email.body.error).toContain('email'); expect(email.body.error).not.toContain('fixture@');
  const active={request:{requestId:id},cancel:false};api.setActive(active);
  expect((await call('/run', { requestId: 'e'.repeat(32), prompt: 'once', model: '4 Argon', effort: 'high', timeoutSeconds: 30 })).code).toBe(409);
  expect((await call('/stop',{requestId:'b'.repeat(32)})).code).toBe(409);
  expect(active.cancel).toBe(false);
  expect((await call('/stop',{requestId:id})).code).toBe(200);
  expect(active.cancel).toBe(true);
});
