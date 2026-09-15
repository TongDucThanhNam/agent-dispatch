import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {readModelCatalog, resolveZCodeSelection, resolveZCodeEffort, verifyConfiguredModel, buildZCodeInvocation, nextRunConfig} from './model-selection.mjs';
import {validateConfig, supervise} from './run.mjs';
import {createModelConfigOverlay} from './model-config-loader.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'zcode-model-selection-'));
  const cliConfig=path.join(root,'global.json');
  const saved={model:'provider-b/model-b',provider:{
    'provider-a':{options:{apiKey:'fixture-secret-must-not-be-returned'},models:{'model-a':{},shared:{}}},
    'provider-b':{models:{'model-b':{},shared:{}}}
  }};
  fs.writeFileSync(cliConfig,JSON.stringify(saved));
  // Isolated fixture records are retained when diagnosing a failure.
  return {root,cliConfig,saved};
}

test('explicit bare models resolve only one configured provider; full IDs disambiguate without returning credentials', t=>{
  const {cliConfig}=fixture(t),catalog=readModelCatalog(cliConfig);
  assert.equal(catalog.length,4);assert.ok(!JSON.stringify(catalog).includes('fixture-secret'));
  assert.deepEqual(resolveZCodeSelection({model:'model-a'},cliConfig),{expectedModel:'model-a',expectedProvider:'provider-a'});
  assert.throws(()=>resolveZCodeSelection({model:'shared'},cliConfig),/multiple providers/);
  assert.deepEqual(resolveZCodeSelection({model:'provider-b/shared'},cliConfig),{expectedModel:'shared',expectedProvider:'provider-b'});
  assert.throws(()=>resolveZCodeSelection({model:'unknown'},cliConfig),/not configured/);
  assert.throws(()=>resolveZCodeSelection({model:'provider-a/model-a',provider:'provider-b'},cliConfig),/conflicts/);
  assert.throws(()=>resolveZCodeSelection({model:'model-a --other'},cliConfig),/Invalid model/);
});

test('legacy saved model stays pinned despite a different shared default; an explicit override replaces that selection', t=>{
  const {cliConfig}=fixture(t),previous={expectedProvider:'provider-a',expectedModel:'model-a'};
  assert.deepEqual(resolveZCodeSelection(previous,cliConfig),previous);
  assert.doesNotThrow(()=>verifyConfiguredModel({...previous,cliConfig}));
  assert.deepEqual(resolveZCodeSelection({...previous,model:'model-b'},cliConfig),{expectedProvider:'provider-b',expectedModel:'model-b'});
  assert.throws(()=>verifyConfiguredModel({...previous,expectedModel:'removed-model',cliConfig}),/no longer configured/);
});

test('child process gets its own exact model and configured provider endpoint without mutating inherited environment',()=>{
  const inherited={ZCODE_MODEL:'provider-b/model-b',zcode_model:'provider-b/shared',ZCODE_BASE_URL:'https://unrelated.invalid',Path:'keep-this',CUSTOM:'also-keep'};
  const before={...inherited},config={adapter:'adapter.mjs',project:'C:/A Project',mode:'yolo',expectedProvider:'provider-a',expectedModel:'model-a',resumeSessionId:'sess_original'};
  const prompt='Keep "quotes", $HOME and\nmultiple lines.';
  const a=buildZCodeInvocation(config,prompt,inherited),b=buildZCodeInvocation({...config,expectedProvider:'provider-b',expectedModel:'model-b'},prompt,inherited);
  assert.equal(a.env.ZCODE_MODEL,'');assert.equal(b.env.ZCODE_MODEL,'');
  assert.equal(JSON.parse(a.env.ZCODE_DELEGATE_SELECTION).model,'model-a');assert.equal(JSON.parse(b.env.ZCODE_DELEGATE_SELECTION).model,'model-b');
  assert.ok(a.env.NODE_OPTIONS.includes('model-config-loader.mjs'));
  assert.equal(a.env.ZCODE_BASE_URL,inherited.ZCODE_BASE_URL);assert.equal(a.env.zcode_model,undefined);assert.equal(a.env.Path,'keep-this');assert.deepEqual(inherited,before);
  assert.equal(a.args[a.args.indexOf('--prompt')+1],prompt);assert.equal(a.args[a.args.indexOf('--resume')+1],'sess_original');
  assert.ok(!a.args.includes('--continue'));
});

