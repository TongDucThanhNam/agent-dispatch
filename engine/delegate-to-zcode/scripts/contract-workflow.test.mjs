import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {validatePlan, conflicts, readJson, alive} from './contract-plan.mjs';
import {executePlan, brief, manage, preflightPlan, launchPlan} from './contract-workflow.mjs';
import {evaluateState} from './contract-evidence.mjs';
import {capture,writeCheckpoint,restoreCheckpoint} from './contract-evidence.mjs';
import {launch, acquireProjectLock} from './run.mjs';
import {readRun, registerRun} from './dashboard.mjs';

const root = path.resolve('work/contract-workflow-v3/fixtures'); fs.mkdirSync(root, {recursive:true});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {for(let i=0;i<150;i++){const value=fn();if(value)return value;await pause(50);}throw new Error('Fixture timeout');}
function fixture(t, {ids=['a'], kinds={}, dependencies={}, integration=null, behavior={}, notify=false, finalChecks=false, extra={}}={}) {
  const project=fs.mkdtempSync(path.join(root,'case-'));
  t.after(()=>{const target=fs.realpathSync(project);assert.ok(path.relative(root,target).length>0&&!path.relative(root,target).startsWith('..'));fs.rmSync(target,{recursive:true,force:true});});
  fs.mkdirSync(path.join(project,'src'));fs.mkdirSync(path.join(project,'gates'));
  fs.writeFileSync(path.join(project,'src/user.txt'),'pre-existing user edit');
  const gate=path.join(project,'gates','check.mjs');
  fs.writeFileSync(gate,`import fs from 'node:fs';import assert from 'node:assert/strict';
const [project,id,kind]=process.argv.slice(2);const file=project+'/src/'+id+'.txt';
fs.appendFileSync(project+'/.zcode-dispatch/gate-events.jsonl',JSON.stringify({id,kind,at:Date.now()})+'\\n');
const value=fs.readFileSync(file,'utf8');if(kind==='exists')assert.ok(value.length);else assert.equal(value,'ok');
console.log('verified '+id);`);
  const workerFile=path.join(project,'worker-fixture.mjs');
  fs.writeFileSync(workerFile,`import fs from 'node:fs';
const data=JSON.parse(process.argv[2]);const log=e=>fs.appendFileSync(data.project+'/.zcode-dispatch/worker-events.jsonl',JSON.stringify({id:data.id,attempt:data.attempt,event:e,at:Date.now(),pid:process.pid})+'\\n');
log('start');if(data.delay)await new Promise(r=>setTimeout(r,data.delay));
if(data.quota){console.log(JSON.stringify({error:{code:'1308',message:'quota exhausted'},sessionId:data.session}));process.exit(0);}
fs.writeFileSync(data.project+'/src/'+data.id+'.txt',data.value);
for(const [id,value] of Object.entries(data.extraWrites??{}))fs.writeFileSync(data.project+'/src/'+id+'.txt',value);
if(data.tamper)fs.writeFileSync(data.project+'/gates/check.mjs','process.exit(0);');
if(data.unowned)fs.writeFileSync(data.project+'/src/user.txt','overwritten');
log('end');console.log(JSON.stringify({sessionId:data.session,response:data.report}));`);
  const callbacks=[], captures=[];
  const tasks=ids.map(id=>{
    const promptFile=path.join(project,id+'-assignment.md');fs.writeFileSync(promptFile,'Implement '+id+' according to its public contract; finish your own test/fix loop.');
    return {id,promptFile,dependsOn:dependencies[id]??[],integration:id===integration,writePaths:['src/'+id+'.txt'],readPaths:[],gateFiles:['gates/check.mjs'],
      checks:[{name:'behavior',command:process.execPath,args:[gate,project,id,id===integration&&finalChecks?'exists':'exact']}],
      acceptance:[{id:'correct',description:'The required behavior is correct.',checks:['behavior']}],
      worker:kinds[id]==='agy'?{workerKind:'agy',model:'fixture-agy',agyEffort:'high'}:undefined};
  });
  const raw={project,runId:'initial',objective:'Deliver the complete fixture application.',tasks,notify,threadId:'12345678-1234-4234-8234-123456789abc',
    keepOpenMs:0,pollMs:100,quietMs:500,stallMs:2000,finalJudge:'human',judgmentCriteria:['The assembled product meets the user goal.'],
    ...(finalChecks?{finalChecks:[{name:'integrated behavior',command:process.execPath,args:[gate,project,integration??ids.at(-1),'exact']}],finalGateFiles:['gates/check.mjs']}:{}),...extra};
  const plan=validatePlan(raw);
  const sessions=new Map();
  const deps={
    spawnWorker({config,prompt,task,attempt,out,err}){
      const choice=behavior[task.id]?.[attempt-1]??{};
      const session=config.resumeSessionId??(config.workerKind==='agy'?`12345678-1234-4234-8234-${String(captures.length+1).padStart(12,'0')}`:`sess_${task.id}_${attempt}`);
      sessions.set(task.id,session);captures.push({id:task.id,attempt,session,resume:config.resumeSessionId,model:config.expectedModel,effort:config.zcodeEffort??config.agyEffort,prompt});
      const data={project,id:task.id,attempt,session,value:choice.value??'ok',delay:choice.delay??40,tamper:choice.tamper,unowned:choice.unowned,quota:choice.quota,extraWrites:choice.extraWrites,
        report:choice.report ? `Stage: ${task.id}\nContract: ${task.contractHash}\n${choice.report}` : `Stage: ${task.id}\nContract: ${task.contractHash}\nImplementation and checks completed.`};
      return spawn(process.execPath,[workerFile,JSON.stringify(data)],{shell:false,windowsHide:true,stdio:['ignore',out,err]});
    },
    telemetryFactory:(task,attempt)=>({close(){},read:()=>({available:true,sessionId:sessions.get(task.id),lastActivityAt:Date.now(),tools:[],todos:[],errors:[],
      usage:{inputTokens:100,cacheReadTokens:60,outputTokens:20,modelCalls:1,lastInputTokens:behavior[task.id]?.[attempt.number-1]?.largeContext?900000:100}})}),
    runCallback:async(thread,message)=>{callbacks.push(message);return {ok:true,exitCode:0};}
  };
  return {project,raw,plan,deps,captures,callbacks,gate,events:()=>fs.readFileSync(path.join(project,'.zcode-dispatch/worker-events.jsonl'),'utf8').trim().split('\n').map(JSON.parse)};
}

