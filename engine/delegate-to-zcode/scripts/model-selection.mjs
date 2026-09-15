import fs from 'node:fs';

const record = value => value && typeof value === 'object' && !Array.isArray(value);
const validProvider = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,100}$/.test(value);
const validModel = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,100}$/.test(value);

export function readModelCatalog(configPath) {
  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  if (!record(saved)) throw new Error('ZCode configuration must be an object.');
  const models = [];
  for (const [provider, entry] of Object.entries(record(saved.provider) ? saved.provider : {})) {
    if (!validProvider(provider) || !record(entry) || !record(entry.models)) continue;
    for (const model of Object.keys(entry.models)) {
      if (validModel(model)) models.push({ id: `${provider}/${model}`, provider, model });
    }
  }
  // Return identifiers only. Provider options may contain credentials.
  return models;
}

export function resolveZCodeSelection(raw, configPath) {
  let model, provider;
  if (raw.model !== undefined) {
    if (typeof raw.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9:._/-]{0,202}$/.test(raw.model)) throw new Error('Invalid model. Use a model ID or provider/model.');
    const slash = raw.model.indexOf('/');
    if (slash >= 0) {
      provider = raw.model.slice(0, slash); model = raw.model.slice(slash + 1);
      if (raw.provider !== undefined && raw.provider !== provider) throw new Error('The provider conflicts with the qualified model ID.');
    } else {
      model = raw.model; provider = raw.provider;
      if (provider === undefined) {
        const matches = readModelCatalog(configPath).filter(item => item.model === model);
        if (matches.length === 0) throw new Error(`Model ${model} is not configured in ZCode. Run models to inspect configured IDs.`);
        if (matches.length > 1) throw new Error(`Model ${model} exists in multiple providers. Use one full ID: ${matches.map(item => item.id).join(', ')}`);
        provider = matches[0].provider;
      }
    }
  } else {
    // Existing run records remain pinned even when another project changes the shared default.
    model = raw.expectedModel ?? 'GLM-5.3-Flash';
    provider = raw.provider ?? raw.expectedProvider ?? 'builtin:zai-coding-plan';
  }
  if (!validProvider(provider) || !validModel(model)) throw new Error('Invalid ZCode provider/model selection.');
  return { expectedModel: model, expectedProvider: provider };
}

export function verifyConfiguredModel(config) {
  const id = `${config.expectedProvider}/${config.expectedModel}`;
  if (!readModelCatalog(config.cliConfig).some(item => item.id === id)) {
    throw new Error(`Requested ZCode model ${id} is no longer configured. Run models to inspect available IDs; no worker was launched.`);
  }
}

export function resolveZCodeEffort(raw, model) {
  const supplied = Object.hasOwn(raw, 'zcodeEffort') ? raw.zcodeEffort : raw.effort;
  const flash = model.toLowerCase() === 'glm-5.3-flash';
  // Saved configs predating effort selection keep the native CLI's old behavior.
  const effort = supplied === undefined ? (flash && !raw.schemaVersion && !raw.resumeSessionId ? 'max' : null) : supplied;
  if (effort !== null && !['low', 'high', 'max'].includes(effort)) throw new Error('Invalid ZCode effort. Use low, high, max, or null to inherit.');
  if (effort !== null && !flash) throw new Error('ZCode effort overrides currently support GLM-5.3-Flash only.');
  return effort;
}

export function buildZCodeInvocation(config, prompt, inheritedEnv = process.env) {
  // Native 0.16.5's ZCODE_MODEL creates an incomplete Anthropic target and loses
  // the provider credentials. Select through its full file-config parser instead.
  const env = Object.fromEntries(Object.entries(inheritedEnv).filter(([key]) => !['ZCODE_MODEL', 'ZCODE_DELEGATE_SELECTION', 'NODE_OPTIONS'].includes(key.toUpperCase())));
  env.ZCODE_MODEL = ''; // Prevent dotenv from restoring an incomplete target.
  const loader = new URL('./model-config-loader.mjs', import.meta.url).href;
  const nodeOptions = Object.entries(inheritedEnv).find(([key]) => key.toUpperCase() === 'NODE_OPTIONS')?.[1];
  env.NODE_OPTIONS = [nodeOptions, `--import=${loader}`].filter(Boolean).join(' ');
  env.ZCODE_DELEGATE_SELECTION = JSON.stringify({configPath: config.cliConfig, project: config.project, provider: config.expectedProvider, model: config.expectedModel, effort: config.zcodeEffort ?? null});
  const args = [config.adapter, 'native', '--cwd', config.project, '--prompt', prompt, '--mode', config.mode, '--json'];
  if (config.resumeSessionId) args.push('--resume', config.resumeSessionId);
  return { args, env };
}

export function nextRunConfig(previous, status, { promptFile, model, provider, effort } = {}) {
  if (!status.workerExited || !status.sessionId) throw new Error('Cannot resume until the old worker has exited and its actual session ID is known.');
  if ((previous.workerKind ?? 'zcode') !== 'zcode' && (model !== undefined || provider !== undefined || effort !== undefined)) {
    throw new Error('These model override flags apply to ZCode runs only.');
  }
  if (provider !== undefined && model === undefined) throw new Error('Supply --model together with --provider for an explicit switch.');
  // A config saved before reviewMode existed must keep its main-review behavior;
  // resuming an old run never silently activates the script-managed review loop.
  const next = { ...previous, reviewMode: previous.reviewMode ?? 'main-review', runId: undefined, runDir: undefined, promptFile, stageId: undefined, freshWorker: false, strategyChange: null, blockerResolved: null, resumeSessionId: status.sessionId };
  if ((previous.workerKind ?? 'zcode') === 'zcode') next.zcodeEffort = previous.zcodeEffort ?? previous.effort ?? null;
  if (model !== undefined) {
    next.model = model;
    if (provider !== undefined) next.provider = provider;
    else delete next.provider;
    if (model.split('/').at(-1) !== previous.expectedModel) next.zcodeEffort = null;
  }
  if (effort !== undefined) next.zcodeEffort = effort;
  return next;
}