test('resume preserves project/session/model by default, permits explicit ZCode switches, and refuses uncertain workers',()=>{
  const previous={workerKind:'zcode',project:'C:/project-a',runId:'old',runDir:'C:/project-a/old',expectedProvider:'provider-a',expectedModel:'model-a'};
  const status={workerExited:true,sessionId:'sess_original'};
  const next=nextRunConfig(previous,status,{promptFile:'next.md'});
  assert.equal(next.project,previous.project);assert.equal(next.expectedModel,'model-a');assert.equal(next.resumeSessionId,'sess_original');assert.equal(next.runDir,undefined);
  const changed=nextRunConfig(previous,status,{promptFile:'next.md',model:'provider-b/model-b'});assert.equal(changed.model,'provider-b/model-b');assert.equal(changed.resumeSessionId,'sess_original');
  assert.throws(()=>nextRunConfig(previous,{...status,workerExited:false},{promptFile:'next.md'}),/Cannot resume/);
  assert.throws(()=>nextRunConfig(previous,status,{provider:'provider-b'}),/Supply --model/);
  assert.throws(()=>nextRunConfig({...previous,workerKind:'agy'},status,{model:'model-b'}),/ZCode runs only/);
});

test('two real local worker processes use different pinned models and resume after shared-default changes',async t=>{
  const {root,cliConfig,saved}=fixture(t),adapter=path.join(root,'fake-native.mjs');
  fs.writeFileSync(adapter,`import fs from 'node:fs';import path from 'node:path';
const args=process.argv.slice(2),project=args[args.indexOf('--cwd')+1],at=args.indexOf('--resume'),sessionId=at>=0?args[at+1]:'sess_'+path.basename(project);
const selection=JSON.parse(process.env.ZCODE_DELEGATE_SELECTION);
fs.writeFileSync(path.join(project,'capture.json'),JSON.stringify({selected:selection.provider+'/'+selection.model,sessionId,args}));
await new Promise(r=>setTimeout(r,120));process.stdout.write(JSON.stringify({sessionId,response:'Local fixture completed'}));`);
  const make=(name,model)=>{const project=path.join(root,name);fs.mkdirSync(project);const promptFile=path.join(project,'brief.md');fs.writeFileSync(promptFile,'Local fixture only.');return validateConfig({project,promptFile,model,adapter,cliConfig,notify:false,reviewMode:'main-review',keepOpenMs:0,pollMs:100,quietMs:1000,stallMs:2000});};
  const a=make('a','provider-a/model-a'),b=make('b','provider-b/model-b');
  const deps=config=>({telemetryFactory:()=>({read:()=>({available:true,sessionId:config.resumeSessionId??'sess_'+path.basename(config.project),model:config.expectedModel,provider:config.expectedProvider,lastActivityAt:Date.now(),errors:[],tools:[],todos:[]}),close(){}})});
  const first=await Promise.all([supervise(a,deps(a)),supervise(b,deps(b))]);assert.deepEqual(first.map(s=>s.status),['ready_for_review','ready_for_review']);
  const capture=config=>JSON.parse(fs.readFileSync(path.join(config.project,'capture.json'),'utf8'));
  assert.equal(capture(a).selected,'provider-a/model-a');assert.equal(capture(b).selected,'provider-b/model-b');
  saved.model='provider-b/shared';fs.writeFileSync(cliConfig,JSON.stringify(saved));const sharedBefore=fs.readFileSync(cliConfig);
  const resumeA=validateConfig(nextRunConfig(a,first[0],{promptFile:a.promptFile})),resumeB=validateConfig(nextRunConfig(b,first[1],{promptFile:b.promptFile}));
  const resumed=await Promise.all([supervise(resumeA,deps(resumeA)),supervise(resumeB,deps(resumeB))]);assert.deepEqual(resumed.map(s=>s.status),['ready_for_review','ready_for_review']);
  assert.equal(capture(a).selected,'provider-a/model-a');assert.equal(capture(b).selected,'provider-b/model-b');assert.equal(capture(a).sessionId,first[0].sessionId);assert.equal(capture(b).sessionId,first[1].sessionId);
  const switchA=validateConfig(nextRunConfig(resumeA,resumed[0],{promptFile:a.promptFile,model:'provider-b/model-b'}));assert.equal((await supervise(switchA,deps(switchA))).status,'ready_for_review');
  assert.equal(capture(a).selected,'provider-b/model-b');assert.equal(capture(a).sessionId,first[0].sessionId);assert.deepEqual(fs.readFileSync(cliConfig),sharedBefore);
});