test('contracts require explicit acceptance/check mappings and reject cycles/escaping ownership',t=>{
  const f=fixture(t);
  assert.throws(()=>validatePlan({...f.raw,tasks:[{...f.raw.tasks[0],checks:[]}]}),/acceptance command/);
  assert.throws(()=>validatePlan({...f.raw,tasks:[{...f.raw.tasks[0],acceptance:[{description:'works',checks:['invented']}]}]}),/unknown checks/);
  assert.throws(()=>validatePlan({...f.raw,tasks:[{...f.raw.tasks[0],dependsOn:['a']}]}),/cycle/);
  assert.throws(()=>validatePlan({...f.raw,tasks:[{...f.raw.tasks[0],writePaths:['../outside']}]}),/escapes/);
  assert.throws(()=>validatePlan({...f.raw,tasks:[{...f.raw.tasks[0],writePaths:['gates']}]}),/pinned/);
  assert.throws(()=>validatePlan({...f.raw,auditPaths:['src']}),/auditPaths/);
  assert.throws(()=>validatePlan({...f.raw,artifactPaths:['src']}),/disposable/);
  assert.throws(()=>validatePlan({...f.raw,auditPaths:['src','gates'],protectedPaths:['documentation']}),/protectedPaths/);
  assert.equal(f.plan.tasks[0].worker.zcodeEffort,'max');
  assert.throws(()=>validatePlan({...f.raw,tasks:[{...f.raw.tasks[0],onBlocked:'ignore'}]}),/onBlocked/);
  assert.throws(()=>validatePlan({...f.raw,tasks:[{...f.raw.tasks[0],checks:[{...f.raw.tasks[0].checks[0],runOnBlocked:'yes'}]}]}),/runOnBlocked/);
});

