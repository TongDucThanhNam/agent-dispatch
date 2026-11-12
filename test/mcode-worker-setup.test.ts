import {test, expect} from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {asset} from '../src/core/paths.ts';
import {mcodeClient, MCODE_API} from '../src/workers/mcode/desktop.ts';
import {setupMcodeWorker, MCODE_WORKER_AGENT, MCODE_WORKER_PROFILE_DESKTOP} from '../src/workers/mcode/worker-profile.ts';

const profile = fs.readFileSync(asset('agents', 'mcode-worker', 'agent.md'), 'utf8');
function fixture(content?: string) {
  const calls: any[] = [];
  let current: any = content === undefined ? null : document(content);
  const runtime: any = {bridge: {version: MCODE_WORKER_PROFILE_DESKTOP}, agents: current ? [{name: MCODE_WORKER_AGENT}] : [],
    client: {request: async (route: string, options: any = {}) => {
      calls.push({route, ...options});
      if (route.endsWith('/config/get')) return {config: structuredClone(current)};
      if (route === MCODE_API + '/agent') { current = document('native initial configuration'); return {agent: {name: MCODE_WORKER_AGENT}}; }
      if (route.endsWith('/config') && options.method === 'PUT') {
        expect(options.body.expected_revision).toBe(current.revision);
        expect(options.body.expected_owner_instance_id).toBe(current.owner_instance_id);
        current = {...current, content: options.body.content, revision: 'next'}; return {config: current};
      }
      throw Error('Unexpected native mutation');
    }}};
  return {runtime, calls, deps: {probe: async () => runtime}};
}
const document = (content: string) => ({exact_owner_name: MCODE_WORKER_AGENT, owner_kind: 'custom',
  owner_instance_id: 'instance-1', revision: 'revision-1', content, diagnostics: []});

test('MCode worker dry run creates nothing and unsupported versions fail before native mutation', async () => {
  const f = fixture();
  expect((await setupMcodeWorker({dryRun: true}, f.deps)).action).toBe('would-create');
  expect(f.calls).toEqual([]);
  f.runtime.bridge.version = '99.0.0';
  await expect(setupMcodeWorker({}, f.deps)).rejects.toThrow('Audit this version first');
  expect(f.calls).toEqual([]);
});

test('MCode setup creates only the separate Custom Agent, uses native revision guards, and verifies readback', async () => {
  const f = fixture();
  expect((await setupMcodeWorker({}, f.deps)).action).toBe('created');
  expect(f.calls.filter(c => c.route === MCODE_API + '/agent')).toHaveLength(1);
  expect(f.calls.filter(c => c.method === 'PUT')).toHaveLength(1);
  expect(f.calls.every(c => c.body.name === MCODE_WORKER_AGENT)).toBe(true);
  expect(f.calls.find(c => c.method === 'PUT').body.content).toBe(profile);
  expect(f.calls.some(c => /\/session|\/message|\/model-providers/.test(c.route))).toBe(false);
});

test('MCode setup is idempotent, refuses a conflicting agent, and force backs up its exact prior content', async () => {
  const same = fixture(profile.replace(/\n/g, '\r\n'));
  expect((await setupMcodeWorker({}, same.deps)).action).toBe('unchanged');
  expect(same.calls.some(c => c.method === 'PUT')).toBe(false);
  const conflict = fixture('user-owned profile\n');
  await expect(setupMcodeWorker({}, conflict.deps)).rejects.toThrow('different dispatch-worker');
  expect(conflict.calls.some(c => c.method === 'PUT')).toBe(false);
  const replaced = await setupMcodeWorker({force: true}, conflict.deps);
  expect(replaced.action).toBe('replaced');
  expect(fs.readFileSync(replaced.backup!, 'utf8')).toBe('user-owned profile\n');
});

test('MCode setup will not treat a builtin owner as the custom worker or conceal a failed readback', async () => {
  const wrong = fixture('different');
  wrong.runtime.client.request = async () => ({config: {...document('different'), owner_kind: 'builtin'}});
  await expect(setupMcodeWorker({force: true}, wrong.deps)).rejects.toThrow('does not identify a native Custom Agent');
  const stale = fixture();
  const request = stale.runtime.client.request;
  stale.runtime.client.request = async (route: string, options: any) => {
    if (options?.method === 'PUT') return {};
    return request(route, options);
  };
  await expect(setupMcodeWorker({}, stale.deps)).rejects.toThrow('readback did not match');
});

test('MiniMax client preserves PUT/body and token isolation for supported native configuration routes', async () => {
  let seen: any;
  const fetchMock = (async (url: any, options: any) => {
    seen = {url, options}; return Response.json({config: {}});
  }) as typeof fetch;
  const client = mcodeClient({origin: 'http://127.0.0.1:1234', token: 'private-test-token'}, fetchMock);
  await client.request(MCODE_API + '/agent/config', {method: 'PUT', body: {name: MCODE_WORKER_AGENT}});
  expect(seen.options.method).toBe('PUT');
  expect(JSON.parse(seen.options.body)).toEqual({name: MCODE_WORKER_AGENT});
  expect(seen.options.redirect).toBe('error');
  expect(seen.options.headers['x-mavis-runtime-token']).toBe('private-test-token');
  expect(seen.url).not.toContain('private-test-token');
});
