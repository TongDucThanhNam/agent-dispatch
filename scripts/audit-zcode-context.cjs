const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
process.setUncaughtExceptionCaptureCallback(error => { console.error(error.stack); process.exitCode = 1; });
const file = path.join(process.env.ZCODE_INSTALL_DIR || 'C:/Program Files/ZCode', 'resources/glm/zcode.cjs');
const outputDir = path.resolve(process.env.ZCODE_CONTEXT_AUDIT_OUT || '.tmp/zcode-context-audit-0.17.1');
let source = fs.readFileSync(file, 'utf8');
const hash = crypto.createHash('sha256').update(source).digest('hex');
if (hash !== 'd9afd58d694f98a5279bf548cdc7646413c125762e86730605a6071f9e0346d6') throw Error('Audit targets ZCode 0.17.1 only');
const marker = 'ttt();NPc();async function NPc()';
if (source.split(marker).length !== 2) throw Error('Unknown entrypoint');
source = source.replace(marker, 'ttt();async function NPc()');
source += '\nYDn();U1n();E$o();module.exports={context:ZDn,register:gae,registry:gyt,project:rIo,entries:SDn,estimate:ef,getTools:z$o};';
// This process only renders local contracts. Never send a model/network request.
globalThis.fetch = () => { throw Error('Network disabled in offline audit'); };
const mod = new Module(file, module);
mod.filename = file;
mod.paths = Module._nodeModulePaths(path.dirname(file));
mod._compile(source, file);
const api = mod.exports;
if (require.main !== module) { module.exports = api; return; }
fs.mkdirSync(outputDir, {recursive:true});
const base = { includeSkill:false, includeAgent:true, includeSendMessage:true, embeddedSearchEnabled:true, includeDynamicWorkflow:false };
const protocolTools = new Set(['RespondToCoordinator','submit_result','escalate']);
const deniedExcept = names => api.entries.map(t=>t.metadata.name).filter(name=>!names.includes(name)&&!protocolTools.has(name));
const fileTools = ['Read','Write','Edit','Bash','TaskOutput','TaskStop'];
const modes = {
  baseline: base,
  workerWeb: {...base, disallowedTools:deniedExcept([...fileTools,'WebFetch','WebSearch'])},
  workerFiles: {...base, disallowedTools:deniedExcept(fileTools)},
  workerShell: {...base, disallowedTools:deniedExcept(['Bash','TaskOutput','TaskStop'])},
  allOptional: {...base, includeSkill:true, includeWorkflow:true, includeAutomation:true, includeOffPeak:true, includeNodeRepl:true, includeBrowserUse:true, includeDynamicWorkflow:true},
};
const model = {id:'audit-model',properties:{supportsToolCall:true,supportsNativeWebSearch:true,inputFormat:{supportsText:true,supportsImage:true,supportsPdf:false,supportsVideo:false,supportsAudio:false}}};
const report = {auditedAt:new Date().toISOString(),version:'0.17.1',bundleSha256:hash,modelProbe:model,method:'Offline native registry + production getTools(model) + context builder with synthetic model/environment; not a billed request or live Desktop export',tokenCountKind:'Native weighted-character heuristic only, not tokenizer or billed usage',checks:['retained provider contracts identical','retained metadata and tool function source identical'],scenarios:{}};
let baselineTools, baselineRegistry;
for (const [name,options] of Object.entries(modes)) {
  const registry = api.registry();api.register(registry, options);
  const state = {registry,cachedTools:null,config:{toolSearch:{mode:'off'},toolAllowlist:options.allowedTools,toolDisallowlist:options.disallowedTools}};
  const tools = api.getTools.call(state, model);
  if (name==='baseline') { baselineTools=tools; baselineRegistry=registry; }
  if (name.startsWith('worker')) {
    assert.deepEqual(tools.map(t=>t.name).sort(),baselineTools.map(t=>t.name).filter(n=>!options.disallowedTools.includes(n)).sort());
    for(const tool of tools) {
      assert.deepEqual(tool,baselineTools.find(t=>t.name===tool.name),'kept contract unchanged: '+tool.name);
      const before=baselineRegistry.get(tool.name),after=registry.get(tool.name);
      assert.deepEqual(after.metadata,before.metadata,'kept metadata unchanged: '+tool.name);
      for(const [key,value] of Object.entries(before)) if(typeof value==='function') assert.equal(after[key].toString(),value.toString(),'kept function unchanged: '+tool.name+'.'+key);
    }
  }
  const env = {currentDate:'2026-11-12',envInfo:{cwd:'C:/audit/workspace',platform:'win32',shell:'powershell',osVersion:'Windows',isGitRepository:true},guidanceToolNames:tools.map(t=>t.name)};
  const context = api.context(env).build();
  const desktop = api.context({...env,presentationSurface:'zcode_desktop',genUiOutputDirectory:'C:/audit/session-genui'}).build();
  const full = JSON.stringify(tools.map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema})));
  const stats = {options,toolNames:tools.map(t=>t.name),tools:tools.map(t=>({name:t.name,descriptionChars:t.description.length,schemaChars:JSON.stringify(t.inputSchema).length})),toolChars:full.length,systemChars:context.systemMessages.reduce((n,m)=>n+m.content.length,0),nativeEstimatedAllSectionTokens:context.totalTokens,sections:context.sections.map(({content,preview,...s})=>s),desktopSystemChars:desktop.systemMessages.reduce((n,m)=>n+m.content.length,0),desktopSections:desktop.sections.map(({content,preview,...s})=>s)};
  report.scenarios[name] = stats;
  fs.writeFileSync(path.join(outputDir,name+'-tools.json'),JSON.stringify(tools,null,2)+'\n');
  fs.writeFileSync(path.join(outputDir,name+'-prompt.md'),context.sections.map(s=>`<!-- ${s.source} | ${s.injectionTarget} -->\n${s.content}`).join('\n\n')+'\n');
  fs.writeFileSync(path.join(outputDir,name+'-desktop-prompt.md'),desktop.sections.map(s=>`<!-- ${s.source} | ${s.injectionTarget} -->\n${s.content}`).join('\n\n')+'\n');
  console.log(JSON.stringify({name,toolCount:tools.length,toolNames:stats.toolNames,toolChars:stats.toolChars,systemChars:stats.systemChars,metaUserChars:context.sections.filter(s=>s.injectionTarget==='meta_user').reduce((n,s)=>n+s.chars,0),desktopSystemChars:stats.desktopSystemChars}));
}
fs.writeFileSync(path.join(outputDir,'report.json'),JSON.stringify(report,null,2)+'\n');
