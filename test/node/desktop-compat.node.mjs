// Runs under Node (not Bun): assets/node/*.mjs are Node loaders that use node:module registerHooks.
// Invoked by test/desktop-compat.test.ts through `node --test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {desktopCredentialAliases, patchNativeModelList} from '../../assets/node/desktop-compat.mjs';

test('desktop identity aliases require the matching saved account key and preserve native login',()=>{
 const provider='account:zai-individual-coding-plan';
 const pointer=`account-provider:${provider}:identity`;
 const key=`account-provider:coding-plan:${provider}:account:user%2Fone:api-key`;
 const saved={'oauth:zai:user_info':JSON.stringify({user_id:'user/one'}),[key]:'encrypted-existing-key'};
 const result=desktopCredentialAliases(saved,x=>x);
 assert.equal(result[pointer],'user/one');assert.equal(saved[pointer],undefined);assert.equal(result[key],saved[key]);
 assert.equal(desktopCredentialAliases({'oauth:zai:user_info':saved['oauth:zai:user_info']},x=>x)[pointer],undefined);
 assert.equal(desktopCredentialAliases({...saved,[pointer]:'explicit-native-user'},x=>x)[pointer],'explicit-native-user');
 assert.deepEqual(desktopCredentialAliases({'oauth:zai:user_info':'corrupt'},()=>{throw Error('bad cipher');}),{'oauth:zai:user_info':'corrupt'});
});

test('native formatter reads new ref catalog and retains old IDs with a version guard',()=>{
 const source='const version="0.16.9";function LXa(e,t){return t.map(x=>x.id)};LXa(null,input)';
 const result=vm.runInNewContext(patchNativeModelList(source),{input:[{ref:{providerId:'account:zai',modelId:'GLM'}},{id:'custom/model'}]});
 assert.deepEqual(Array.from(result),['account:zai/GLM','custom/model']);
 assert.equal(patchNativeModelList(source.replace('0.16.9','0.17.0')),source.replace('0.16.9','0.17.0'));
});
