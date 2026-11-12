// @ts-nocheck: ported from the JavaScript suite; it drives loosely typed internals with partial fixtures. Runtime-checked by bun test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {modelCatalog, nativeSelection, buildNativeInvocation, verifyNative} from '../src/index.ts';
import {validateConfig, finishResult, launch, check} from '../src/index.ts';
import { nodeExecutable } from '../src/index.ts';
import { cli, rmTree } from './helpers.ts';
import { zcodeContextArgs, verifyZcodeContextSupport } from '../src/workers/zcode/context-profile.ts';
const NODE = nodeExecutable();
const make = t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-invocation-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));rmTree(root);});
  return root;
};
test('current provider registry resolves templates and overrides without exposing credentials',t=>{
  const root=make(t),builtinConfig=path.join(root,'builtin.json'),personalConfig=path.join(root,'personal.json');
  fs.writeFileSync(builtinConfig,JSON.stringify({config:{providerConfigRules:{templateRules:[{templateId:'custom',config:{builtinModelIds:['m1']}}],providerRules:[{providerId:'account:zai-individual-coding-plan',config:{builtinModelIds:['GLM-5.3-Flash']}}]}}}));
  fs.writeFileSync(personalConfig,JSON.stringify({config:{providerConfigRules:{providerRules:[{providerId:'personal',templateId:'custom',config:{access:{apiKey:'do-not-return'},personalModelIds:['m2']}},{providerId:'disabled',enabled:false,config:{personalModelIds:['m3']}}]}}}));
  const result=modelCatalog({builtinConfig,personalConfig});
  assert.deepEqual(result.map(v=>v.id),['account:zai-individual-coding-plan/GLM-5.3-Flash','personal/m1','personal/m2']);
  assert.ok(!JSON.stringify(result).includes('do-not-return'));
  assert.equal(nativeSelection({}).zcodeEffort,'max');
  assert.equal(nativeSelection({expectedProvider:'builtin:zai-coding-plan'}).expectedProvider,'account:zai-individual-coding-plan');
  assert.throws(()=>nativeSelection({model:'ambiguous'}),/qualified/);
});
test('native argv preserves multiline Unicode, quoted paths, exact resume and process-local selection',()=>{
  const config={nativeCli:'C:/Program Files/ZCode/resources/glm/zcode.cjs',project:'C:/A Project',builtinConfig:'builtin.json',personalConfig:'personal.json',cliConfig:'cli.json',dbPath:'db.sqlite',expectedProvider:'account:zai-individual-coding-plan',expectedModel:'GLM-5.3-Flash',zcodeEffort:'max',mode:'yolo',resumeSessionId:'sess_exact'};
  const prompt='Line one\nTiếng Việt "quotes" $HOME $(literal)';const env={ZCODE_MODEL:'obsolete',NODE_OPTIONS:'--no-warnings'};
  const invocation=buildNativeInvocation(config,prompt,env);
  assert.equal(invocation.args[0],config.nativeCli);assert.equal(invocation.args[invocation.args.indexOf('--prompt')+1],prompt);
  assert.equal(invocation.args[invocation.args.indexOf('--resume')+1],'sess_exact');
  assert.equal(invocation.env.ZCODE_MODEL,undefined);assert.equal(env.ZCODE_MODEL,'obsolete');assert.ok(!invocation.args.includes('native'));
  assert.equal(JSON.parse(invocation.env.ZCODE_DIRECT_SELECTION).effort,'max');
});
test('fresh ZCode workers default to files; explicit stock/null and saved or legacy resumes keep their profile',t=>{
  const project=make(t),raw={project,notify:false};
  assert.equal(validateConfig(raw).zcodeContextProfile,'files');
  assert.equal(validateConfig({...raw,zcodeContextProfile:null}).zcodeContextProfile,null);
  const fresh=validateConfig({...raw,zcodeContextProfile:'files'});assert.equal(fresh.zcodeContextProfile,'files');
  assert.equal(validateConfig({...fresh,resumeSessionId:'sess_resume'}).zcodeContextProfile,'files');
  assert.equal(validateConfig({...raw,resumeSessionId:'sess_legacy'}).zcodeContextProfile,null);
  assert.equal(validateConfig({...raw,zcodeContextProfile:'web'}).zcodeContextProfile,'web');
  assert.equal(validateConfig({...raw,zcodeContextProfile:'stock'}).zcodeContextProfile,'stock');
  assert.throws(()=>validateConfig({...raw,zcodeContextProfile:'unknown'}),/context profile/);
  assert.throws(()=>validateConfig({...raw,workerKind:'agy',zcodeContextProfile:'files'}),/ZCode-only/);
});
test('ZCode profile argv only removes tools, pins feature modes and disables the old overlay in the child',()=>{
  const base={nativeCli:'bundle.cjs',project:'C:/A Project',builtinConfig:'builtin.json',personalConfig:'personal.json',cliConfig:'cli.json',dbPath:'db.sqlite',expectedProvider:'p',expectedModel:'m',zcodeEffort:'max',mode:'plan',resumeSessionId:'sess_exact'};
  const inherited={ZCODE_CONTEXT_PROFILE:'custom',ZCODE_AGENT_SERVER_COMMAND:'desktop-unchanged',ZCODE_AGENT_SERVER_ARGS_JSON:'desktop-args-unchanged'};
  const run=buildNativeInvocation({...base,zcodeContextProfile:'files'},'Unicode tiếng Việt\n"quoted" $HOME',inherited);
  const denied=run.args[run.args.indexOf('--disallowed-tools')+1].split(',');
  for(const n of ['Agent','Task','AskUserQuestion','EnterPlanMode','ExitPlanMode','ReadSessionContext','WebFetch','WebSearch'])assert.ok(denied.includes(n));
  for(const n of ['Read','Write','Edit','Bash','TaskOutput','TaskStop','RespondToCoordinator','submit_result','escalate'])assert.ok(!denied.includes(n));
  assert.equal(run.args[run.args.indexOf('--mode')+1],'plan');assert.equal(run.args[run.args.indexOf('--resume')+1],'sess_exact');
  assert.equal(run.args[run.args.indexOf('--toolsearch-mode')+1],'off');assert.equal(run.args[run.args.indexOf('--workflow-mode')+1],'disabled');
  assert.equal(run.env.ZCODE_CONTEXT_PROFILE,'stock');assert.equal(inherited.ZCODE_CONTEXT_PROFILE,'custom');
  assert.equal(run.env.ZCODE_AGENT_SERVER_COMMAND,inherited.ZCODE_AGENT_SERVER_COMMAND);assert.equal(run.env.ZCODE_AGENT_SERVER_ARGS_JSON,inherited.ZCODE_AGENT_SERVER_ARGS_JSON);
  assert.ok(!zcodeContextArgs('web')[1].split(',').includes('WebSearch'));
  assert.ok(zcodeContextArgs('shell')[1].split(',').includes('Read'));
  assert.deepEqual(zcodeContextArgs('stock'),[]);assert.deepEqual(zcodeContextArgs(null),[]);
  assert.equal(buildNativeInvocation(base,'legacy',inherited).env.ZCODE_CONTEXT_PROFILE,'custom');
  assert.ok(!buildNativeInvocation({...base,zcodeContextProfile:'stock'},'stock',inherited).args.includes('--disallowed-tools'));
});
test('unsupported native context flags fail read-only before a worker starts; stock opts out',t=>{
  const root=make(t),nativeCli=path.join(root,'old.cjs');fs.writeFileSync(nativeCli,'// old runtime');
  assert.throws(()=>verifyZcodeContextSupport({nativeCli,zcodeContextProfile:'files'}),/context-profile stock/);
  assert.doesNotThrow(()=>verifyZcodeContextSupport({nativeCli,zcodeContextProfile:'stock'}));
  assert.equal(fs.readFileSync(nativeCli,'utf8'),'// old runtime');
  fs.writeFileSync(nativeCli,'// --disallowed-tools --toolsearch-mode --workflow-mode');
  assert.doesNotThrow(()=>verifyZcodeContextSupport({nativeCli,zcodeContextProfile:'files'}));
});
test('ZCode check reports the pinned profile and rejects unsupported flags before creating run state',async t=>{
  const root=make(t),promptFile=path.join(root,'brief.md'),nativeCli=path.join(root,'native.cjs'),builtinConfig=path.join(root,'builtin.json'),cliConfig=path.join(root,'cli.json');
  fs.writeFileSync(promptFile,'Local fixture.');fs.writeFileSync(nativeCli,'// --disallowed-tools --toolsearch-mode --workflow-mode');fs.writeFileSync(cliConfig,'{}');
  fs.writeFileSync(builtinConfig,JSON.stringify({config:{providerConfigRules:{providerRules:[{providerId:'fixture',config:{builtinModelIds:['model']}}]}}}));
  const raw={project:root,promptFile,nativeCli,builtinConfig,cliConfig,personalConfig:path.join(root,'missing-personal.json'),model:'fixture/model',notify:false,zcodeContextProfile:'files'};
  const result=await check(raw);assert.equal(result.contextProfile,'files');assert.equal(result.startsWorker,false);
  assert.equal(fs.existsSync(path.join(root,'.agent-dispatch')),false);
  fs.writeFileSync(nativeCli,'// old CLI');await assert.rejects(check(raw),/context-profile stock/);
  assert.equal(fs.existsSync(path.join(root,'.agent-dispatch')),false);
});
test('CLI context-profile validation is ZCode-only and happens before any worker launch',t=>{
  const root=make(t),brief=path.join(root,'brief.md');fs.writeFileSync(brief,'Local fixture.');
  const args=['check','--stage','discovery','--project',root,'--brief',brief,'--notify','none','--context-profile'];
  const invalid=cli([...args,'not-a-profile']);assert.equal(invalid.envelope.error.code,'INVALID_CONFIG');assert.match(invalid.envelope.error.message,/context profile/);
  const other=cli([...args,'files','--worker','agy']);assert.equal(other.envelope.error.code,'INVALID_CONFIG');assert.match(other.envelope.error.message,/ZCode-only/);
  assert.equal(fs.existsSync(path.join(root,'.agent-dispatch')),false);
});
test('warning-prefixed final result is readable; failure and cancellation remain failures',t=>{
  const runDir=make(t),config={runDir,workerKind:'zcode'};
  for(const [envelope,status] of [[{sessionId:'sess_ok',response:'Done'},'ready_for_review'],[{response:'Partial',cancelled:true},'cancelled'],[{response:'Partial',error:{code:'1308',message:'quota exceeded'}},'blocked']]){
    fs.writeFileSync(path.join(runDir,'result.json'),'AI SDK Warning System: To turn off warning logging, set the AI_SDK_LOG_WARNINGS global to false.\n'+JSON.stringify(envelope));
    assert.equal(finishResult(config,{exitCode:0}).status,status);
  }
  fs.unlinkSync(path.join(runDir,'worker-report.md'));
  fs.writeFileSync(path.join(runDir,'result.json'),'arbitrary log\n{"response":"not a valid envelope"}');
  assert.equal(finishResult(config,{exitCode:0}).status,'missing_report');
});
test('invalid installed runtime fails preflight without creating worker state',async t=>{
  const root=make(t),promptFile=path.join(root,'brief.md');fs.writeFileSync(promptFile,'Local fixture.');
  const config=validateConfig({project:root,promptFile,notify:false,nativeCli:path.join(root,'missing.cjs')});
  assert.throws(()=>verifyNative(config),/missing/);await assert.rejects(launch(config),/missing/);
  assert.equal(fs.existsSync(config.runDir),false);
});
test('short AGY check command is read-only and preserves worker routing',t=>{
  const root=make(t),promptFile=path.join(root,'brief.md');fs.writeFileSync(promptFile,'Local fixture.');
  const result=cli(['check','--worker','agy','--stage','discovery','--project',root,'--brief',promptFile,'--notify','none']);
  assert.equal(result.status,0,result.stdout+result.stderr);const data=result.envelope.data;assert.equal(data.stage,'discovery');assert.equal(data.worker,'agy');assert.equal(data.startsWorker,false);
  assert.equal(fs.existsSync(path.join(root,'.agent-dispatch')),false);
});
