import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {asset} from '../../core/paths.ts';
import {MCODE_API, mcodePaths, probeMcode} from './desktop.ts';

export const MCODE_WORKER_AGENT = 'dispatch-worker';
export const MCODE_WORKER_PROFILE_DESKTOP = '3.1.14';
const normalized = (text: string) => text.replace(/\r\n/g, '\n').replace(/\n+$/, '');

/** Install a separate native Custom Agent; never replace the Desktop's primary/built-in agents. */
export async function setupMcodeWorker(raw: any = {}, deps: any = {}) {
  const runtime = await (deps.probe ?? probeMcode)(mcodePaths(raw));
  if (runtime.bridge.version !== MCODE_WORKER_PROFILE_DESKTOP)
    throw Error(`MCode worker profile was audited for Desktop ${MCODE_WORKER_PROFILE_DESKTOP}, not ${runtime.bridge.version}. Audit this version first; no agent changed.`);
  const content = fs.readFileSync(asset('agents', 'mcode-worker', 'agent.md'), 'utf8');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content);
  if (!match || !/^name: dispatch-worker\r?$/m.test(match[1])) throw Error('Invalid packaged MCode worker profile.');
  const existed = runtime.agents.some((agent: any) => agent.name === MCODE_WORKER_AGENT);
  const read = async () => (await runtime.client.request(MCODE_API + '/agent/config/get', {body: {name: MCODE_WORKER_AGENT}})).config;
  let current = existed ? await read() : null;
  if (current && (current.exact_owner_name !== MCODE_WORKER_AGENT || current.owner_kind !== 'custom'))
    throw Error('The worker name does not identify a native Custom Agent; no configuration changed.');
  const same = current && normalized(current.content) === normalized(content);
  if (same) return {agent: MCODE_WORKER_AGENT, version: runtime.bridge.version, action: 'unchanged'};
  if (existed && !raw.force) throw Error('A different dispatch-worker already exists. Back it up or explicitly use --force; no configuration changed.');
  if (raw.dryRun) return {agent: MCODE_WORKER_AGENT, version: runtime.bridge.version, action: existed ? 'would-replace' : 'would-create'};
  let backup: string | undefined;
  if (existed) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcode-worker-backup-'));
    backup = path.join(dir, 'agent.md'); fs.writeFileSync(backup, current.content, {flag: 'wx', mode: 0o600});
  } else {
    // Native create only materializes the owner/assets; it does not send a model prompt.
    await runtime.client.request(MCODE_API + '/agent', {body: {name: MCODE_WORKER_AGENT,
      display_name: 'Dispatch Worker', description: 'Minimal coding worker for agent-dispatch', system_prompt: match[2].trim()}});
    current = await read();
  }
  if (current?.exact_owner_name !== MCODE_WORKER_AGENT || current?.owner_kind !== 'custom' ||
      !current.owner_instance_id || !current.revision)
    throw Error('Unsupported Custom Agent configuration contract. Default worker remains unchanged; inspect dispatch-worker before retrying.');
  await runtime.client.request(MCODE_API + '/agent/config', {method: 'PUT', body: {
    name: MCODE_WORKER_AGENT, content, expected_revision: current.revision, expected_owner_instance_id: current.owner_instance_id,
  }});
  const saved = await read();
  if (saved.owner_instance_id !== current.owner_instance_id || normalized(saved.content) !== normalized(content) || saved.diagnostics?.length)
    throw Error('Native Custom Agent readback did not match the requested profile. Default worker remains unchanged; inspect dispatch-worker.');
  return {agent: MCODE_WORKER_AGENT, version: runtime.bridge.version, action: existed ? 'replaced' : 'created', ...(backup ? {backup} : {})};
}
