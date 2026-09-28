// @ts-nocheck: ported from the JavaScript suite; it drives loosely typed internals with partial fixtures. Runtime-checked by bun test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readCodexSelection,buildCodexArgs,codexEnv,codexError,createCodexProjection,startCodex,locateRollout} from '../src/index.ts';
import {validateConfig,finishResult,callbackMessage} from '../src/index.ts';
import {openTelemetry,classifyError} from '../src/index.ts';
import {readEventContent,readEventPreviews} from '../src/index.ts';
import {registerRun,createCatalog,serveDashboard} from '../src/index.ts';
import { nodeExecutable } from '../src/index.ts';
import { rmTree } from './helpers.ts';
const NODE = nodeExecutable();

const tid='12345678-1234-4234-8234-123456789abc';
const save=(file,data)=>fs.writeFileSync(file,JSON.stringify(data));
function fixture(t,extra={}){
  const project=fs.mkdtempSync(path.join(os.tmpdir(),'codex-monitor-')),promptFile=path.join(project,'assignment.md');fs.writeFileSync(promptFile,'Fixture only.');
  const codexHome=path.join(project,'codex-home');fs.mkdirSync(path.join(codexHome,'sessions'),{recursive:true});
  const config=validateConfig({workerKind:'codex',project,promptFile,model:'gpt-fixture',provider:'openai',effort:'high',codexHome,notify:false,runId:'codex-fixture',...extra});
  fs.mkdirSync(config.runDir,{recursive:true});
  t.after(()=>rmTree(project));
  return config;
}
const ts=ms=>new Date(ms).toISOString();
const item=(at,value,begin=at)=>({timestamp:ts(at),type:'event_msg',payload:{type:'item_completed',thread_id:tid,turn_id:'turn-1',item:value,started_at_ms:begin,completed_at_ms:at}});
const context=(at,role,kinds,text)=>({timestamp:ts(at),type:'response_item',payload:{type:'message',role,content:[{type:'input_text',text}],internal_chat_message_metadata_passthrough:{content_item_kinds:kinds}}});
const usage=(at,id,input,cached,output,reasoning=0)=>({timestamp:ts(at),type:'token_usage_record',payload:{turn_id:'turn-1',response_id:id,usage:{input_tokens:input,cached_input_tokens:cached,cache_write_input_tokens:0,output_tokens:output,reasoning_output_tokens:reasoning}}});
function rollout(project,t0,{sandbox='danger-full-access',cwd=project,model='gpt-fixture'}={}){
  return [
    {timestamp:ts(t0),type:'session_meta',payload:{id:tid,cwd,model_provider:'openai',source:'exec'}},
    {timestamp:ts(t0+10),type:'event_msg',payload:{type:'task_started',turn_id:'turn-1'}},
    context(t0+20,'developer',['permissions.instructions'],'PRIVATE_PERMISSIONS'),
    context(t0+30,'user',['agents_md.instructions','environments.environment_context'],'Project rules'),
    context(t0+40,'user',['user.text'],'PRIVATE_INSTRUCTION'),
    {timestamp:ts(t0+50),type:'turn_context',payload:{turn_id:'turn-1',cwd,approval_policy:'never',sandbox_policy:{type:sandbox},model}},
    {timestamp:ts(t0+55),type:'world_state',payload:{full:true,state:{}}},
    item(t0+60,{type:'UserMessage',id:'u1',content:[{type:'text',text:'PRIVATE_INSTRUCTION'}]}),
    item(t0+300,{type:'Reasoning',id:'r1',summary_text:['HIDDEN_REASONING'],raw_content:[]},t0+200),
    {timestamp:ts(t0+400),type:'response_item',payload:{type:'custom_tool_call',call_id:'call_1',name:'exec',input:'// run the tests\nPRIVATE_COMMAND'}},
    usage(t0+410,'resp_1',1000,600,50,20),
    item(t0+700,{type:'CommandExecution',id:'exec-1',command:['pwsh','-Command','npm test'],parsed_cmd:[{type:'unknown',cmd:'npm test'}],cwd:'file:///'+project.replaceAll('\\','/'),
      status:'completed',exit_code:0,aggregated_output:'PRIVATE_OUTPUT',duration:{secs:0,nanos:5}},t0+450),
    item(t0+800,{type:'FileChange',id:'exec-2',changes:{[path.join(project,'a.txt')]:{type:'update',unified_diff:'@@ -1 +1 @@\n-a\n+b'}},status:'completed'},t0+750),
    {timestamp:ts(t0+900),type:'response_item',payload:{type:'custom_tool_call_output',call_id:'call_1',output:[{type:'input_text',text:'PRIVATE_RESULT'}]}},
    {timestamp:ts(t0+950),type:'response_item',payload:{type:'function_call',call_id:'call_2',name:'update_plan',arguments:JSON.stringify({plan:[{step:'Write code',status:'completed'},{step:'Run tests',status:'in_progress'}]})}},
    usage(t0+960,'resp_2',1100,1000,30),
    {timestamp:ts(t0+970),type:'response_item',payload:{type:'function_call_output',call_id:'call_2',output:'Plan updated'}},
    {timestamp:ts(t0+980),type:'response_item',payload:{type:'custom_tool_call',call_id:'call_3',name:'exec',input:'PRIVATE_FAILING'}},
    usage(t0+990,'resp_3',1150,1100,10),
    item(t0+1050,{type:'CommandExecution',id:'exec-3',command:['pwsh','-Command','npm run lint'],parsed_cmd:[{cmd:'npm run lint'}],status:'failed',exit_code:2,aggregated_output:'lint error'},t0+1000),
    {timestamp:ts(t0+1060),type:'response_item',payload:{type:'custom_tool_call_output',call_id:'call_3',output:[{type:'input_text',text:'Script failed\nOutput:\n'},{type:'input_text',text:'Script error:\nExit code: 2'}]}},
    item(t0+1500,{type:'AgentMessage',id:'m1',content:[{type:'Text',text:'Codex visible content'}],phase:'final_answer'},t0+1100),
    usage(t0+1510,'resp_4',1200,1150,40,5),
    usage(t0+1600,'resp_c',5000,0,300),
    {timestamp:ts(t0+1610),type:'compacted',payload:{message:'',replacement_history:[],compaction_response_id:'resp_c'}},
    item(t0+1620,{type:'ContextCompaction',id:'cc1'},t0+1590),
    {timestamp:ts(t0+1630),type:'event_msg',payload:{type:'token_count',info:{last_token_usage:{input_tokens:1}},rate_limits:{primary:{used_percent:97,window_minutes:10080,resets_at:1790410217}}}},
    {timestamp:ts(t0+1640),type:'event_msg',payload:{type:'task_complete',last_agent_message:'Codex visible content'}}
  ];
}