test('a blocked external task saves opted-in local evidence and continues independent work',async t=>{
  const f=fixture(t,{ids:['external','local','dependent'],dependencies:{dependent:['external']},extra:{maxParallel:1},behavior:{external:[{report:'CONTRACT_BLOCKED: provider capability requires human disposition'}]}});
  const task=f.raw.tasks[0];task.onBlocked='human';task.checks[0].runOnBlocked=true;
  const sentinel=path.join(f.project,'.zcode-dispatch','external-check-ran');
  task.checks.push({name:'external output',command:process.execPath,args:['-e',`require('fs').writeFileSync(${JSON.stringify(sentinel)},'sent')`]});
  task.acceptance.push({id:'external-result',description:'External output exists',checks:['external output']});
  const plan=validatePlan(f.raw),state=await executePlan(plan,f.deps);
  assert.equal(state.status,'needs_replan');assert.equal(state.tasks.local.status,'accepted');assert.equal(state.tasks.dependent.status,'pending');
  assert.deepEqual(f.captures.map(x=>x.id),['external','local']);assert.equal(fs.existsSync(sentinel),false);
  const receipt=readJson(state.tasks.external.attempts[0].gateReceipt);
  assert.equal(receipt.passed,false);assert.equal(receipt.purpose,'blocked_evidence');
  assert.deepEqual(receipt.coverage,[{id:'correct',status:'passed'},{id:'external-result',status:'not_run'}]);
  assert.equal(state.tasks.external.acceptedEvidence,null);assert.equal(state.finalValidation,null);assert.equal(state.error.kind,'contract_decision');
  // Continuing another branch cannot re-submit the human-blocked task.
  const next=validatePlan({...f.raw,runId:'continued',resumeFrom:plan.runDir});
  const second=await executePlan(next,f.deps);
  assert.equal(f.captures.length,2);assert.equal(second.tasks.external.attempts.length,1);assert.equal(second.tasks.local.status,'accepted');
});

test('independent failed local checks are corrected before surfacing an external blocker',async t=>{
  const f=fixture(t,{behavior:{a:[{value:'wrong',report:'CONTRACT_BLOCKED: external result unavailable'},{value:'ok',report:'CONTRACT_BLOCKED: external result unavailable'}]}});
  f.raw.tasks[0].onBlocked='human';f.raw.tasks[0].checks[0].runOnBlocked=true;
  const state=await executePlan(validatePlan(f.raw),f.deps);
  assert.equal(state.status,'needs_replan');assert.equal(f.captures.length,2);assert.equal(state.corrections,1);
  assert.equal(readJson(state.tasks.a.attempts[0].gateReceipt).coverage[0].status,'failed');
  assert.equal(readJson(state.tasks.a.attempts[1].gateReceipt).coverage[0].status,'passed');
  assert.equal(state.tasks.a.blockedDecision.route,'human');assert.equal(state.tasks.a.status,'needs_replan');
});

test('blocked workers do not trigger unmarked checks or conflicting pending writers',async t=>{
  const f=fixture(t,{ids:['a','b'],extra:{maxParallel:1},behavior:{a:[{report:'CONTRACT_BLOCKED: shared interface requires a decision'}]}});
  f.raw.tasks[1].readPaths=['src/a.txt'];
  const state=await executePlan(validatePlan(f.raw),f.deps);
  assert.equal(f.captures.length,1);assert.equal(state.tasks.b.status,'pending');assert.equal(state.gateRuns,0);
  assert.equal(state.tasks.a.attempts[0].gateReceipt,undefined);
});

test('ownership failures stop independent work even when the worker also reports a blocker',async t=>{
  const f=fixture(t,{ids:['a','b'],extra:{maxParallel:1},behavior:{a:[{tamper:true,report:'CONTRACT_BLOCKED: external failure'}]}});
  const state=await executePlan(f.plan,f.deps);
  assert.equal(f.captures.length,1);assert.equal(state.tasks.b.status,'pending');assert.equal(state.tasks.a.blockedDecision,null);
  assert.match(state.error.message,/pinned|gate/);
});

