// @ts-nocheck: ported from the JavaScript suite; it drives loosely typed internals with partial fixtures. Runtime-checked by bun test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {buildAgyArgs,createAgyProjection,startAgy} from '../src/index.ts';
import {validateConfig,acquireProjectLock,finishResult,callbackMessage} from '../src/index.ts';
import {openTelemetry,classifyError} from '../src/index.ts';
import {readEventContent} from '../src/index.ts';
import {registerRun,createCatalog,serveDashboard} from '../src/index.ts';
import { nodeExecutable } from '../src/index.ts';
import { rmTree } from './helpers.ts';
const NODE = nodeExecutable();

const sid='12345678-1234-4234-8234-123456789abc';
const save=(file,data)=>fs.writeFileSync(file,JSON.stringify(data));
function fixture(t,extra={}){
  const project=fs.mkdtempSync(path.join(os.tmpdir(),'agy-monitor-')),promptFile=path.join(project,'assignment.md');fs.writeFileSync(promptFile,'Fixture only.');
  const config=validateConfig({workerKind:'agy',project,promptFile,model:'gemini-fixture',notify:false,runId:'agy-fixture',...extra});
  fs.mkdirSync(config.runDir,{recursive:true});
  t.after(()=>rmTree(project));
  return config;
}
const init=project=>({event:'init',conversation_id:sid,init:{cwd:project,permission_mode:'always-proceed'}});
const step=(index,type,data={})=>({event:'step_update',step_update:{conversation_id:sid,step_index:index,step_type:type,state:'DONE',...data}});
const result=(data={})=>({event:'result',result:{conversation_id:sid,status:'SUCCESS',response:'Fixture ready.',...data}});

test('AGY uses the requested permission flag, exact resume ID and pinned model/effort without shell interpolation',t=>{
  const config=fixture(t,{resumeSessionId:sid,effort:'high',agent:'worker',printTimeout:'2h'}),prompt='Line one\n"quoted" $HOME $(no-execution)';
  const args=buildAgyArgs(config,prompt);assert.equal(args[0],'--dangerously-skip-permissions');assert.equal(args[args.indexOf('-p')+1],prompt);
  assert.equal(args[args.indexOf('--add-dir')+1],config.project);
  assert.equal(args[args.indexOf('--conversation')+1],sid);assert.equal(args[args.indexOf('--model')+1],'gemini-fixture');assert.equal(args[args.indexOf('--effort')+1],'high');assert.ok(!args.includes('--continue'));
  assert.throws(()=>validateConfig({...config,resumeSessionId:'sess_wrong'}),/conversation/);
  assert.throws(()=>validateConfig({...config,agyPrintTimeout:'0s'}),/timeout/);
  assert.equal(config.dbPath,path.join(config.runDir,'agy-events.sqlite'));
});

test('stream projection keeps incremental response/tool content and produces compact compatible telemetry',t=>{
  const config=fixture(t),startedAt=Date.now(),prompt='Dispatch run: agy-fixture\n\nPRIVATE_INSTRUCTION';let clock=startedAt;
  const projection=createAgyProjection(config,{prompt,startedAt,now:()=>clock+=100});
  try{
    projection.ingest(init(config.project));projection.ingest(step(0,'user_input'));
    projection.ingest(step(1,'agent_response',{state:'ACTIVE',text_delta:'Hello '}));projection.ingest(step(1,'agent_response',{state:'DONE',text_delta:'world.',usage:{input_tokens:100,output_tokens:10,cache_read_tokens:50},duration_seconds:0.1}));
    projection.ingest(step(2,'tool',{state:'ACTIVE',tool_name:'run_command',tool_info:{parameters:{CommandLine:'PRIVATE_COMMAND'}}}));
    projection.ingest(step(2,'tool',{state:'DONE',tool_name:'run_command',tool_info:{output:'PRIVATE_RESULT'},duration_seconds:0.1}));
    projection.ingest(step(3,'thinking',{text_delta:'HIDDEN_REASONING'}));
    projection.ingest(result({usage:{input_tokens:99999,output_tokens:8888},num_turns:80}));
    const reader=openTelemetry(config.dbPath),query={project:config.project,startedAt,sessionId:sid,includeTrajectory:true};
    const telemetry=reader.read(query);reader.close();assert.equal(telemetry.available,true);assert.equal(telemetry.model,'gemini-fixture');assert.equal(telemetry.usage.inputTokens,100);assert.equal(telemetry.trajectory.turns,1);assert.equal(telemetry.trajectory.toolCalls,1);
    for(const text of ['PRIVATE_COMMAND','PRIVATE_RESULT','PRIVATE_INSTRUCTION','Hello world.','HIDDEN_REASONING'])assert.ok(!JSON.stringify(telemetry).includes(text));
    const content=readEventContent(config.dbPath,{...query,workerLabel:'AGY',eventId:'request:agy-step-1'});assert.equal(content.sections[0].title,'AGY response');assert.equal(content.sections[0].text,'Hello world.');
    const tool=readEventContent(config.dbPath,{...query,eventId:'part:agy-step-2'});assert.equal(JSON.parse(tool.sections[0].text).CommandLine,'PRIVATE_COMMAND');assert.equal(tool.sections[1].text,'PRIVATE_RESULT');
  }finally{projection.close();}
});