test('Codex selection reads the active profile and ignores multiline strings and other tables',t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'codex-home-'));t.after(()=>rmTree(home));
  fs.writeFileSync(path.join(home,'config.toml'),'\uFEFFmodel = "gpt-top"\nprofile = "work"\nmodel_reasoning_effort = "xhigh"\ninstructions = """\nmodel = "gpt-inside"\n"""\n[mcp_servers.x]\nmodel = "gpt-table"\n[profiles.work]\nmodel = \'gpt-work\' # comment\nmodel_provider = "azure"\n');
  assert.deepEqual(readCodexSelection(home),{model:'gpt-work',effort:'xhigh',provider:'azure'});
  fs.writeFileSync(path.join(home,'config.toml'),'approval_policy = "never"\n');
  assert.deepEqual(readCodexSelection(home),{model:null,effort:null,provider:'openai'});
});

test('Codex args pin model/provider/sandbox, pass the prompt on stdin and resume the exact thread',t=>{
  const config=fixture(t),args=buildCodexArgs(config);
  assert.deepEqual(args.slice(0,3),['exec','-C',config.project]);assert.equal(args.at(-1),'-');
  assert.equal(args[args.indexOf('-m')+1],'gpt-fixture');assert.ok(args.includes('model_provider="openai"'));assert.ok(args.includes('sandbox_mode="danger-full-access"'));
  assert.ok(args.includes('approval_policy="never"'));assert.ok(args.includes('model_reasoning_effort="high"'));assert.ok(args.includes('--json'));
  assert.equal(args[args.indexOf('-o')+1],path.join(config.runDir,'last-message.txt'));
  const resume=buildCodexArgs(fixture(t,{resumeSessionId:tid,mode:'plan'}));
  assert.deepEqual(resume.slice(0,2),['exec','resume']);assert.equal(resume.at(-2),tid);assert.ok(resume.includes('sandbox_mode="read-only"'));assert.ok(!resume.includes('-C'));
  assert.equal(config.dbPath,path.join(config.runDir,'codex-events.sqlite'));
  assert.throws(()=>validateConfig({...config,resumeSessionId:'sess_wrong'}),/Codex thread/);
  assert.throws(()=>validateConfig({...config,mode:'edit'}),/yolo or plan/);
  assert.throws(()=>validateConfig({...config,codexEffort:'max'}),/effort/);
  assert.throws(()=>validateConfig({...config,codexProvider:'bad provider'}),/provider/);
  const env=codexEnv(config,{PATH:'x',CODEX_THREAD_ID:tid,CODEX_SANDBOX:'seatbelt',CODEX_HOME:'elsewhere',OTHER:'1'});
  assert.deepEqual(env,{PATH:'x',OTHER:'1',CODEX_HOME:config.codexHome});
});