test('read-only preflight rejects stale continuation and unrecorded budget changes before launch',async t=>{
  const f=fixture(t);await executePlan(f.plan,f.deps);
  const ledger=path.join(f.project,'.zcode-dispatch','contract-objectives',f.plan.objectiveId,'state.json');
  const before=fs.readFileSync(ledger,'utf8');
  const next=validatePlan({...f.raw,runId:'preview',resumeFrom:f.plan.runDir});
  preflightPlan(next);assert.equal(fs.existsSync(next.runDir),false);assert.equal(fs.readFileSync(ledger,'utf8'),before);
  assert.throws(()=>preflightPlan({...next,resumeFrom:'stale'}),/latest run/);
  assert.throws(()=>preflightPlan({...next,maxObjectiveCorrections:20}),/strategyChange/);
});
test('oversized source is rejected before launch without a runner, ledger or worker attempt',async t=>{
  const f=fixture(t);
  const file=path.join(f.project,'src','oversized.bin'), fd=fs.openSync(file,'w');
  try{fs.ftruncateSync(fd,32000001);}finally{fs.closeSync(fd);}
  assert.throws(()=>preflightPlan(f.plan),/preflight failed before launch.*oversized.bin/);
  await assert.rejects(launchPlan(f.raw),/preflight failed before launch/);
  assert.equal(fs.existsSync(f.plan.runDir),false);assert.equal(f.captures.length,0);
  const state=await executePlan(f.plan,f.deps); // Source can also change after preflight.
  assert.equal(state.error.kind,'source_audit');assert.equal(f.captures.length,0);
  assert.equal(Object.values(state.tasks).flatMap(t=>t.attempts).length,0);
  assert.ok(state.error.message.length<2000);
});

test('brief bounds legacy runaway errors without rewriting original evidence',async t=>{
  const f=fixture(t);await executePlan(f.plan,f.deps);
  const file=path.join(f.plan.runDir,'status.json'), state=readJson(file);
  state.error={kind:'workflow_error',message:'legacy failure; '.repeat(50000)};
  fs.writeFileSync(file,JSON.stringify(state));
  const result=brief(f.plan.runDir);
  assert.equal(result.error.truncated,true);assert.equal(result.error.message.length,2000);
  assert.ok(JSON.stringify(result).length<6000);
  assert.equal(readJson(file).error.message,state.error.message);
});

test('new public launches require contracts instead of silently starting Astra review',async t=>{
  const f=fixture(t);await assert.rejects(launch({project:f.project,notify:false,promptFile:f.raw.tasks[0].promptFile}),/objective/);
});

test('contract normalization preserves explicit worker effort aliases and provider choices',t=>{
  const f=fixture(t);
  assert.equal(validatePlan({...f.raw,schemaVersion:3}).tasks[0].worker.zcodeEffort,'max');
  assert.equal(validatePlan({...f.raw,worker:{effort:'high'}}).tasks[0].worker.zcodeEffort,'high');
  assert.equal(validatePlan({...f.raw,worker:{model:'other/model'}}).tasks[0].worker.zcodeEffort,null);
  const agy=validatePlan({...f.raw,worker:{workerKind:'agy',model:'agy-model',effort:'low'}}).tasks[0].worker;
  assert.equal(agy.agyEffort,'low');assert.equal(agy.expectedModel,'agy-model');assert.equal(agy.zcodeEffort,undefined);
  assert.equal(validatePlan({...f.raw,worker:{workerKind:'agy'}}).tasks[0].worker.agyModel,null);
});

for(const kind of ['zcode','agy'])test(`${kind}: gen/test/fix stays in workers and acceptance creates no Astra review`,async t=>{
  const f=fixture(t,{kinds:{a:kind},behavior:{a:[{value:'wrong'},{value:'ok'}]},notify:true});
  const state=await executePlan(f.plan,f.deps);
  assert.equal(state.status,'awaiting_judgment',JSON.stringify(state.error));assert.equal(f.captures.length,2);assert.equal(state.corrections,1);
  assert.equal(f.captures[1].resume,f.captures[0].session);assert.equal(f.callbacks.length,1);assert.match(f.callbacks[0],/Final judge: human/);
  assert.equal(fs.existsSync(path.join(f.plan.runDir,'review')),false);
  assert.equal(state.gateFailures,1);assert.equal(evaluateState(f.plan,state).routineAstraReviews,0);assert.equal(evaluateState(f.plan,state).callbackAttempts,1);
  assert.equal(evaluateState(f.plan,state).mainAstraUsage,null);assert.equal(evaluateState(f.plan,state).workerUsage.inputTokens,200);
});