test('config overlay retains complete provider settings and changes only the assigned main model in memory',t=>{
  const {root,cliConfig,saved}=fixture(t),project=path.join(root,'project');fs.mkdirSync(path.join(project,'.zcode'),{recursive:true});
  saved.provider['provider-a'].kind='openai-compatible';saved.provider['provider-a'].options.baseURL='https://fixture.invalid/v1';
  saved.provider['provider-a'].headers={'x-fixture':'preserved'};saved.model={main:'provider-b/model-b',lite:'provider-b/shared'};
  fs.writeFileSync(cliConfig,JSON.stringify(saved));const before=fs.readFileSync(cliConfig);
  const projectConfig=path.join(project,'.zcode/config.json');fs.writeFileSync(projectConfig,JSON.stringify({model:'provider-b/model-b',permission:{mode:'plan'}}));
  const projectBefore=fs.readFileSync(projectConfig),ordinary=path.join(project,'config.json');fs.writeFileSync(ordinary,'ordinary tool file');
  const read=createModelConfigOverlay({configPath:cliConfig,project,provider:'provider-a',model:'model-a'});
  const effective=JSON.parse(read(cliConfig,'utf8'));
  assert.equal(effective.model.main,'provider-a/model-a');assert.equal(effective.model.lite,'provider-b/shared');
  assert.deepEqual(effective.provider,saved.provider);assert.equal(effective.provider['provider-a'].options.apiKey,'fixture-secret-must-not-be-returned');
  const local=JSON.parse(read(projectConfig,'utf8'));assert.equal(local.model,'provider-a/model-a');assert.deepEqual(local.provider['provider-a'],saved.provider['provider-a']);assert.equal(local.permission.mode,'plan');
  assert.equal(read(ordinary,'utf8'),'ordinary tool file');assert.ok(Buffer.isBuffer(read(cliConfig)));
  assert.deepEqual(fs.readFileSync(cliConfig),before);assert.deepEqual(fs.readFileSync(projectConfig),projectBefore);
});

test('native child preload restores provider credentials without exporting them or affecting descendant tools',async t=>{
  const {root,cliConfig}=fixture(t),native=path.join(root,'zcode.cjs'),descendant=path.join(root,'tool.cjs');
  fs.writeFileSync(descendant,`console.log(JSON.stringify({selection:process.env.ZCODE_DELEGATE_SELECTION??null,nodeOptions:process.env.NODE_OPTIONS??'',model:require('node:fs').readFileSync(process.argv[2],'utf8')}));`);
  fs.writeFileSync(native,`const fs=require('node:fs'),{spawnSync}=require('node:child_process');const c=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));const child=spawnSync(process.execPath,[process.argv[3],process.argv[2]],{encoding:'utf8',windowsHide:true});const tool=JSON.parse(child.stdout);console.log(JSON.stringify({model:c.model,credentialPreserved:c.provider['provider-a'].options.apiKey==='fixture-secret-must-not-be-returned',selection:process.env.ZCODE_DELEGATE_SELECTION??null,toolModel:JSON.parse(tool.model).model,toolSelection:tool.selection,toolNodeOptions:tool.nodeOptions}));`);
  const before=fs.readFileSync(cliConfig),invocation=buildZCodeInvocation({project:root,cliConfig,expectedProvider:'provider-a',expectedModel:'model-a'},'',{...process.env,NODE_OPTIONS:'--no-warnings'});
  assert.ok(!JSON.stringify(invocation.env).includes('fixture-secret'));
  const child=spawn(process.execPath,[native,cliConfig,descendant],{env:invocation.env,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});let output='',error='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>error+=x);const [code]=await once(child,'close');
  assert.equal(code,0,error);const result=JSON.parse(output);assert.equal(result.model,'provider-a/model-a');assert.equal(result.credentialPreserved,true);assert.equal(result.selection,null);assert.equal(result.toolSelection,null);assert.equal(result.toolModel,'provider-b/model-b');assert.equal(result.toolNodeOptions,'--no-warnings');assert.deepEqual(fs.readFileSync(cliConfig),before);assert.ok(!output.includes('fixture-secret'));
});

