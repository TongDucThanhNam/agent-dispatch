// Process-local selection for native ZCode 0.16.9. No shared config writes.
import './desktop-compat.mjs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';
const normalize = file => {
  if (typeof file !== 'string' && !(file instanceof URL)) return null;
  const value = path.resolve(file instanceof URL ? fileURLToPath(file) : file);
  return process.platform === 'win32' ? value.toLowerCase() : value;
};
export function configOverlay(selection, originalRead = fs.readFileSync) {
  const original = JSON.parse(originalRead(selection.configPath, 'utf8').replace(/^\uFEFF/, ''));
  const userPaths = new Set([normalize(selection.configPath), normalize(path.join(os.homedir(), '.zcode/cli/config.json'))]);
  const projectPaths = new Set();
  for (let dir = path.resolve(selection.project);;) {
    for (const name of ['zcode.json', '.zcode/config.json']) projectPaths.add(normalize(path.join(dir, name)));
    const parent = path.dirname(dir); if (parent === dir) break; dir = parent;
  }
  return (file, options) => {
    const target = normalize(file);
    let value;
    if (userPaths.has(target)) value = structuredClone(original);
    else if (projectPaths.has(target)) value = JSON.parse(originalRead(file, 'utf8').replace(/^\uFEFF/, ''));
    else if (target === normalize(selection.personalConfig)) {
      value = fs.existsSync(file) ? JSON.parse(originalRead(file, 'utf8').replace(/^\uFEFF/, '')) :
        {schemaVersion: 1, config: {providerOrder: [], providerConfigRules: {providerRules: []}, modelConfigRules: {providerModelRules: [], manualProviderModelRules: []}}};
      value.config.defaultModelSelection = {providerId: selection.provider, modelId: selection.model,
        ...(selection.effort != null ? {options: {reasoningLevel: selection.effort}} : {})};
      if (selection.effort != null) {
      const rules = value.config.modelConfigRules;
      let rule = [...rules.providerModelRules, ...rules.manualProviderModelRules].find(r => r.providerId === selection.provider && r.modelId === selection.model);
      if (!rule) {rule = {providerId: selection.provider, modelId: selection.model, config: {}}; rules.providerModelRules.push(rule);}
      rule.config.optionSpecs = {...rule.config.optionSpecs, reasoningLevel: {...rule.config.optionSpecs?.reasoningLevel, values: [selection.effort]}};
      }
    } else return null;
    if (userPaths.has(target) || projectPaths.has(target)) {
      const selected = `${selection.provider}/${selection.model}`;
      value.model = typeof value.model === 'object' && value.model !== null ? {...value.model, main: selected} : selected;
    }
    const bytes = Buffer.from(JSON.stringify(value));
    const encoding = typeof options === 'string' ? options : options?.encoding;
    return encoding ? bytes.toString(encoding) : bytes;
  };
}
if (path.basename(process.argv[1] ?? '').toLowerCase() === 'zcode.cjs' && process.env.ZCODE_DIRECT_SELECTION) {
  const selection = JSON.parse(process.env.ZCODE_DIRECT_SELECTION);
  delete process.env.ZCODE_DIRECT_SELECTION;
  process.env.NODE_OPTIONS = (process.env.NODE_OPTIONS ?? '').split(' ').filter(v => v !== `--import=${import.meta.url}`).join(' ');
  const readSync = fs.readFileSync, readPromise = fsp.readFile;
  const overlay = configOverlay(selection, readSync);
  // 0.16.9 normalizes/writes provider settings while loading. Point it at a
  // private temporary copy, so the per-run effort cannot alter shared settings.
  const shadow = process.env.ZCODE_DIRECT_PROVIDER_SHADOW;
  delete process.env.ZCODE_DIRECT_PROVIDER_SHADOW;
  if (!shadow || path.dirname(path.resolve(shadow)) !== path.resolve(os.tmpdir()) || !/^zcode-direct-provider-[a-f0-9-]+\.json$/.test(path.basename(shadow))) throw Error('Invalid private provider runtime path.');
  const personal = overlay(selection.personalConfig, 'utf8') ??
    (fs.existsSync(selection.personalConfig) ? readSync(selection.personalConfig, 'utf8') :
      JSON.stringify({schemaVersion:1,config:{providerOrder:[],providerConfigRules:{providerRules:[]},modelConfigRules:{providerModelRules:[],manualProviderModelRules:[]}}}));
  fs.writeFileSync(shadow, personal, {mode: 0o600, flag: 'wx'});
  process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = shadow;
  process.on('exit', () => {try {fs.unlinkSync(shadow);} catch {}});
  fs.readFileSync = (file, options) => overlay(file, options) ?? readSync(file, options);
  fsp.readFile = async (file, options) => overlay(file, options) ?? readPromise(file, options);
  syncBuiltinESMExports();
}