test('independent writers really overlap; dependencies and integration wait for successful prerequisites',async t=>{
  const f=fixture(t,{ids:['foundation','a','b','integration'],kinds:{b:'agy'},dependencies:{a:['foundation'],b:['foundation']},integration:'integration',
    behavior:{a:[{delay:250}],b:[{delay:250}]},finalChecks:true});
  const state=await executePlan(f.plan,f.deps);assert.equal(state.status,'awaiting_judgment',JSON.stringify(state.error));
  assert.deepEqual(state.waves.map(w=>w.tasks),[['foundation'],['a','b'],['integration']]);
  const events=f.events(),start=id=>events.find(e=>e.id===id&&e.event==='start').at,end=id=>events.find(e=>e.id===id&&e.event==='end').at;
  assert.ok(start('a')<end('b')&&start('b')<end('a'));assert.ok(start('a')>=end('foundation'));assert.ok(start('integration')>=Math.max(end('a'),end('b')));
  assert.equal(f.captures.find(c=>c.id==='b').model,'fixture-agy');
});

test('read/write overlap and shared dependency edits serialize waves',async t=>{
  const f=fixture(t,{ids:['a','b']});
  const a=f.plan.tasks[0],b=f.plan.tasks[1];b.readPaths=['src/a.txt'];
  assert.equal(conflicts(a,b),true);
  const state=await executePlan(f.plan,f.deps);assert.equal(state.status,'awaiting_judgment');assert.deepEqual(state.waves.map(w=>w.tasks),[['a'],['b']]);
  assert.equal(conflicts({...a,writePaths:['package.json'],exclusive:true},b),true);
});

test('application-wide failure returns to integration worker without a strategic callback',async t=>{
  const f=fixture(t,{ids:['a','integration'],integration:'integration',finalChecks:true,notify:true,behavior:{integration:[{value:'almost'},{value:'ok'}]}});
  const state=await executePlan(f.plan,f.deps);
  assert.equal(state.status,'awaiting_judgment',JSON.stringify(state.error));assert.equal(state.integrationFailures,1);
  assert.equal(f.captures.filter(c=>c.id==='integration').length,2);
  const integrationAttempt=state.tasks.integration.attempts.at(-1);
  assert.match(readJson(path.join(integrationAttempt.runDir,'contract.json')).feedback,/Integration validation failed/);
  assert.equal(f.callbacks.length,1);assert.equal(state.corrections,1);
});

test('a regressed component remains unaccepted until integration repairs it and its gate passes again',async t=>{
  const f=fixture(t,{ids:['a','integration'],integration:'integration',notify:true,behavior:{integration:[{extraWrites:{a:'regression'}},{extraWrites:{a:'ok'}}]}});
  f.raw.tasks[1].writePaths.push('src/a.txt');const plan=validatePlan(f.raw);
  const state=await executePlan(plan,f.deps);
  assert.equal(state.status,'awaiting_judgment',JSON.stringify(state.error));assert.equal(state.integrationFailures,1);
  assert.equal(state.tasks.a.status,'accepted');assert.equal(state.tasks.integration.attempts.length,2);assert.equal(f.callbacks.length,1);
  assert.equal(fs.readFileSync(path.join(f.project,'src/a.txt'),'utf8'),'ok');
});

test('disposable build artifacts may change while acceptance source remains immutable',async t=>{
  const f=fixture(t,{extra:{artifactPaths:['dist']}});
  fs.appendFileSync(f.gate,"\nfs.mkdirSync(project+'/dist',{recursive:true});fs.writeFileSync(project+'/dist/bundle.js','generated');\n");
  const state=await executePlan(f.plan,f.deps);assert.equal(state.status,'awaiting_judgment',JSON.stringify(state.error));
  assert.ok(fs.existsSync(path.join(f.project,'dist/bundle.js')));
});

test('an acceptance command that mutates source cannot authorize acceptance',async t=>{
  const f=fixture(t);fs.appendFileSync(f.gate,"\nfs.writeFileSync(file,'changed by checker');\n");
  const state=await executePlan(f.plan,f.deps);assert.equal(state.status,'needs_replan');assert.match(state.error.message,/changed source/);assert.equal(f.captures.length,1);
});

test('worker success claims do not pass a failing pinned gate; dependent tasks remain unstarted',async t=>{
  const f=fixture(t,{ids:['a','b'],dependencies:{b:['a']},behavior:{a:[{value:'wrong'},{value:'wrong'},{value:'wrong'}]},notify:true});
  const state=await executePlan(f.plan,f.deps);assert.equal(state.status,'needs_replan');assert.equal(f.captures.length,3);assert.ok(f.captures.every(c=>c.id==='a'));
  assert.equal(state.tasks.b.status,'pending');assert.equal(state.finalValidation,null);assert.equal(f.callbacks.length,1);
});

