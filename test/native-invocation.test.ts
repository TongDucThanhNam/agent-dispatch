// @ts-nocheck: ported from the JavaScript suite; it drives loosely typed internals with partial fixtures. Runtime-checked by bun test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {modelCatalog, nativeSelection, buildNativeInvocation, verifyNative} from '../src/index.ts';
import {validateConfig, finishResult, launch} from '../src/index.ts';
import { nodeExecutable } from '../src/index.ts';
import { cli, rmTree } from './helpers.ts';
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
  assert.equal(fs.existsSync(path.join(root,'.zcode-dispatch')),false);
});
