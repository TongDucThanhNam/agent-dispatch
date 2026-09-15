import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { registerRun, readRun, createCatalog, serveDashboard, proxyAction, ensureDashboard } from './dashboard.mjs';
import { openTelemetry } from './monitor-core.mjs';
import { servePanel } from './run.mjs';

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-trajectory-test-'));
const save = (file, data) => fs.writeFileSync(file, JSON.stringify(data));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(root, name, extra = {}) {
  const project = path.join(root, name), runDir = path.join(project, '.zcode-dispatch', name), now = Date.now();
  fs.mkdirSync(runDir, { recursive: true });
  const config = { runId: name, runDir, project, dbPath: path.join(project, 'data.sqlite'), expectedModel: 'test-model' };
  const state = { runId: name, startedAt: now, updatedAt: now, status: 'running', phase: 'working', workerExited: false,
    workerPid: process.pid, runnerPid: process.pid, sessionId: 'sess_' + name, tools: [], todos: [], notifications: {}, ...extra };
  save(path.join(runDir, 'config.json'), config); save(path.join(runDir, 'status.json'), state);
  return { config, state, runDir, write: () => save(path.join(runDir, 'status.json'), state) };
}
function database(config, now) {
  const db = new DatabaseSync(config.dbPath);
  db.exec(`CREATE TABLE session(id TEXT,directory TEXT,parent_id TEXT,time_created INTEGER,time_updated INTEGER);
    CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,time_updated INTEGER,data TEXT);
    CREATE TABLE todo(session_id TEXT,content TEXT,status TEXT,position INTEGER);
    CREATE TABLE model_usage(id TEXT,logical_request_id TEXT,attempt_index INTEGER,status TEXT,provider_id TEXT,model_id TEXT,started_at INTEGER,completed_at INTEGER,
      input_tokens INTEGER,output_tokens INTEGER,cache_read_input_tokens INTEGER,retry_count INTEGER,error_code TEXT,error_message TEXT,session_id TEXT);`);
  const sid = 'sess_' + config.runId;
  db.prepare('INSERT INTO session VALUES(?,?,?,?,?)').run(sid, config.project, null, now, now);
  const message = (id, role, at) => db.prepare('INSERT INTO message VALUES(?,?,?,?,?)').run(id,sid,at,at,JSON.stringify({role,modelID:'test-model',providerID:'test-provider'}));
  const part = (id, data, at, msg = 'assistant') => db.prepare('INSERT INTO part VALUES(?,?,?,?,?,?)').run(id,msg,sid,at,at,JSON.stringify(data));
  message('user','user',now); message('assistant','assistant',now+1);
  part('prompt',{type:'text',text:'PRIVATE_PROMPT'},now,'user'); part('reasoning',{type:'reasoning',text:'PRIVATE_REASONING'},now+2);
  part('tool',{type:'tool',tool:'Bash',state:{status:'running',input:{command:'PRIVATE_COMMAND'},output:'PRIVATE_OUTPUT',time:{start:now+3}}},now+3);
  db.prepare('INSERT INTO model_usage VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('req', 'logical',0,'completed','test-provider','test-model',now+1,now+2,100,25,80,0,null,null,sid);
  return { db, message, part, sid };
}

test('one registry contains multiple projects, filters terminal and dead jobs, and keeps selected completion inspectable', () => {
  const root = temp(), a = fixture(root,'first'), b = fixture(root,'second'), done = fixture(root,'done',{status:'ready_for_review',workerExited:true}), dead = fixture(root,'dead',{workerPid:1234,runnerPid:1235});
  const keyA=registerRun(a.runDir,root), keyB=registerRun(b.runDir,root); registerRun(done.runDir,root); registerRun(dead.runDir,root);
  assert.equal(registerRun(a.runDir,root),keyA);
  const catalog=createCatalog(root,{alive:pid=>pid===process.pid,telemetry:false});catalog.refresh();
  assert.deepEqual(new Set(catalog.snapshot().runs.map(x=>x.key)),new Set([keyA,keyB]));
  a.state.workerExited=true;a.state.status='ready_for_review';a.write();catalog.refresh();
  assert.deepEqual(catalog.snapshot().runs.map(x=>x.key),[keyB]);assert.equal(catalog.snapshot(keyA).selected.status,'ready_for_review');
  assert.equal(catalog.snapshot(keyA).selected.controlUrl,undefined);
});

test('offline runner and surviving worker remain explicitly unconfirmed; dead records never appear as running', () => {
  const root=temp(), f=fixture(root,'stale',{runnerPid:1234,updatedAt:Date.now()-80_000});
  const entry={key:registerRun(f.runDir,root),runDir:f.runDir};
  let run=readRun(entry,{alive:pid=>pid===process.pid,telemetry:false});assert.equal(run.active,true);assert.equal(run.status,'unconfirmed');assert.equal(run.canStop,false);
  run=readRun(entry,{alive:()=>false,telemetry:false});assert.equal(run.active,false);assert.equal(run.status,'monitor_offline');
});

test('trajectory associates the correct session, projects timing and usage, and never emits private transcript fields', () => {
  const root=temp(), f=fixture(root,'events'), {db,part,sid}=database(f.config,f.state.startedAt), reader=openTelemetry(f.config.dbPath);
  const query={...f.config,startedAt:f.state.startedAt,sessionId:sid,includeTrajectory:true};
  const initial=reader.read(query);assert.equal(initial.available,true);assert.equal(initial.trajectory.turns,1);assert.equal(initial.trajectory.toolCalls,1);
  assert.deepEqual(initial.trajectory.events.map(x=>x.kind),['input','model','tool']);
  const request=initial.trajectory.events.find(x=>x.kind==='model');assert.equal(request.inputTokens,100);assert.equal(request.endedAt-request.startedAt,1);
  assert.equal(initial.trajectory.events.find(x=>x.kind==='tool').endedAt,null);
  for(const secret of ['PRIVATE_PROMPT','PRIVATE_REASONING','PRIVATE_COMMAND','PRIVATE_OUTPUT'])assert.ok(!JSON.stringify(initial).includes(secret));
  db.prepare('UPDATE part SET data=? WHERE id=?').run(JSON.stringify({type:'tool',tool:'Bash',state:{status:'completed',time:{start:f.state.startedAt+3,end:f.state.startedAt+80}}}),'tool');
  part('compact',{type:'compaction'},f.state.startedAt+90);const next=reader.read(query);assert.equal(next.trajectory.events.find(x=>x.id==='part:tool').status,'completed');assert.equal(next.trajectory.events.at(-1).label,'Context compacted');
  assert.equal(reader.read({...query,project:root}).available,false);
  assert.equal(reader.read({...query,startedAt:f.state.startedAt+100_000}).trajectory.events.length,0);
  reader.close();db.close();
});

test('long trajectories retain the newest 2000 records and report full-session tool totals', () => {
  const root=temp(),f=fixture(root,'long'),{db,part,sid}=database(f.config,f.state.startedAt);
  db.exec('BEGIN');for(let i=0;i<2100;i++)part('extra'+i,{type:'tool',tool:'Read',state:{status:'completed',time:{start:f.state.startedAt+100+i,end:f.state.startedAt+101+i}}},f.state.startedAt+100+i);db.exec('COMMIT');
  const reader=openTelemetry(f.config.dbPath),info=reader.read({...f.config,startedAt:f.state.startedAt,sessionId:sid,includeTrajectory:true});reader.close();db.close();
  assert.equal(info.trajectory.events.length,2000);assert.equal(info.trajectory.truncated,true);assert.equal(info.trajectory.toolCalls,2101);assert.equal(info.trajectory.events.at(-1).id,'part:extra2099');
});

test('SSE streams new jobs and completion; token, Host and Origin boundaries are enforced', async () => {
  const root=temp(),a=fixture(root,'stream'),key=registerRun(a.runDir,root),catalog=createCatalog(root,{telemetry:false}),panel=await serveDashboard({root,catalog,pollMs:30});
  const abort=new AbortController();
  try {
    const response=await fetch(panel.url+'events?run='+key,{signal:abort.signal});assert.equal(response.headers.get('content-type'),'text/event-stream; charset=utf-8');
    const stream=response.body.getReader();let buffer='';
    async function next(predicate){for(let i=0;i<15;i++){const chunk=await stream.read();buffer+=new TextDecoder().decode(chunk.value);let end;while((end=buffer.indexOf('\n\n'))>=0){const item=buffer.slice(0,end);buffer=buffer.slice(end+2);const value=JSON.parse(item.slice(6));if(predicate(value))return value;}}throw new Error('Expected stream change missing.');}
    assert.equal((await next(x=>x.runs.length===1)).selected.key,key);
    const b=fixture(root,'stream2');registerRun(b.runDir,root);assert.equal((await next(x=>x.runs.length===2)).runs.length,2);
    a.state.workerExited=true;a.state.status='ready_for_review';a.write();assert.equal((await next(x=>x.runs.length===1)).selected.status,'ready_for_review');
    assert.equal((await fetch(new URL('/wrong/snapshot',panel.url))).status,404);
    assert.equal((await fetch(panel.url+'snapshot',{headers:{Origin:'https://example.com'}})).status,403);
    const hostStatus=await new Promise(resolve=>{const req=http.get(panel.url+'snapshot',{headers:{Host:'evil.example'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',()=>resolve(0));});assert.equal(hostStatus,403);
    assert.equal((await fetch(panel.url+'runs/'+key+'/stop',{method:'POST',headers:{Origin:'https://example.com'}})).status,403);
  } finally {abort.abort();await panel.close();}
});

test('dashboard actions go through the matching original runner and cannot stop a supplied PID or unrelated endpoint', async () => {
  let stopped=0;const panel=await servePanel({},()=>({runId:'owned'}),{stop:()=>{stopped++;return 'stopped';}});
  const run={runId:'owned',controlUrl:panel.url,canStop:true};
  try {await assert.rejects(proxyAction({...run,runId:'foreign'},'stop'),/identity/);assert.equal(stopped,0);
    await assert.rejects(proxyAction({...run,controlUrl:'http://example.com/'},'stop'),/Invalid/);
    await assert.rejects(proxyAction({...run,canStop:false},'stop'),/unavailable/);
    assert.equal((await proxyAction(run,'stop')).message,'stopped');assert.equal(stopped,1);
  } finally {await panel.close();}
});

test('concurrent dashboard clients reuse one service and a restart preserves its URL', async () => {
  const root=temp();let record;
  try {
    const records=await Promise.all([ensureDashboard(root),ensureDashboard(root)]);record=records[0];assert.equal(records[1].url,record.url);assert.equal(records[1].pid,record.pid);
    process.kill(record.pid);for(let i=0;i<50;i++){try{process.kill(record.pid,0);}catch{break;}await wait(50);}
    const restarted=await ensureDashboard(root);assert.equal(restarted.url,record.url);assert.notEqual(restarted.pid,record.pid);record=restarted;
  } finally {if(record){try{process.kill(record.pid);}catch{}}}
});

test('the launch CLI registers its new run and returns the common dashboard without model requests', async () => {
  const root=temp(),project=path.join(root,'project');fs.mkdirSync(project);const cliConfig=path.join(root,'cli.json'),brief=path.join(project,'brief.md'),adapter=path.join(root,'adapter.mjs'),launchConfig=path.join(root,'launch.json'),dashboardRoot=path.join(root,'dashboard');
  save(cliConfig,{model:'test-provider/test-model',provider:{'test-provider':{models:{'test-model':{}}}}});fs.writeFileSync(brief,'Fixture only.');
  fs.writeFileSync(adapter,"console.log(JSON.stringify({sessionId:'sess_fixture',response:'Fixture completed.'}));");
  save(launchConfig,{project,promptFile:brief,notify:false,reviewMode:'main-review',adapter,cliConfig,expectedModel:'test-model',expectedProvider:'test-provider',dbPath:path.join(root,'absent.sqlite'),keepOpenMs:0});
  const child=spawn(process.execPath,[fileURLToPath(new URL('./run.mjs',import.meta.url)),'launch','--config',launchConfig],{env:{...process.env,ZCODE_DASHBOARD_ROOT:dashboardRoot},shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='',error='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>error+=x);const [code]=await once(child,'close');
  let hub;try{assert.equal(code,0,error);const receipt=JSON.parse(output);assert.equal(receipt.dashboard,true);assert.match(receipt.url,/#run=[a-f0-9]{24}$/);hub=JSON.parse(fs.readFileSync(path.join(dashboardRoot,'hub.json'),'utf8'));
    assert.equal(fs.readdirSync(path.join(dashboardRoot,'runs')).length,1);assert.match(receipt.controlUrl,/127\.0\.0\.1/);
  }finally{if(hub){try{process.kill(hub.pid);}catch{}}}
});
