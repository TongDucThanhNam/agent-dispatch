import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { asset, nodeExecutable } from '../../core/paths.ts';

export function nativePaths(raw: any = {}) {
  const install = raw.zcodeInstallDir ?? process.env.ZCODE_INSTALL_DIR ?? 'C:/Program Files/ZCode';
  return {
    nativeCli: path.resolve(raw.nativeCli ?? path.join(install, 'resources/glm/zcode.cjs')),
    builtinConfig: path.resolve(raw.builtinConfig ?? path.join(install, 'resources/config/provider/zcode-builtin.json')),
    personalConfig: path.resolve(raw.personalConfig ?? path.join(os.homedir(), '.zcode/v2/provider_config.json')),
  };
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
export function modelCatalog(config) {
  const builtin = read(config.builtinConfig).config;
  const personal = fs.existsSync(config.personalConfig) ? read(config.personalConfig).config : {};
  const templates = new Map<any, any>((builtin.providerConfigRules?.templateRules ?? []).map(r => [r.templateId, r.config]));
  const providers = new Map<any, any>();
  for (const rule of [...(builtin.providerConfigRules?.providerRules ?? []), ...(personal.providerConfigRules?.providerRules ?? [])]) {
    const previous: any = providers.get(rule.providerId) ?? {};
    providers.set(rule.providerId, {...previous, ...rule, config: {...previous.config, ...templates.get(rule.templateId), ...rule.config}});
  }
  return [...providers.values()].filter(p => p.enabled !== false).flatMap(p =>
    [...new Set([...(p.config.builtinModelIds ?? []), ...(p.config.personalModelIds ?? [])])]
      .map(model => ({id: `${p.providerId}/${model}`, provider: p.providerId, model})));
}
export function nativeSelection(raw) {
  let provider = raw.expectedProvider ?? 'account:zai-individual-coding-plan';
  let model = raw.expectedModel ?? 'GLM-5.3-Flash';
  if (raw.model != null) {
    const slash = raw.model.indexOf('/');
    if (slash < 1) throw Error('Use a qualified ZCode provider/model ID from models.');
    provider = raw.model.slice(0, slash); model = raw.model.slice(slash + 1);
  }
  // Same account product under the updated native provider registry.
  if (provider === 'builtin:zai-coding-plan') provider = 'account:zai-individual-coding-plan';
  const effort = raw.zcodeEffort !== undefined ? raw.zcodeEffort : raw.effort !== undefined ? raw.effort : /glm-5\.3(?:-flash)?/i.test(model) ? 'max' : null;
  if (effort !== null && !['low', 'high', 'max'].includes(effort)) throw Error('ZCode effort must be low, high, max or null.');
  return {expectedProvider: provider, expectedModel: model, zcodeEffort: effort};
}
export function verifyNative(config) {
  for (const file of [config.nativeCli, config.builtinConfig, config.cliConfig]) if (!fs.existsSync(file)) throw Error(`ZCode runtime file is missing: ${file}`);
  if (!modelCatalog(config).some(m => m.provider === config.expectedProvider && m.model === config.expectedModel))
    throw Error('Requested ZCode provider/model is unavailable in the current provider registry. Run models; no worker started.');
}
export function buildNativeInvocation(config, prompt, inherited = process.env) {
  const env = {...inherited};
  delete env.ZCODE_MODEL;
  env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = config.builtinConfig;
  env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE = config.personalConfig;
  env.ZCODE_SESSION_DB_PATH = config.dbPath;
  const cleanupPath = path.join(os.tmpdir(), `zcode-direct-provider-${crypto.randomUUID()}.json`);
  env.ZCODE_DIRECT_PROVIDER_SHADOW = cleanupPath;
  const loader = pathToFileURL(asset('node', 'native-config-loader.mjs')).href;
  env.NODE_OPTIONS = [env.NODE_OPTIONS, `--import=${loader}`].filter(Boolean).join(' ');
  env.ZCODE_DIRECT_SELECTION = JSON.stringify({configPath: config.cliConfig, personalConfig: config.personalConfig,
    project: config.project, provider: config.expectedProvider, model: config.expectedModel, effort: config.zcodeEffort});
  const args = [config.nativeCli, '--cwd', config.project, '--prompt', prompt, '--mode', config.mode, '--json'];
  if (config.resumeSessionId) args.push('--resume', config.resumeSessionId);
  return {command: config.nodeExe ?? nodeExecutable(), args, env, cleanupPath};
}