test('tampered acceptance files are caught before executing modified gates',async t=>{
  const f=fixture(t,{behavior:{a:[{tamper:true}]}}),state=await executePlan(f.plan,f.deps);
  assert.equal(state.status,'needs_replan');assert.match(state.error.message,/scope|pinned|dependency|acceptance/i);
  assert.equal(state.gateRuns,0);assert.equal(fs.existsSync(path.join(f.project,'.zcode-dispatch/gate-events.jsonl')),false);
});

test('out-of-scope writes invalidate the wave and rollback refuses to guess ownership',async t=>{
  const f=fixture(t,{behavior:{a:[{unowned:true}]}}),state=await executePlan(f.plan,f.deps);
  assert.equal(state.status,'needs_replan');assert.equal(state.error.kind,'ownership_violation');
  await assert.rejects(manage('rollback',{'run-dir':f.plan.runDir,wave:'1'}),/unowned/);
});

test('scope checkpoint rollback preserves pre-existing dirty contents and refuses later changes',async t=>{
  const f=fixture(t);fs.writeFileSync(path.join(f.project,'src/a.txt'),'user-starting-content');
  const state=await executePlan(f.plan,f.deps);assert.equal(state.status,'awaiting_judgment');
  fs.writeFileSync(path.join(f.project,'src/user.txt'),'later user edit');
  await assert.rejects(manage('rollback',{'run-dir':f.plan.runDir,wave:'1'}),/changed after/);
  assert.equal(fs.readFileSync(path.join(f.project,'src/a.txt'),'utf8'),'ok');
  fs.writeFileSync(path.join(f.project,'src/user.txt'),'pre-existing user edit');
  const result=await manage('rollback',{'run-dir':f.plan.runDir,wave:'1'});assert.equal(result.status,'rolled_back');
  assert.equal(fs.readFileSync(path.join(f.project,'src/a.txt'),'utf8'),'user-starting-content');
  assert.equal(fs.readFileSync(path.join(f.project,'src/user.txt'),'utf8'),'pre-existing user edit');
});

test('final judgment is explicit, bound to validated source, and cannot accept incomplete work',async t=>{
  const f=fixture(t);await executePlan(f.plan,f.deps);const report=path.join(f.project,'.zcode-dispatch/judgment.md');fs.writeFileSync(report,'User inspected the complete application and accepted its behavior.');
  await assert.rejects(manage('judge',{'run-dir':f.plan.runDir,actor:'astra',verdict:'accepted','report-file':report}),/actor/);
  fs.writeFileSync(path.join(f.project,'src/a.txt'),'later change');
  await assert.rejects(manage('judge',{'run-dir':f.plan.runDir,actor:'human',verdict:'accepted','report-file':report}),/Source changed/);
  fs.writeFileSync(path.join(f.project,'src/a.txt'),'ok');
  const result=await manage('judge',{'run-dir':f.plan.runDir,actor:'human',verdict:'accepted','report-file':report});assert.equal(result.status,'complete');
  assert.equal((await manage('eval',{'run-dir':f.plan.runDir})).objectiveComplete,true);
});

test('task/goal limits survive a new run and fresh contexts; no restart through a new ID',async t=>{
  const f=fixture(t,{behavior:{a:[{value:'wrong'},{value:'wrong'},{value:'wrong'}]}});await executePlan(f.plan,f.deps);
  await assert.rejects(executePlan({...f.plan,runId:'duplicate',runDir:path.join(f.project,'.zcode-dispatch/duplicate')},f.deps),/already exists/);
  const next=validatePlan({...f.raw,runId:'second',resumeFrom:f.plan.runDir,tasks:f.raw.tasks.map(t=>({...t,maxAttempts:4})),strategyChange:'Use the failing gate evidence to fix the incorrect result.',maxObjectiveCorrections:2});
  const oldCount=f.captures.length,state=await executePlan(next,f.deps);
  assert.equal(state.status,'needs_replan');assert.equal(f.captures.length,oldCount);assert.equal(state.corrections,2);
});