test('rollout projection yields requests, TTFT, cache, tools, context, todos and compaction without leaking content into telemetry',t=>{
  const config=fixture(t),startedAt=Date.now(),prompt='Dispatch run: codex-fixture\n\nPRIVATE_INSTRUCTION';
  const projection=createCodexProjection(config,{prompt,startedAt});
  try{
    projection.ingestEvent({type:'thread.started',thread_id:tid});
    for(const record of rollout(config.project,startedAt+100))projection.ingestRollout(record);
    projection.ingestEvent({type:'item.completed',item:{id:'x',type:'agent_message',text:'Codex visible content'}});
    projection.ingestEvent({type:'turn.completed',usage:{input_tokens:9450,output_tokens:430}});
    const reader=openTelemetry(config.dbPath),query={project:config.project,startedAt,sessionId:tid,includeTrajectory:true};
    const telemetry=reader.read(query);reader.close();
    assert.equal(telemetry.available,true);assert.equal(telemetry.model,'gpt-fixture');assert.equal(telemetry.provider,'openai');
    assert.equal(telemetry.usage.modelCalls,5);assert.equal(telemetry.usage.inputTokens,9450);assert.deepEqual(telemetry.todos.map(x=>x.status),['completed','in_progress']);
    const tr=telemetry.trajectory;assert.equal(tr.turns,1);assert.equal(tr.toolCalls,3);
    const requests=tr.events.filter(x=>x.kind==='model'&&x.id.startsWith('request:'));assert.equal(requests.length,5);
    assert.equal(requests[3].ttftMs,40); // call_3 output at +1060 -> first reply token at +1100
    assert.equal(tr.stats.cacheHitRate,40.7); // 3850 cached of 9450 prompt tokens (input_tokens already include cached)assert.equal(tr.stats.finishReasons.compaction,1);assert.equal(tr.stats.finishReasons.tool_calls,3);
    const compaction=tr.events.find(x=>x.kind==='compaction');assert.equal(compaction.preTokens,5000);
    const tools=tr.events.filter(x=>x.kind==='tool');assert.deepEqual(tools.map(x=>x.label),['exec','update_plan','Shell']);assert.equal(tools[2].isError,true);
    assert.deepEqual(tr.events.filter(x=>x.kind==='context').map(x=>x.label),['Permissions','AGENTS.md + environment']);
    for(const text of ['PRIVATE_COMMAND','PRIVATE_RESULT','PRIVATE_INSTRUCTION','PRIVATE_PERMISSIONS','PRIVATE_OUTPUT','Codex visible content','HIDDEN_REASONING'])assert.ok(!JSON.stringify(telemetry).includes(text),text);
    const request=readEventContent(config.dbPath,{...query,workerLabel:'Codex',eventId:'request:codex-req-4'});
    assert.equal(request.sections.find(x=>x.field==='text').title,'Codex response');assert.equal(request.sections.find(x=>x.field==='text').text,'Codex visible content');
    const thinking=readEventContent(config.dbPath,{...query,workerLabel:'Codex',eventId:'request:codex-req-1'});assert.equal(thinking.sections.find(x=>x.field==='reasoning').text,'HIDDEN_REASONING');
    const tool=readEventContent(config.dbPath,{...query,eventId:'part:codex-call-call_1'}),input=JSON.parse(tool.sections[0].text);
    assert.equal(input.command,'npm test');assert.equal(input.path,path.join(config.project,'a.txt'));assert.match(input.code,/PRIVATE_COMMAND/);
    assert.deepEqual(input.actions.map(x=>x.tool),['Shell','Edit']);assert.equal(input.actions[0].cwd,config.project);assert.equal(tool.sections[1].text,'PRIVATE_RESULT');
    const failed=readEventContent(config.dbPath,{...query,eventId:'part:codex-call-call_3'});assert.match(failed.sections.find(x=>x.field==='error').text,/Exit code: 2/);
    const injected=readEventContent(config.dbPath,{...query,eventId:'message:codex-context-'+'2'});
    assert.equal(injected.sections[0].title,'Injected context');
    const previews=readEventPreviews(config.dbPath,{...query,ids:['part:codex-call-call_1']});
    assert.match(JSON.stringify(previews),/npm test/);
    const result=projection.result();assert.equal(result.sessionId,tid);assert.equal(result.response,'Codex visible content');assert.equal(result.rateLimits.primary.usedPercent,97);
  }finally{projection.close();}
});

