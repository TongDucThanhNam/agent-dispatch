// Process-local compatibility for native ZCode 0.16.5, whose ZCODE_MODEL
// parser discards provider settings and whose advertised --settings is absent.
// Overlay config reads in the native CLI only; never write config or credentials.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {syncBuiltinESMExports} from 'node:module';

const normalize = value => {
  const resolved = path.resolve(value instanceof URL ? fileURLToPath(value) : String(value));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};
const record = value => value && typeof value === 'object' && !Array.isArray(value);

export function createModelConfigOverlay({configPath, project, provider, model, effort = null}, read = fs.readFileSync) {
  const original = JSON.parse(read(configPath, 'utf8').replace(/^\uFEFF/, ''));
  let entry = original.provider?.[provider];
  if (!record(entry) || !record(entry.models) || !Object.hasOwn(entry.models, model)) {
    throw new Error('The assigned ZCode provider/model is no longer configured.');
  }
  let reasoning;
  if (effort !== null) {
    if (model.toLowerCase() !== 'glm-5.3-flash' || !['low', 'high', 'max'].includes(effort)) throw new Error('Unsupported ZCode model/effort override.');
    const options = entry.kind === 'anthropic'
      ? {anthropic: {effort, thinking: {type: 'enabled', budgetTokens: 1024}}}
      : entry.kind === 'openai-compatible'
        ? {openaiCompatible: {reasoningEffort: effort, thinking: {type: 'enabled'}}}
        : null;
    if (!options) throw new Error('ZCode effort selection requires an anthropic or openai-compatible provider.');
    // A single process-local level prevents the CLI's persisted global reasoning
    // preference from overriding this run. No shared preference is rewritten.
    reasoning = {enabled: true, levels: [effort], defaultLevel: effort, providerOptionsByLevel: {[effort]: options}};
    entry = {...entry, models: {...entry.models, [model]: {...entry.models[model], reasoning}}};
  }
  const userPaths = new Set([normalize(configPath), normalize(path.join(os.homedir(), '.zcode/cli/config.json'))]);
  const projectPaths = new Set();
  for (let directory = path.resolve(project);;) {
    for (const relative of ['zcode.json', '.zcode/config.json']) projectPaths.add(normalize(path.join(directory, relative)));
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const select = config => ({...config,
    model: record(config.model) ? {...config.model, main: `${provider}/${model}`} : `${provider}/${model}`,
    provider: {...config.provider, [provider]: entry},
    ...(reasoning ? {modelCatalog: {...config.modelCatalog, overrides: {...config.modelCatalog?.overrides,
      [`${provider}/${model}`]: {...config.modelCatalog?.overrides?.[`${provider}/${model}`], supportsReasoning: true, reasoning}}}} : {})
  });
  return function readConfig(file, options) {
    if (typeof file !== 'string' && !(file instanceof URL)) return read(file, options);
    const target = normalize(file);
    if (!userPaths.has(target) && !projectPaths.has(target)) return read(file, options);
    const text = userPaths.has(target) ? JSON.stringify(select(original)) : read(file, 'utf8');
    let output = text;
    if (!userPaths.has(target)) {
      const config = JSON.parse(text.replace(/^\uFEFF/, ''));
      if (record(config) && (reasoning || Object.hasOwn(config, 'model'))) output = JSON.stringify(select(config));
    }
    const encoding = typeof options === 'string' ? options : options?.encoding;
    return encoding ? Buffer.from(output).toString(encoding) : Buffer.from(output);
  };
}

// NODE_OPTIONS reaches the adapter's native child. Do not affect the adapter,
// supervisors, MCP servers or user tools. Native subagents inherit resolved settings.
if (path.basename(process.argv[1] ?? '').toLowerCase() === 'zcode.cjs' && process.env.ZCODE_DELEGATE_SELECTION) {
  const selection = JSON.parse(process.env.ZCODE_DELEGATE_SELECTION);
  const importOption = `--import=${import.meta.url}`;
  delete process.env.ZCODE_DELEGATE_SELECTION;
  if (process.env.NODE_OPTIONS) process.env.NODE_OPTIONS = process.env.NODE_OPTIONS.split(' ').filter(item => item !== importOption).join(' ');
  process.env.ZCODE_MODEL = '';
  fs.readFileSync = createModelConfigOverlay(selection);
  syncBuiltinESMExports();
}