test('AGY projection rejects different workspaces, wrong permission mode and foreign/resumed conversations',t=>{
  const config=fixture(t,{resumeSessionId:sid}),projection=createAgyProjection(config,{prompt:'Dispatch run: agy-fixture',startedAt:Date.now()});
  try{
    assert.throws(()=>projection.ingest(init(path.dirname(config.project))),/working directory/);
    assert.throws(()=>projection.ingest({...init(config.project),init:{cwd:config.project,permission_mode:'request-review'}}),/permission mode/);
    assert.throws(()=>projection.ingest({...init(config.project),init:{cwd:config.project,permission_mode:'always-proceed',model:'wrong-model'}}),/model selection/);
    assert.throws(()=>projection.ingest({...init(config.project),conversation_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}),/different conversation/);
    projection.ingest(init(config.project));
    assert.throws(()=>projection.ingest({event:'step_update',step_update:{conversation_id:'foreign',step_index:0,step_type:'tool',state:'DONE'}}),/initialized conversation/);
    assert.throws(()=>projection.ingest(result({conversation_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'})),/different conversation/);
  }finally{projection.close();}
});

test('AGY and ZCode share the same checkout lock while separate directories remain independent',t=>{
  const agy=fixture(t),zcode=validateConfig({...agy,workerKind:'zcode',expectedModel:'GLM-5.3-Flash',expectedProvider:'builtin:zai-coding-plan',runId:'zcode'});
  const lock=acquireProjectLock(agy);try{assert.throws(()=>acquireProjectLock(zcode),/lock already exists/);const other=fixture(t),otherLock=acquireProjectLock(other);otherLock.release();}finally{lock.release();}
});

test('provider quota and authentication errors are actionable while temporary resource exhaustion is not claimed as quota',()=>{
  assert.equal(classifyError({code:'RESOURCE_EXHAUSTED',message:'Too many requests'}).kind,'rate_limit');
  const quota=classifyError({code:'RESOURCE_EXHAUSTED',message:'You have exhausted your capacity on this model. Resets at tomorrow 09:00.'});assert.equal(quota.kind,'quota');assert.equal(quota.stop,true);assert.match(quota.resetHint,/tomorrow/);
  assert.equal(classifyError({code:'UNAUTHENTICATED',message:'Authentication required'}).stop,true);
  assert.equal(classifyError({message:'Authentication required'}).kind,'auth');
  assert.equal(classifyError({code:'PERMISSION_DENIED',message:'Access denied'}).kind,'permission');
});

test('raw stream ingestion handles UTF-8 chunks, records terminal result and survives absent final newline',async t=>{
  const config=fixture(t),fixturePath=path.join(config.project,'fake-agy.mjs');
  const stream=[init(config.project),step(0,'user_input'),step(1,'agent_response',{text_delta:'Ready 🙂',usage:{input_tokens:10,output_tokens:2}}),result({response:'Ready 🙂'})].map(JSON.stringify).join('\n');
  fs.writeFileSync(fixturePath,`const data=Buffer.from(${JSON.stringify(stream)});for(let i=0;i<data.length;i+=7)process.stdout.write(data.subarray(i,i+7));`);
  const err=fs.openSync(path.join(config.runDir,'stderr.log'),'w');let failure;
  const bridge=startAgy(config,{prompt:'Dispatch run: agy-fixture',startedAt:Date.now(),stderrFd:err,onFailure:error=>failure=error},
    {spawnFn:(exe,args,options)=>{assert.equal(options.shell,false);assert.ok(args.includes('--dangerously-skip-permissions'));return spawn(NODE,[fixturePath],options);}});
  fs.closeSync(err);const [code]=await once(bridge.child,'close');bridge.finalize();assert.equal(code,0);assert.equal(failure,undefined);
  const final=JSON.parse(fs.readFileSync(path.join(config.runDir,'result.json'),'utf8'));assert.equal(final.sessionId,sid);assert.equal(final.response,'Ready 🙂');
  const completion=finishResult(config,{exitCode:0});assert.equal(completion.status,'ready_for_review');assert.equal(completion.sessionId,sid);
  assert.match(callbackMessage(config,{workerExited:true},{kind:'ready_for_review'}),/^\[AGY /);
});

test('exit zero with only deltas or malformed stream is not accepted, and interrupted results stay cancelled',async t=>{
  const config=fixture(t),fixturePath=path.join(config.project,'fake-agy.mjs');
  fs.writeFileSync(fixturePath,`console.log(${JSON.stringify(JSON.stringify(init(config.project)))});console.log('not json');`);
  const err=fs.openSync(path.join(config.runDir,'stderr.log'),'w');let failure;
  const bridge=startAgy(config,{prompt:'Dispatch run: agy-fixture',startedAt:Date.now(),stderrFd:err,onFailure:error=>failure=error},
    {spawnFn:(exe,args,options)=>spawn(NODE,[fixturePath],options)});fs.closeSync(err);
  await once(bridge.child,'close');bridge.finalize();assert.ok(failure);assert.notEqual(finishResult(config,{exitCode:0}).status,'ready_for_review');
  save(path.join(config.runDir,'result.json'),{sessionId:sid,cancelled:true,isError:true,error:'interrupted'});assert.equal(finishResult(config,{exitCode:1}).status,'cancelled');
});

test('valid partial response without a terminal result cannot mark the stage ready for review',async t=>{
  const config=fixture(t),script=path.join(config.project,'partial.mjs');
  const stream=[init(config.project),step(1,'agent_response',{text_delta:'Partial answer'})].map(JSON.stringify).join('\n');
  fs.writeFileSync(script,`process.stdout.write(${JSON.stringify(stream)});`);
  const err=fs.openSync(path.join(config.runDir,'stderr.log'),'w');
  const bridge=startAgy(config,{prompt:'Dispatch run: agy-fixture',startedAt:Date.now(),stderrFd:err},
    {spawnFn:(exe,args,options)=>spawn(NODE,[script],options)});fs.closeSync(err);await once(bridge.child,'close');bridge.finalize();
  const completion=finishResult(config,{exitCode:0});assert.equal(completion.status,'worker_failed');assert.match(completion.error.message,/without a terminal result/);
});

test('mixed dashboard serves AGY content and retains its completed trajectory after a service reload',async t=>{
  const config=fixture(t),startedAt=Date.now(),projection=createAgyProjection(config,{prompt:'Dispatch run: agy-fixture',startedAt});
  projection.ingest(init(config.project));projection.ingest(step(0,'user_input'));projection.ingest(step(1,'agent_response',{text_delta:'AGY visible content',usage:{input_tokens:10,output_tokens:3}}));projection.ingest(result());projection.close();
  save(path.join(config.runDir,'config.json'),config);save(path.join(config.runDir,'status.json'),{runId:config.runId,sessionId:sid,startedAt,updatedAt:Date.now(),workerExited:true,status:'ready_for_review',tools:[],notifications:{}});
  const root=path.join(config.project,'dashboard'),key=registerRun(config.runDir,root),catalog=createCatalog(root);catalog.refresh();
  const zcode=fixture(t);zcode.workerKind='zcode';zcode.expectedModel='GLM-5.3-Flash';zcode.expectedProvider='builtin:zai-coding-plan';
  save(path.join(zcode.runDir,'config.json'),zcode);save(path.join(zcode.runDir,'status.json'),{runId:zcode.runId,startedAt,updatedAt:Date.now(),workerExited:false,workerPid:process.pid,runnerPid:process.pid,status:'running',phase:'working',tools:[],notifications:{}});
  const zcodeKey=registerRun(zcode.runDir,root);catalog.refresh();assert.equal(catalog.snapshot().runs.find(x=>x.key===zcodeKey).workerLabel,'ZCode');
  assert.equal(catalog.snapshot(key).selected.workerLabel,'AGY');assert.equal(catalog.snapshot(key).selected.trajectory.events.length,2);
  const panel=await serveDashboard({root,catalog});try{const content=await(await fetch(panel.url+'runs/'+key+'/content?event=request%3Aagy-step-1')).json();assert.equal(content.sections[0].title,'AGY response');assert.equal(content.sections[0].text,'AGY visible content');}finally{await panel.close();}
});
