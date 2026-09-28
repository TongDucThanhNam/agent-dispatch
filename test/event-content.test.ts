import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readEventContent } from '../src/index.ts';
import { registerRun, createCatalog, serveDashboard } from '../src/index.ts';
import { rmTree } from './helpers.ts';

function fixture(t) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'zcode-content-')), dbPath = path.join(project, 'events.sqlite'), runDir = path.join(project, '.zcode-dispatch', 'sample');
  fs.mkdirSync(runDir, {recursive:true});
  const now = Date.now(), sid = 'sess_sample', db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE session(id TEXT,directory TEXT);
    CREATE TABLE message(id TEXT,session_id TEXT,time_created INTEGER,data TEXT);
    CREATE TABLE part(id TEXT,message_id TEXT,session_id TEXT,time_created INTEGER,data TEXT);
    CREATE TABLE model_usage(id TEXT,session_id TEXT,started_at INTEGER,assistant_message_id TEXT);`);
  db.prepare('INSERT INTO session VALUES(?,?)').run(sid, project);
  db.prepare('INSERT INTO session VALUES(?,?)').run('sess_other', path.join(project,'other'));
  const message = (id, role, at = now, session = sid) => db.prepare('INSERT INTO message VALUES(?,?,?,?)').run(id,session,at,JSON.stringify({role}));
  const part = (id, msg, data, at = now, session = sid) => db.prepare('INSERT INTO part VALUES(?,?,?,?,?)').run(id,msg,session,at,JSON.stringify(data));
  const request = (id, msg) => db.prepare('INSERT INTO model_usage VALUES(?,?,?,?)').run(id,sid,now,msg);
  message('user','user'); message('answer','assistant'); message('toolturn','assistant');
  part('instruction','user',{type:'text',text:'Build the requested page.'});
  part('answertext','answer',{type:'text',text:'The requested page is ready.'});
  part('private','answer',{type:'reasoning',text:'HIDDEN_REASONING'});
  part('tool','toolturn',{type:'tool',tool:'Bash',state:{status:'completed',input:{command:'npm test'},output:'<script>globalThis.injected=true</script>\nPassed ✓',error:'Recorded diagnostic'}});
  request('linked','answer'); request('tools','toolturn'); request('unlinked',null);
  const config = {runId:'sample',project,runDir,dbPath,expectedModel:'test-model'};
  const state = {runId:'sample',sessionId:sid,startedAt:now,updatedAt:now,workerExited:true,status:'ready_for_review',tools:[],notifications:{}};
  fs.writeFileSync(path.join(runDir,'config.json'),JSON.stringify(config)); fs.writeFileSync(path.join(runDir,'status.json'),JSON.stringify(state));
  const query = {sessionId:sid,project,startedAt:now};
  t.after(()=>{db.close();rmTree(project);});
  return {project,dbPath,runDir,db,query,message,part,request,read:extra=>readEventContent(dbPath,{...query,...extra})};
}

test('selected user, linked model response and tool content are readable; reasoning stays in its own Thinking section',t=>{
  const f=fixture(t);
  assert.equal(f.read({eventId:'message:user'}).sections[0].text,'Build the requested page.');
  const response=f.read({eventId:'request:linked'}),text=response.sections.find(x=>x.field==='text'),thinking=response.sections.find(x=>x.field==='reasoning');
  assert.equal(response.messageId,'answer');assert.equal(text.text,'The requested page is ready.');assert.ok(!text.text.includes('HIDDEN_REASONING'));
  assert.equal(thinking.title,'Thinking');assert.equal(thinking.text,'HIDDEN_REASONING');
  assert.deepEqual(f.read({eventId:'request:linked',field:'text'}).sections.map(x=>x.field),['text']);
  const tool=f.read({eventId:'part:tool'});assert.equal(JSON.parse(tool.sections[0].text).command,'npm test');assert.match(tool.sections[1].text,/<script>/);assert.equal(tool.sections[2].title,'Tool error');
  assert.match(f.read({eventId:'request:tools'}).note,/tool calls/);assert.match(f.read({eventId:'request:unlinked'}).note,/did not record a message link/);
  assert.equal(f.read({eventId:'part:private'}).sections.length,0);
});

test('content follows explicit request message IDs and rejects foreign sessions, prior runs and malformed input',t=>{
  const f=fixture(t);f.message('foreign','assistant',f.query.startedAt,'sess_other');f.part('foreigntext','foreign',{type:'text',text:'OTHER_SESSION'},f.query.startedAt,'sess_other');f.request('wronglink','foreign');
  f.message('old','assistant',f.query.startedAt-10_000);f.part('oldtool','old',{type:'tool',state:{output:'OLD_RUN'}},f.query.startedAt-10_000);
  for(const eventId of ['message:foreign','request:wronglink','message:old','part:oldtool','part:missing'])assert.throws(()=>f.read({eventId}),/outside this run/);
  assert.throws(()=>f.read({eventId:'part:tool',project:path.dirname(f.project)}),/different project/);
  for(const extra of [{eventId:"part:' OR 1=1"},{eventId:'part:tool',offset:-1},{eventId:'part:tool',limit:999999},{eventId:'part:tool',field:'metadata'}])assert.throws(()=>f.read(extra),/Invalid/);
});

test('long results page by Unicode character without omission, and preserve multiline commands',t=>{
  const f=fixture(t), output='🙂abc\n'.repeat(25_000);
  f.part('long','toolturn',{type:'tool',state:{input:{command:'line 1\nline 2'},output}});
  let offset=0,combined='',pages=0;
  do {const result=f.read({eventId:'part:long',field:'output',offset,limit:8192});const section=result.sections[0];combined+=section.text;offset=section.nextOffset;pages++;}while(offset!=null);
  assert.equal(combined,output);assert.ok(pages>1);
  assert.equal(JSON.parse(f.read({eventId:'part:long',field:'input'}).sections[0].text).command,'line 1\nline 2');
});

test('live tool results become visible on a subsequent read and the reader never mutates SQLite',t=>{
  const f=fixture(t);f.part('live','toolturn',{type:'tool',state:{input:{command:'test'}}});
  assert.equal(f.read({eventId:'part:live'}).sections.length,1);
  f.db.prepare('UPDATE part SET data=? WHERE id=?').run(JSON.stringify({type:'tool',state:{input:{command:'test'},output:'Finished'}}),'live');
  const hash=()=>crypto.createHash('sha256').update(fs.readFileSync(f.dbPath)).digest('hex'), before=hash();
  assert.equal(f.read({eventId:'part:live'}).sections[1].text,'Finished');assert.equal(hash(),before);
});

test('content endpoint is scoped to registered runs and same-origin access; snapshots remain compact',async t=>{
  const f=fixture(t),root=path.join(f.project,'hub'),key=registerRun(f.runDir,root),catalog=createCatalog(root,{telemetry:false});
  const panel=await serveDashboard({root,catalog,pollMs:1000});
  try {
    const url=panel.url+'runs/'+key+'/content?event=part%3Atool';
    const content=await(await fetch(url)).json();assert.equal(content.sections[1].title,'Tool result');
    const snapshot=await(await fetch(panel.url+'snapshot?run='+key)).json();
    assert.equal(snapshot.selected.contentSource,undefined);assert.ok(!JSON.stringify(snapshot).includes('npm test'));assert.ok(!JSON.stringify(snapshot).includes('events.sqlite'));
    assert.equal((await fetch(url,{headers:{Origin:'https://example.com'}})).status,403);
    assert.equal((await fetch(url.replace(panel.token,'0'.repeat(48)))).status,404);
    assert.equal((await fetch(url.replace(key,'0'.repeat(24)))).status,404);
    assert.equal((await fetch(url.replace('part%3Atool','message%3Aforeign'))).status,400);
  }finally{await panel.close();}
});