test('final gates and product criteria cannot be silently weakened in a continuation',async t=>{
  const f=fixture(t,{finalChecks:true});await executePlan(f.plan,f.deps);
  const next=validatePlan({...f.raw,runId:'weakened',resumeFrom:f.plan.runDir,finalChecks:[],judgmentCriteria:['Only the page title matters.']});
  await assert.rejects(executePlan(next,f.deps),/final gates, judgment criteria/);assert.equal(f.captures.length,1);
  await assert.rejects(manage('resume',{'run-dir':f.plan.runDir,effort:'low'}),/Unsupported contract/);
});

test('quota blockers persist across resume and never consume a reset or switch provider',async t=>{
  const f=fixture(t,{behavior:{a:[{quota:true}]}}),state=await executePlan(f.plan,f.deps);
  assert.equal(state.status,'blocked');assert.equal(f.captures.length,1);assert.equal(state.finalValidation,null);
  await assert.rejects(executePlan({...f.plan,runId:'resume',runDir:path.join(f.project,'.zcode-dispatch/resume'),resumeFrom:f.plan.runDir},f.deps),/Reconcile/);
  assert.equal(f.captures.length,1);
});

test('large worker context starts a fresh session while retaining the same contract and correction count',async t=>{
  const f=fixture(t,{behavior:{a:[{value:'wrong',largeContext:true},{value:'ok'}]}}),state=await executePlan(f.plan,f.deps);
  assert.equal(state.status,'awaiting_judgment');assert.equal(f.captures[1].resume,null);assert.notEqual(f.captures[0].session,f.captures[1].session);assert.equal(state.corrections,1);
});

test('stop controls the whole graph and leaves no automatic continuation',async t=>{
  const f=fixture(t,{ids:['a','b'],behavior:{a:[{delay:20000}],b:[{delay:20000}]} });let control;
  const running=executePlan(f.plan,{...f.deps,onControl:c=>{control=c;}});
  await until(()=>{try{return f.events().filter(e=>e.event==='start').length===2;}catch{return false;}});
  const starts=f.events().filter(e=>e.event==='start');
  assert.throws(()=>acquireProjectLock({...f.plan,runId:'conflict'}),/lock already exists/);
  await control.stop();const state=await running;
  assert.equal(state.status,'cancelled');assert.equal(state.workerExited,true);assert.equal(f.captures.length,2);
  assert.ok(starts.every(e=>!alive(e.pid)));assert.equal(fs.existsSync(path.join(f.project,'.zcode-dispatch/active-run.lock')),false);
});

test('root dashboard reports the contract workflow and its final judgment boundary',async t=>{
  const f=fixture(t);await executePlan(f.plan,f.deps);
  const registry=path.join(f.project,'.zcode-dispatch/dashboard');const key=registerRun(f.plan.runDir,registry);
  const record=readRun({key,runDir:f.plan.runDir},{telemetry:false});assert.equal(record.workerLabel,'Contract dispatcher');assert.equal(record.status,'awaiting_judgment');assert.equal(record.active,false);
  assert.equal(brief(f.plan.runDir).tasks[0].attempts,1);
});