test('the models CLI lists usable qualified IDs without provider secrets',async t=>{
  const {cliConfig}=fixture(t),runner=fileURLToPath(new URL('./run.mjs',import.meta.url));
  const child=spawn(process.execPath,[runner,'models','--cli-config',cliConfig],{windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']});
  let output='',error='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>error+=x);const [code]=await once(child,'close');
  assert.equal(code,0,error);assert.ok(JSON.parse(output).models.some(x=>x.id==='provider-a/model-a'));assert.ok(!output.includes('fixture-secret'));
});

test('new Flash launches default to max, explicit effort wins, and old configurations inherit',t=>{
  const {root}=fixture(t),raw={project:root,notify:false};
  assert.equal(validateConfig(raw).zcodeEffort,'max');
  assert.equal(validateConfig({...raw,effort:'max'}).zcodeEffort,'max');
  assert.equal(validateConfig({...raw,zcodeEffort:'low'}).zcodeEffort,'low');
  assert.equal(validateConfig({...raw,zcodeEffort:null}).zcodeEffort,null);
  assert.equal(validateConfig({...raw,schemaVersion:1}).zcodeEffort,null);
  assert.equal(validateConfig({...raw,resumeSessionId:'sess_saved'}).zcodeEffort,null);
  assert.equal(validateConfig(validateConfig(raw)).zcodeEffort,'max');
  assert.equal(validateConfig({...raw,expectedModel:'another-model'}).zcodeEffort,null);
  assert.throws(()=>validateConfig({...raw,effort:'medium'}),/Invalid ZCode effort/);
  assert.throws(()=>validateConfig({...raw,expectedModel:'another-model',effort:'high'}),/GLM-5.3-Flash only/);
  assert.equal(resolveZCodeEffort({},'glm-5.3-flash'),'max');
  const agy=validateConfig({...raw,workerKind:'agy',model:'claude-test',effort:'medium'});
  assert.equal(agy.agyEffort,'medium');assert.equal(agy.zcodeEffort,undefined);
  assert.equal(agy.reviewEffort,'medium');
});

test('resume preserves worker effort and permits deliberate same-session escalation',t=>{
  const {root}=fixture(t),previous=validateConfig({project:root,notify:false,zcodeEffort:'high'});
  const status={workerExited:true,sessionId:'sess_original'};
  const next=validateConfig(nextRunConfig(previous,status,{promptFile:previous.promptFile}));
  assert.equal(next.zcodeEffort,'high');assert.equal(next.resumeSessionId,status.sessionId);
  const raised=validateConfig(nextRunConfig(next,status,{promptFile:next.promptFile,effort:'max'}));
  assert.equal(raised.zcodeEffort,'max');assert.equal(raised.expectedModel,previous.expectedModel);assert.equal(raised.reviewEffort,'medium');
  assert.equal(JSON.parse(buildZCodeInvocation(raised,'fixture').env.ZCODE_DELEGATE_SELECTION).effort,'max');
  const old={...previous};delete old.zcodeEffort;
  assert.equal(validateConfig(nextRunConfig(old,status,{promptFile:old.promptFile})).zcodeEffort,null);
  assert.equal(nextRunConfig(previous,status,{model:'other/model',promptFile:previous.promptFile}).zcodeEffort,null);
  assert.throws(()=>nextRunConfig({...previous,workerKind:'agy'},status,{effort:'max'}),/ZCode runs only/);
});

test('effort overlays pin the provider protocol and survive a project override without writing settings',t=>{
  const {root,cliConfig,saved}=fixture(t),project=path.join(root,'project');fs.mkdirSync(project);
  saved.provider['provider-a'].models['GLM-5.3-Flash']={limit:{output:128000},options:{temperature:1}};
  const projectConfig=path.join(project,'zcode.json');
  fs.writeFileSync(projectConfig,JSON.stringify({modelCatalog:{overrides:{'provider-a/GLM-5.3-Flash':{contextWindow:555555,reasoning:{defaultLevel:'max'}}}},permission:{mode:'plan'}}));
  const projectBefore=fs.readFileSync(projectConfig);
  for (const kind of ['anthropic','openai-compatible']) {
    saved.provider['provider-a'].kind=kind;fs.writeFileSync(cliConfig,JSON.stringify(saved));const before=fs.readFileSync(cliConfig);
    for (const effort of ['high','max','low']) {
      const read=createModelConfigOverlay({configPath:cliConfig,project,provider:'provider-a',model:'GLM-5.3-Flash',effort});
      for (const file of [cliConfig,projectConfig]) {
        const c=JSON.parse(read(file,'utf8')),reasoning=c.provider['provider-a'].models['GLM-5.3-Flash'].reasoning;
        assert.deepEqual(reasoning.levels,[effort]);assert.equal(reasoning.defaultLevel,effort);
        const options=reasoning.providerOptionsByLevel[effort];
        assert.equal(kind==='anthropic'?options.anthropic.effort:options.openaiCompatible.reasoningEffort,effort);
        assert.equal((options.anthropic??options.openaiCompatible).thinking.type,'enabled');
        assert.equal(c.modelCatalog.overrides['provider-a/GLM-5.3-Flash'].reasoning.defaultLevel,effort);
        assert.equal(c.provider['provider-a'].models['GLM-5.3-Flash'].limit.output,128000);
        assert.deepEqual(c.provider['provider-a'].models['model-a'],saved.provider['provider-a'].models['model-a']);
        if(file===projectConfig){assert.equal(c.permission.mode,'plan');assert.equal(c.modelCatalog.overrides['provider-a/GLM-5.3-Flash'].contextWindow,555555);}
      }
    }
    assert.deepEqual(fs.readFileSync(cliConfig),before);assert.deepEqual(fs.readFileSync(projectConfig),projectBefore);
  }
  saved.provider['provider-a'].kind='openai';fs.writeFileSync(cliConfig,JSON.stringify(saved));
  assert.throws(()=>createModelConfigOverlay({configPath:cliConfig,project,provider:'provider-a',model:'GLM-5.3-Flash',effort:'high'}),/requires an anthropic or openai-compatible/);
});