test('Codex projection rejects another thread, workspace, sandbox or approval policy',t=>{
  const config=fixture(t,{resumeSessionId:tid}),t0=Date.now();
  const projection=createCodexProjection(config,{prompt:'Dispatch run: codex-fixture',startedAt:t0});
  try{
    assert.throws(()=>projection.ingestEvent({type:'thread.started',thread_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}),/different thread/);
    assert.throws(()=>projection.ingestEvent({type:'thread.started',thread_id:'not-a-thread'}),/invalid thread/);
    projection.ingestEvent({type:'thread.started',thread_id:tid});
    assert.throws(()=>projection.ingestRollout({timestamp:ts(t0),type:'session_meta',payload:{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',cwd:config.project}}),/different thread/);
    const turn=payload=>({timestamp:ts(t0),type:'turn_context',payload:{turn_id:'turn-1',cwd:config.project,approval_policy:'never',sandbox_policy:{type:'danger-full-access'},model:'gpt-fixture',...payload}});
    assert.throws(()=>projection.ingestRollout(turn({cwd:path.dirname(config.project)})),/working directory/);
    assert.throws(()=>projection.ingestRollout(turn({sandbox_policy:{type:'read-only'}})),/sandbox/);
    assert.throws(()=>projection.ingestRollout(turn({approval_policy:'on-request'})),/approval policy/);
    projection.ingestRollout(turn({cwd:'\\\\?\\'+config.project}));
  }finally{projection.close();}
  const plan=fixture(t,{mode:'plan',runId:'codex-plan'}),other=createCodexProjection(plan,{prompt:'x',startedAt:t0});
  try{other.ingestEvent({type:'thread.started',thread_id:tid});assert.throws(()=>other.ingestRollout({timestamp:ts(t0),type:'turn_context',payload:{cwd:plan.project,approval_policy:'never',sandbox_policy:{type:'danger-full-access'}}}),/read-only/);}
  finally{other.close();}
});

test('usage-limit and HTTP errors classify as blocking while stream reconnects are not errors',()=>{
  const quota=classifyError(codexError({message:"You've hit your usage limit. Upgrade to Pro or try again at 8:30 PM."}));
  assert.equal(quota.kind,'quota');assert.equal(quota.stop,true);assert.match(quota.resetHint,/8:30 PM/);
  assert.equal(classifyError({message:"You've hit your usage limit."}).kind,'quota');
  assert.equal(classifyError(codexError({message:'unexpected status 401 Unauthorized: Missing bearer'})).kind,'auth');
  assert.equal(classifyError(codexError({message:'unexpected status 429 Too Many Requests'})).kind,'rate_limit');
});

function fakeCodex(config,{events,records,exitCode=0,linger=0,after=''}){
  const script=path.join(config.project,'fake-codex.mjs'),day=new Date(),pad=n=>String(n).padStart(2,'0');
  const dir=path.join(config.codexHome,'sessions',String(day.getFullYear()),pad(day.getMonth()+1),pad(day.getDate()));
  const file=path.join(dir,`rollout-fixture-${tid}.jsonl`),stream=events.map(x=>JSON.stringify(x)).join('\n');
  fs.writeFileSync(script,`import fs from 'node:fs';import {spawn} from 'node:child_process';
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',async()=>{
  if(!input.includes('Dispatch run')) process.exit(9);
  fs.mkdirSync(${JSON.stringify(dir)},{recursive:true});
  const lines=${JSON.stringify(records.map(x=>JSON.stringify(x)))};
  fs.appendFileSync(${JSON.stringify(file)},lines.slice(0,3).join('\\n')+'\\n');
  const data=Buffer.from(${JSON.stringify(stream)});for(let i=0;i<data.length;i+=7)process.stdout.write(data.subarray(i,i+7));
  await new Promise(r=>setTimeout(r,${linger}));
  fs.appendFileSync(${JSON.stringify(file)},lines.slice(3).join('\\n')+(lines.length>3?'\\n':''));
  process.stdout.write('\\n');process.exitCode=${exitCode};${after}
});`);
  return script;
}
async function run(config,script,{prompt='Dispatch run: codex-fixture 🙂',timing={},onLingering=null}={}){
  const err=fs.openSync(path.join(config.runDir,'stderr.log'),'w'),notices=[];let failure,lingered=0;
  const bridge=startCodex(config,{prompt,startedAt:Date.now()-1000,stderrFd:err,onFailure:error=>failure=error,
    onLingering:()=>{lingered++;onLingering?.(bridge.child);},onNotice:message=>notices.push(message)},
    {tailMs:20,...timing,spawnFn:(exe,args,options)=>{assert.equal(options.shell,false);assert.equal(options.env.CODEX_HOME,config.codexHome);assert.deepEqual(options.stdio.slice(0,2),['pipe','pipe']);
      assert.ok(!args.some(x=>x.includes('Dispatch run')));return spawn(NODE,[script],options);}});
  fs.closeSync(err);const [code]=await once(bridge.child,'close');bridge.finalize();
  return {code,failure,notices,lingered,result:JSON.parse(fs.readFileSync(path.join(config.runDir,'result.json'),'utf8'))};
}

test('raw Codex run reads the prompt from stdin, tails the rollout and finishes ready for review',async t=>{
  const config=fixture(t),t0=Date.now();
  const script=fakeCodex(config,{linger:120,records:rollout(config.project,t0),events:[{type:'thread.started',thread_id:tid},{type:'turn.started'},
    {type:'error',message:'Reconnecting... 1/5 (stream disconnected before completion)'},
    {type:'item.completed',item:{id:'item_0',type:'agent_message',text:'Ready 🙂'}},{type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:5,output_tokens:2}}]});
  const {code,failure,result}=await run(config,script);
  assert.equal(code,0);assert.equal(failure,undefined);assert.equal(result.sessionId,tid);assert.equal(result.response,'Ready 🙂');assert.equal(result.telemetry.retries,1);assert.ok(!result.isError);
  assert.equal(fs.readFileSync(path.join(config.runDir,'codex-rollout.jsonl'),'utf8').trim().split('\n').length,rollout(config.project,t0).length);
  const reader=openTelemetry(config.dbPath),telemetry=reader.read({project:config.project,startedAt:t0-5000,sessionId:tid,includeTrajectory:true});reader.close();
  assert.equal(telemetry.errors?.length??0,0);assert.equal(telemetry.trajectory.events.filter(x=>x.kind==='retry').length,1);assert.equal(telemetry.usage.modelCalls,5);
  const completion=finishResult(config,{exitCode:0});assert.equal(completion.status,'ready_for_review');assert.equal(completion.sessionId,tid);
  assert.match(callbackMessage(config,{workerExited:true},{kind:'ready_for_review'}),/^\[Codex /);
  assert.equal(locateRollout(config.codexHome,tid).toLowerCase(),fs.realpathSync(path.join(path.dirname(locateRollout(config.codexHome,tid)),`rollout-fixture-${tid}.jsonl`)).toLowerCase());
});

test('usage-limit failure blocks the run; missing terminal events are not accepted',async t=>{
  const config=fixture(t);
  const script=fakeCodex(config,{exitCode:1,records:rollout(config.project,Date.now()).slice(0,3),events:[{type:'thread.started',thread_id:tid},{type:'turn.started'},
    {type:'error',message:"You've hit your usage limit. Try again at 8:30 PM."},{type:'turn.failed',error:{message:"You've hit your usage limit. Try again at 8:30 PM."}}]});
  const {result}=await run(config,script);assert.equal(result.isError,true);assert.equal(result.error.code,'usage_limit_reached');
  const completion=finishResult(config,{exitCode:1});assert.equal(completion.status,'blocked');assert.equal(completion.error.kind,'quota');
  const partial=fixture(t,{runId:'codex-partial'});
  const partialScript=fakeCodex(partial,{records:[],events:[{type:'thread.started',thread_id:tid},{type:'item.completed',item:{id:'i',type:'agent_message',text:'Partial answer'}}]});
  fs.rmSync(path.join(partial.runDir,'last-message.txt'),{force:true});
  const second=await run(partial,partialScript);assert.equal(second.result.isError,true);
  const outcome=finishResult(partial,{exitCode:0});assert.equal(outcome.status,'worker_failed');assert.match(outcome.error.message,/without a terminal result/);
  save(path.join(partial.runDir,'result.json'),{sessionId:tid,cancelled:true});assert.equal(finishResult(partial,{exitCode:1}).status,'cancelled');
});

test('a worker alive after its terminal event is closed as complete, and a held output pipe does not block the run',async t=>{
  const events=[{type:'thread.started',thread_id:tid},{type:'item.completed',item:{id:'i',type:'agent_message',text:'Done'}},{type:'turn.completed',usage:{}}];
  const config=fixture(t),started=Date.now();
  const script=fakeCodex(config,{records:rollout(config.project,started),events,after:'setInterval(()=>{},1000);'});
  const lingering=await run(config,script,{timing:{exitGraceMs:100},onLingering:child=>child.kill()});
  assert.equal(lingering.lingered,1);assert.notEqual(lingering.code,0);assert.ok(!lingering.result.isError);assert.equal(lingering.result.response,'Done');
  assert.ok(Date.now()-started<10_000);assert.equal(finishResult(config,{exitCode:0}).status,'ready_for_review');
  // A process the worker started inherits its stdout and outlives it (the observed daemon/hung-test case).
  const held=fixture(t,{runId:'codex-held-pipe'}),pidFile=path.join(held.project,'grandchild.pid');
  const grandchild=`const g=spawn(process.execPath,['-e','setTimeout(()=>{},60000)'],{stdio:['ignore','inherit','ignore'],detached:true});fs.writeFileSync(${JSON.stringify(pidFile)},String(g.pid));g.unref();`;
  try {
    const outcome=await run(held,fakeCodex(held,{records:rollout(held.project,Date.now()),events,after:grandchild}),{timing:{pipeGraceMs:100}});
    assert.equal(outcome.code,0);assert.equal(outcome.lingered,0);assert.equal(outcome.notices.length,1);assert.match(outcome.notices[0],/still holds its output/);
    assert.ok(!outcome.result.isError);assert.equal(outcome.result.response,'Done');
    assert.doesNotThrow(()=>process.kill(Number(fs.readFileSync(pidFile,'utf8')),0),'the fixture grandchild must still hold the pipe');
  } finally { try { process.kill(Number(fs.readFileSync(pidFile,'utf8'))); } catch {} }
});

test('resume requires the saved rollout and records only the new part of it',async t=>{
  const config=fixture(t,{resumeSessionId:tid});
  assert.throws(()=>startCodex(config,{prompt:'x',startedAt:Date.now(),stderrFd:'ignore'},{spawnFn:()=>assert.fail('must not spawn')}),/rollout was not found/);
  const t0=Date.now(),old=rollout(config.project,t0-60_000),dir=path.join(config.codexHome,'sessions','2025','01','02');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,`rollout-old-${tid}.jsonl`),old.map(x=>JSON.stringify(x)).join('\n')+'\n');
  const fresh=rollout(config.project,t0).slice(1).map(x=>JSON.stringify(x)),script=path.join(config.project,'fake-resume.mjs');
  fs.writeFileSync(script,`import fs from 'node:fs';process.stdin.resume();process.stdin.on('end',()=>{
    fs.appendFileSync(${JSON.stringify(path.join(dir,`rollout-old-${tid}.jsonl`))},${JSON.stringify(fresh.join('\n')+'\n')});
    console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(tid)}}));console.log(JSON.stringify({type:'turn.completed',usage:{}}));});`);
  const {result}=await run(config,script);assert.ok(!result.isError);assert.equal(result.sessionId,tid);
  const reader=openTelemetry(config.dbPath),telemetry=reader.read({project:config.project,startedAt:t0-5000,sessionId:tid,includeTrajectory:true});reader.close();
  assert.equal(telemetry.usage.modelCalls,5);
});

test('mixed dashboard labels Codex runs and serves their content',async t=>{
  const config=fixture(t),startedAt=Date.now(),projection=createCodexProjection(config,{prompt:'Dispatch run: codex-fixture',startedAt});
  projection.ingestEvent({type:'thread.started',thread_id:tid});for(const record of rollout(config.project,startedAt+10))projection.ingestRollout(record);
  projection.ingestEvent({type:'turn.completed',usage:{}});projection.close();
  save(path.join(config.runDir,'config.json'),config);save(path.join(config.runDir,'status.json'),{runId:config.runId,sessionId:tid,startedAt,updatedAt:Date.now(),workerExited:true,status:'ready_for_review',tools:[],notifications:{}});
  const root=path.join(config.project,'dashboard'),key=registerRun(config.runDir,root),catalog=createCatalog(root);catalog.refresh();
  const selected=catalog.snapshot(key).selected;assert.equal(selected.workerLabel,'Codex');assert.equal(selected.model,'gpt-fixture');assert.ok(selected.trajectory.events.length>5);
  const panel=await serveDashboard({root,catalog});
  try{const content=await(await fetch(panel.url+'runs/'+key+'/content?event=request%3Acodex-req-4')).json();assert.equal(content.sections.find(x=>x.field==='text').title,'Codex response');}
  finally{await panel.close();}
});