test('the public launch CLI defaults to contract mode and executes real subprocess gates with no model calls',async t=>{
  const f=fixture(t),adapter=path.join(f.project,'native-fixture.mjs'),catalog=path.join(f.project,'catalog.json');
  fs.writeFileSync(catalog,JSON.stringify({model:'fixture/fixture-model',provider:{fixture:{models:{'fixture-model':{}}}}}));
  fs.writeFileSync(adapter,`import fs from 'node:fs';const a=process.argv.slice(2),prompt=a[a.indexOf('--prompt')+1],project=a[a.indexOf('--cwd')+1];
fs.writeFileSync(project+'/src/a.txt','ok');console.log(JSON.stringify({sessionId:'sess_transport',response:prompt.match(/^Stage: .+$/m)[0]+'\\n'+prompt.match(/^Contract: .+$/m)[0]}));`);
  const raw={...f.raw,adapter,cliConfig:catalog,expectedModel:'fixture-model',expectedProvider:'fixture',zcodeEffort:null};
  const file=path.join(f.project,'launch.json');fs.writeFileSync(file,JSON.stringify(raw));
  const hubRoot=path.join(f.project,'.zcode-dispatch/hub');
  const child=spawn(process.execPath,[fileURLToPath(new URL('./run.mjs',import.meta.url)),'launch','--config',file],{env:{...process.env,ZCODE_DASHBOARD_ROOT:hubRoot},windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
  let output='',error='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>error+=x);const [code]=await once(child,'close');
  let hub;try{
    assert.equal(code,0,error);const receipt=JSON.parse(output);assert.equal(receipt.reviewMode,'contract',JSON.stringify(receipt));
    hub=readJson(path.join(hubRoot,'hub.json'));const state=await until(()=>{try{const s=readJson(path.join(receipt.runDir,'status.json'));return !s.loopActive?s:null;}catch{return null;}});
    assert.equal(state.status,'awaiting_judgment',JSON.stringify(state.error));assert.equal(state.gateRuns,2);assert.equal(Object.keys(state.notifications).length,0);
    await until(()=>!alive(state.runnerPid));
  }finally{if(hub){try{process.kill(hub.pid);}catch{}}}
});

test('content-addressed checkpoints deduplicate unchanged source and preserve dirty content on rollback',async t=>{
  const f=fixture(t);f.plan.storageRoot=path.join(f.project,'.zcode-dispatch','store');
  const before=await capture(f.plan),one=path.join(f.plan.runDir,'waves','wave-1'),two=path.join(f.plan.runDir,'waves','wave-2');
  writeCheckpoint(f.plan,before,one);writeCheckpoint(f.plan,before,two);
  const objectFiles=fs.readdirSync(path.join(f.plan.storageRoot,'objects'),{recursive:true}).filter(x=>/^[a-f0-9]{2}[\\/][a-f0-9]{64}$/.test(x));
  assert.equal(objectFiles.length,new Set(Object.values(before.files).map(x=>x.hash)).size);assert.equal(fs.existsSync(path.join(one,'files')),false);
  fs.writeFileSync(path.join(f.project,'src/user.txt'),'changed');
  fs.writeFileSync(path.join(one,'after.json'),JSON.stringify(await capture(f.plan)));
  await restoreCheckpoint(f.plan,{directory:one,writePaths:['src/user.txt']});
  assert.equal(fs.readFileSync(path.join(f.project,'src/user.txt'),'utf8'),'pre-existing user edit');
});

test('provider changes retain attempts and budget but never reuse a foreign session',async t=>{
  const f=fixture(t,{kinds:{a:'agy'},behavior:{a:[{report:'CONTRACT_BLOCKED: need provider change'}]}});
  const first=await executePlan(f.plan,f.deps);assert.equal(first.status,'needs_replan');
  const next=validatePlan({...f.raw,runId:'switched',resumeFrom:f.plan.runDir,tasks:f.raw.tasks.map(x=>({...x,worker:{workerKind:'zcode'}}))});
  const second=await executePlan(next,f.deps);
  assert.equal(second.status,'awaiting_judgment',JSON.stringify(second.error));assert.equal(second.tasks.a.attempts.length,2);assert.equal(second.corrections,1);
  assert.equal(f.captures.at(-1).resume,null);assert.match(f.captures.at(-1).session,/^sess_/);
});

test('external runtime keeps source files in checkout and long acceptance stays in complete contract file',async t=>{
  const f=fixture(t);const runtime=fs.mkdtempSync(path.join(root,'runtime-'));t.after(()=>fs.rmSync(runtime,{recursive:true,force:true}));
  const raw={...f.raw,runDir:path.join(runtime,'run'),runtimeRoot:runtime,storageRoot:runtime,ledgerRoot:path.join(runtime,'objectives')};
  raw.tasks[0].acceptance=Array.from({length:18},(_,i)=>({id:'criterion-'+i,description:'Required outcome '+('specific invariant '.repeat(40)),checks:['behavior']}));
  const plan=validatePlan(raw),state=await executePlan(plan,f.deps);assert.equal(state.status,'awaiting_judgment',JSON.stringify(state.error));
  assert.equal(fs.readFileSync(path.join(f.project,'src/a.txt'),'utf8'),'ok');assert.equal(fs.existsSync(path.join(plan.runDir,'src')),false);
  const contract=readJson(path.join(state.tasks.a.attempts[0].runDir,'contract.json'));assert.equal(contract.acceptance.length,18);assert.ok(f.captures[0].prompt.length<12000);
});
